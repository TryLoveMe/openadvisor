import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/index.ts";
import { matchModels, readConfig, resolveModel, saveConfig, saveModel, serializeTranscript } from "../extensions/core.ts";

const model = { provider: "test", id: "strong", maxTokens: 8192, reasoning: true };

function harness(flag?: string) {
  const directory = mkdtempSync(join(tmpdir(), "secondlook-test-"));
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
    complete: (prefix: string) => command.getArgumentCompletions(prefix),
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
    assert.equal(options.reasoning, "high");
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

test("config tuning fields are validated and preserved when the model changes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "advisor-tuning-"));
  try {
    const path = join(directory, "advisor.json");
    writeFileSync(path, JSON.stringify({ model: "a/b", maxTokens: 1000, timeoutMs: 5000, reasoning: "medium", extra: 1 }));
    assert.deepEqual(readConfig(path), { model: "a/b", maxTokens: 1000, timeoutMs: 5000, reasoning: "medium" });
    await saveModel(path, null);
    assert.deepEqual(readConfig(path), { model: null, maxTokens: 1000, timeoutMs: 5000, reasoning: "medium" });
    writeFileSync(path, '{"model":"a/b","timeoutMs":0}');
    assert.throws(() => readConfig(path), /timeoutMs/);
    await saveModel(path, "a/c");
    assert.deepEqual(readConfig(path), { model: "a/c" });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("transcript drops per-message bookkeeping but keeps tool arguments and is compact", () => {
  const serialized = serializeTranscript([{
    role: "assistant", api: "x", provider: "p", model: "m", usage: { input: 1 }, timestamp: 1,
    content: [{ type: "toolCall", name: "pick", arguments: { model: "keep-me", provider: "keep-too" } }],
  }, { role: "toolResult", toolName: "pick", details: { huge: "ui-only" }, content: [{ type: "text", text: "ok" }] }]);
  const parsed = JSON.parse(serialized);
  assert.deepEqual(Object.keys(parsed[0]).sort(), ["content", "role"]);
  assert.deepEqual(parsed[0].content[0].arguments, { model: "keep-me", provider: "keep-too" });
  assert.equal(parsed[1].details, undefined);
  assert.ok(!serialized.includes("\n  "));
  assert.ok(!serialized.includes("\n"));
});

test("command completions offer subcommands and filter models", async () => {
  const h = harness();
  try {
    await h.hooks.session_start({}, h.ctx);
    const all = (await h.complete("")).map((item: any) => item.value);
    assert.ok(all.includes("off") && all.includes("review on") && all.includes("test/strong"));
    assert.deepEqual((await h.complete("STR")).map((item: any) => item.value), ["test/strong"]);
    assert.equal(await h.complete("zzz"), null);
    assert.deepEqual(matchModels("o", ["b/o", "off"]), ["off", "b/o"]);
  } finally { h.cleanup(); }
});

test("saved limits reach the provider; usage is tallied in status; unknown startup model warns", async () => {
  const h = harness();
  try {
    writeFileSync(join(h.directory, "advisor.json"), JSON.stringify({ model: "strong", maxTokens: 100, reasoning: "off" }));
    await h.hooks.session_start({}, h.ctx);
    assert.ok(h.active.includes("advisor"));
    await h.execute();
    const options = h.calls[0][2];
    assert.equal(options.maxTokens, 100);
    assert.equal(options.reasoning, undefined);
    await h.command("status");
    assert.match(h.notices.at(-1)!, /Advisor: test\/strong[\s\S]*1 consultation\(s\): 10 input \/ 5 output/);
  } finally { h.cleanup(); }
  const typo = harness("missing/model");
  try {
    await typo.hooks.session_start({}, typo.ctx);
    assert.ok(typo.notices.some((notice) => /Unknown advisor model/.test(notice)));
  } finally { typo.cleanup(); }
});

test("timeouts are reported as such", async () => {
  const h = harness();
  try {
    writeFileSync(join(h.directory, "advisor.json"), JSON.stringify({ model: "test/strong", timeoutMs: 20 }));
    await h.hooks.session_start({}, h.ctx);
    h.answer((_model: unknown, _context: unknown, options: any) => new Promise((_, reject) =>
      options.signal.addEventListener("abort", () => reject(new Error("aborted")))));
    assert.match((await h.execute()).content[0].text, /timed out after 20ms/);
  } finally { h.cleanup(); }
});

function settle(h: any, overrides: Record<string, unknown> = {}) {
  return h.hooks.agent_before_settle({ type: "agent_before_settle", entries: [], continue: false, outcome: "completed",
    context: { canContinue: false }, ...overrides }, h.ctx);
}

test("tool context is sent to the advisor", async () => {
  const h = harness("test/strong");
  try {
    await h.hooks.session_start({}, h.ctx);
    await h.tool.execute("call", { question: "Is this safe?", context: "diff --git a/x b/x" }, undefined, undefined, h.ctx);
    const prompt = h.calls[0][1].messages[0].content;
    assert.match(prompt, /Additional context supplied by the agent[\s\S]*diff --git a\/x b\/x[\s\S]*Is this safe\?/);
  } finally { h.cleanup(); }
});

test("/advisor ask answers the user without touching the conversation", async () => {
  const h = harness("test/strong");
  try {
    await h.hooks.session_start({}, h.ctx);
    await h.command("ask is the agent on track?");
    assert.match(h.calls[0][1].messages[0].content, /The user \(not the agent\) is asking[\s\S]*is the agent on track\?/);
    assert.equal(h.notices.at(-1), "Advisor (test/strong):\n\nCheck the boundary condition.");
    await h.command("ask");
    assert.match(h.notices.at(-1)!, /Usage/);
  } finally { h.cleanup(); }
});

test("auto review: needs_work continues once, complete only notifies, small requests are skipped", async () => {
  const h = harness("test/strong");
  try {
    await h.hooks.session_start({}, h.ctx);
    await h.command("review on");
    assert.equal(JSON.parse(readFileSync(join(h.directory, "advisor.json"), "utf8")).autoReview, true);
    await h.hooks.before_agent_start({ messageType: "user", systemPrompt: "x" });
    for (let i = 0; i < 2; i++) await h.hooks.tool_execution_end({ toolName: "bash" });
    assert.equal(await settle(h), undefined, "below reviewMinToolCalls");
    assert.equal(h.calls.length, 0);
    await h.hooks.tool_execution_end({ toolName: "bash" });
    h.answer({ content: [{ type: "text", text: "VERDICT: NEEDS_WORK\n- tests were never run" }], stopReason: "stop" });
    const result = await settle(h);
    assert.equal(result.continue, true);
    assert.equal(result.entries[0].customType, "advisor-review");
    assert.match(result.entries[0].content, /found gaps[\s\S]*tests were never run/);
    assert.match(h.calls[0][1].messages[0].content, /VERDICT: COMPLETE/);
    assert.equal(await settle(h), undefined, "only one review per request");
    await h.hooks.before_agent_start({ messageType: "custom", systemPrompt: "x" });
    assert.equal(await settle(h), undefined, "continuations do not reset the review");
    await h.hooks.before_agent_start({ messageType: "user", systemPrompt: "x" });
    for (let i = 0; i < 3; i++) await h.hooks.tool_execution_end({ toolName: "read" });
    h.answer({ content: [{ type: "text", text: "VERDICT: COMPLETE" }], stopReason: "stop" });
    assert.equal(await settle(h), undefined);
    assert.match(h.notices.at(-1)!, /complete/);
    await h.hooks.before_agent_start({ messageType: "user", systemPrompt: "x" });
    for (let i = 0; i < 3; i++) await h.hooks.tool_execution_end({ toolName: "read" });
    assert.equal(await settle(h, { outcome: "error" }), undefined, "failed runs are not reviewed");
    assert.equal(h.calls.length, 2);
  } finally { h.cleanup(); }
});

test("auto consult after consecutive failures appends advice to the failing result", async () => {
  const h = harness("test/strong");
  try {
    await h.hooks.session_start({}, h.ctx);
    await h.command("failures 2");
    const fail = (text: string) => h.hooks.tool_result({ toolName: "bash", isError: true, content: [{ type: "text", text }] }, h.ctx);
    assert.equal(await fail("err 1"), undefined);
    await h.hooks.tool_result({ toolName: "bash", isError: false, content: [] }, h.ctx);
    assert.equal(await fail("err 2"), undefined, "a success resets the streak");
    const result = await fail("ENOENT: missing file");
    assert.match(h.calls[0][1].messages[0].content, /last 2 tool calls failed[\s\S]*ENOENT: missing file/);
    assert.equal(result.content[0].text, "ENOENT: missing file");
    assert.match(result.content[1].text, /\[Advisor, after 2 consecutive tool failures\]\nCheck the boundary condition\./);
    assert.equal(await fail("again"), undefined, "the streak restarts after a consultation");
    await h.command("failures off");
    await fail("x"); await fail("y"); await fail("z");
    assert.equal(h.calls.length, 1);
  } finally { h.cleanup(); }
});

test("session consultation limit applies to every consultation", async () => {
  const h = harness("test/strong");
  try {
    await h.hooks.session_start({}, h.ctx);
    await h.command("limit 1");
    assert.equal((await h.execute()).details.status, "reviewed");
    const blocked = await h.execute();
    assert.match(blocked.content[0].text, /consultation limit for this session \(1\) is reached/);
    assert.equal(h.calls.length, 1);
    await h.command("status");
    assert.match(h.notices.at(-1)!, /Session limit: 1\/1/);
    await h.hooks.session_start({}, h.ctx);
    assert.equal((await h.execute()).details.status, "reviewed", "a new session has a fresh budget");
    await h.command("limit nope");
    assert.match(h.notices.at(-1)!, /Usage/);
  } finally { h.cleanup(); }
});
