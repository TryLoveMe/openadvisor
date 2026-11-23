import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/index.ts";
import { readConfig, resolveModel, saveConfig, serializeTranscript } from "../extensions/core.ts";

const model = { provider: "test", id: "strong", maxTokens: 8192 };

function harness(flag?: string) {
  const directory = mkdtempSync(join(tmpdir(), "pi-advisor-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  const hooks: Record<string, Function> = {};
  let command: any;
  let tool: any;
  let active = ["read", "bash"];
  const notices: string[] = [];
  const calls: any[] = [];
  let answer: any = {
    content: [{ type: "text", text: "Check the boundary condition." }],
    stopReason: "stop", usage: { input: 10, output: 5 },
  };
  const pi = {
    registerFlag() {}, getFlag: () => flag,
    on: (name: string, handler: Function) => { hooks[name] = handler; },
    registerCommand: (_name: string, definition: any) => { command = definition; },
    registerTool: (definition: any) => { tool = definition; },
    getActiveTools: () => active,
    setActiveTools: (tools: string[]) => { active = tools; },
  };
  const ctx: any = {
    hasUI: true,
    ui: { setStatus() {}, notify: (message: string) => notices.push(message) },
    sessionManager: { getBranch: () => [{ type: "message", id: "1", parentId: null,
      timestamp: new Date().toISOString(), message: { role: "user", content: "Fix the bug", timestamp: 1 } }] },
    getSystemPrompt: () => "Main instructions",
    modelRegistry: {
      getAvailable: () => [model], getAll: () => [model],
      streamSimple: (...args: any[]) => {
        calls.push(args);
        return { result: async () => {
          if (answer instanceof Error) throw answer;
          if (typeof answer === "function") return answer(...args);
          return answer;
        } };
      },
    },
  };
  extension(pi as unknown as ExtensionAPI);
  return {
    hooks, ctx, notices, calls, get tool() { return tool; }, get active() { return active; },
    command: (args: string) => command.handler(args, ctx),
    execute: (signal?: AbortSignal) => tool.execute("call", { question: "What did I miss?" }, signal, undefined, ctx),
    answer: (value: any) => { answer = value; }, directory,
    cleanup() {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("config round trip, absence, and invalid configuration", async () => {
  const directory = mkdtempSync(join(tmpdir(), "advisor-config-"));
  try {
    const path = join(directory, "advisor.json");
    assert.deepEqual(readConfig(path), { model: null });
    await saveConfig(path, { model: "test/strong" });
    assert.deepEqual(readConfig(path), { model: "test/strong" });
    writeFileSync(path, '{"model":42}');
    assert.throws(() => readConfig(path), /Cannot read advisor settings/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("model lookup supports IDs with slashes and rejects ambiguous bare IDs", () => {
  const models = [{ provider: "a", id: "vendor/model" }, { provider: "b", id: "vendor/model" }];
  assert.equal(resolveModel("a/vendor/model", models), models[0]);
  assert.throws(() => resolveModel("vendor/model", models), /Ambiguous/);
  assert.throws(() => resolveModel("unknown", models), /Unknown/);
});

test("transcript retains complete tool text but removes image data and signatures", () => {
  const text = "result".repeat(20000);
  const serialized = serializeTranscript([{ role: "toolResult", content: [
    { type: "text", text }, { type: "image", data: "base64secret" },
  ], thinkingSignature: "signature" }]);
  assert.ok(serialized.includes(text));
  assert.ok(!serialized.includes("base64secret"));
  assert.ok(!serialized.includes("signature"));
});

test("default off; command persists model, enables tool, injects guidance and off preserves other tools", async () => {
  const h = harness();
  try {
    await h.hooks.session_start({}, h.ctx);
    assert.deepEqual(h.active, ["read", "bash"]);
    assert.equal((await h.execute()).details.status, "unavailable");
    await h.command("strong");
    assert.deepEqual(h.active, ["read", "bash", "advisor"]);
    assert.equal(JSON.parse(readFileSync(join(h.directory, "advisor.json"), "utf8")).model, "test/strong");
    const prompt = await h.hooks.before_agent_start({ systemPrompt: "Original" }, h.ctx);
    assert.ok(prompt.systemPrompt.startsWith("Original\n"));
    const response = await h.execute();
    assert.equal(response.details.status, "reviewed");
    assert.deepEqual(response.details.usage, { input: 10, output: 5 });
    const [chosen, context, options] = h.calls[0];
    assert.equal(chosen, model);
    assert.ok(context.messages[0].content.includes("Fix the bug"));
    assert.ok(context.messages[0].content.includes("Main instructions"));
    assert.ok(context.messages[0].content.includes("What did I miss?"));
    assert.equal(context.tools, undefined);
    assert.equal(options.maxTokens, 4096);
    await h.command("off");
    assert.deepEqual(h.active, ["read", "bash"]);
    assert.equal(await h.hooks.before_agent_start({ systemPrompt: "Original" }), undefined);
  } finally { h.cleanup(); }
});

test("CLI overrides do not change saved default and noninteractive status works", async () => {
  const h = harness("test/strong");
  try {
    await h.hooks.session_start({}, h.ctx);
    assert.ok(h.active.includes("advisor"));
    assert.deepEqual(readConfig(join(h.directory, "advisor.json")), { model: null });
    await h.command("status");
    assert.ok(h.notices.at(-1)?.includes("test/strong"));
  } finally { h.cleanup(); }
});

test("unavailable, declined, empty and truncated responses are explicit", async () => {
  const h = harness("test/strong");
  try {
    await h.hooks.session_start({}, h.ctx);
    h.answer(new Error("provider unavailable"));
    assert.equal((await h.execute()).details.status, "unavailable");
    h.answer({ content: [], stopReason: "stop" });
    assert.equal((await h.execute()).details.status, "declined");
    h.answer({ content: [{ type: "text", text: "DECLINED: missing evidence" }], stopReason: "stop" });
    assert.equal((await h.execute()).details.status, "declined");
    h.answer({ content: [{ type: "text", text: "Partial guidance" }], stopReason: "length" });
    assert.match((await h.execute()).content[0].text, /incomplete/);
    h.answer({ content: [], stopReason: "error", errorMessage: "context too large" });
    assert.match((await h.execute()).content[0].text, /context too large/);
  } finally { h.cleanup(); }
});

test("already cancelled calls never reach the provider", async () => {
  const h = harness("test/strong");
  try {
    await h.hooks.session_start({}, h.ctx);
    const controller = new AbortController(); controller.abort();
    assert.equal((await h.execute(controller.signal)).details.status, "unavailable");
    assert.equal(h.calls.length, 0);
  } finally { h.cleanup(); }
});

test("switching advisor off cancels in-flight consultation and discards its result", async () => {
  const h = harness("test/strong");
  try {
    await h.hooks.session_start({}, h.ctx);
    let release!: Function;
    h.answer(() => new Promise((resolve) => { release = resolve; }));
    const pending = h.execute();
    await h.command("off");
    assert.ok(h.calls[0][2].signal.aborted);
    release({ content: [{ type: "text", text: "Stale advice" }], stopReason: "stop" });
    const result = await pending;
    assert.equal(result.details.status, "unavailable");
    assert.ok(!result.content[0].text.includes("Stale advice"));
  } finally { h.cleanup(); }
});

test("Pi CLI loads the extension and reports status without an API request", async () => {
  const { spawnSync } = await import("node:child_process");
  const directory = mkdtempSync(join(tmpdir(), "advisor-cli-"));
  try {
    const output = spawnSync(process.execPath, [
      "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
      "--offline", "--no-extensions", "--no-mcp", "--no-skills", "--no-context-files",
      "--no-session", "-e", "./extensions/index.ts", "--advisor", "off", "-p", "/advisor status",
    ], { encoding: "utf8", timeout: 20000, env: {
      ...process.env, PI_CODING_AGENT_DIR: directory, PI_TELEMETRY: "0", ANTHROPIC_API_KEY: "unused-test-key",
    } });
    assert.equal(output.status, 0, output.stderr);
    assert.match(output.stderr, /Advisor: off/);
    assert.equal(output.stdout, "");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
