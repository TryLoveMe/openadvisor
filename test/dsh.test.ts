import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Config, apply, defaultConfigPath } from "../dsh/index.ts";
import type { GenerateOptions, StreamChunk, ToolDefinition } from "../dsh/types.ts";

type Script = StreamChunk[] | Error | ((options: GenerateOptions) => AsyncIterable<StreamChunk>);

function harness(config: Record<string, unknown> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "dsh-advisor-test-"));
  const configPath = join(directory, "advisor.json");
  let tool: ToolDefinition | undefined;
  let command: any;
  let section: any;
  let disposed = 0;
  const effects: Function[] = [];
  const listeners: Record<string, Function> = {};
  const steered: any[] = [];
  const calls: GenerateOptions[] = [];
  let script: Script = [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: "Check the " },
    { type: "text-delta", index: 0, text: "boundary." },
    { type: "usage", usage: { inputTokens: 100, outputTokens: 7 } },
    { type: "finish", reason: { kind: "stop" } },
  ];
  const ctx = {
    tools: { register: (definition: ToolDefinition) => { tool = definition; return () => { disposed++; tool = undefined; }; } },
    commands: { register: (definition: any) => { command = definition; return () => {}; } },
    systemPrompt: { section: (definition: any) => { section = definition; return () => {}; }, getSectionOrder: () => 2800 },
    llm: {
      listProviders: () => [{ id: "deepseek", name: "DeepSeek" }, { id: "openrouter", name: "OpenRouter" }],
      listModels: async (provider: string) => provider === "deepseek"
        ? [{ provider, id: "deepseek-reasoner" }, { provider, id: "deepseek-chat" }]
        : [{ provider, id: "vendor/model" }],
      stream(options: GenerateOptions) {
        calls.push(options);
        const current = script;
        if (typeof current === "function") return current(options);
        return (async function* () {
          if (current instanceof Error) throw current;
          for (const chunk of current) yield chunk;
        })();
      },
    },
    effect: (execute: () => Function | void) => { const dispose = execute(); if (dispose) effects.push(dispose); },
    on: (event: string, listener: Function) => { listeners[event] = listener; return () => {}; },
  };
  const session = { id: "s1", deriveMessages: () => [
    { role: "system", id: "m0", content: [{ type: "text", text: "Main instructions" }] },
    { role: "user", id: "m1", source: { kind: "user" }, content: [{ type: "text", text: "Fix the bug" }] },
  ] };
  const agent = { id: "s1", session, steer: (message: any) => steered.push(message) };
  apply(ctx as any, { configPath, ...config } as any);
  return {
    ctx, calls, directory, configPath,
    get tool() { return tool; }, get section() { return section; }, get disposed() { return disposed; },
    agent, steered, listeners,
    command: (input: string, signal = new AbortController().signal) => command.handler({ rawInput: input, signal, agent }),
    execute: (signal = new AbortController().signal, question = "What did I miss?", context?: string) =>
      tool!.execute({ question, ...(context ? { context } : {}) }, { agent, signal }) as Promise<any>,
    toolResult: (name: string, isError: boolean, text = "boom", signal = new AbortController().signal) =>
      listeners["tools/post-execute"]({ name, agent, signal }, { isError, content: [{ type: "text", text }] }, async () => ({ kind: "accept" })),
    stopTurn: (turn: number, signal = new AbortController().signal) => listeners["agent/turn-stopping"]({ agent, turn, signal }),
    script: (value: Script) => { script = value; },
    unload: () => effects.forEach((dispose) => dispose()),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test("Config implements Standard Schema and rejects invalid values", () => {
  const validate = Config["~standard"].validate;
  assert.deepEqual(validate(undefined), { value: {} });
  assert.deepEqual(validate({ model: "off", maxTokens: 2048 }), { value: { model: null, maxTokens: 2048 } });
  assert.ok("issues" in validate({ maxTokens: -1 }));
  assert.ok("issues" in validate({ model: 3 }));
  assert.equal(defaultConfigPath({ DSH_HOME: "/x" }), join("/x", "advisor.json"));
});

test("off by default: no tool, empty guidance; /advisor enables, persists and off unregisters", async () => {
  const h = harness();
  try {
    assert.equal(h.tool, undefined);
    assert.equal(h.section.text(), "");
    const set = await h.command("deepseek-reasoner");
    assert.equal(set.kind, "success");
    assert.equal(JSON.parse(readFileSync(h.configPath, "utf8")).model, "deepseek/deepseek-reasoner");
    assert.ok(h.tool);
    assert.match(h.section.text(), /advisor tool/);
    const status = await h.command("status");
    assert.match(status.text, /deepseek\/deepseek-reasoner/);
    assert.equal((await h.command("off")).text, "Advisor off");
    assert.equal(h.tool, undefined);
    assert.equal(h.disposed, 1);
  } finally { h.cleanup(); }
});

test("model resolution handles provider routes, slashes in ids, unknown models and listing", async () => {
  const h = harness();
  try {
    assert.equal((await h.command("openrouter/vendor/model")).kind, "success");
    assert.equal((await h.command("vendor/model")).kind, "success");
    assert.equal(JSON.parse(readFileSync(h.configPath, "utf8")).model, "openrouter/vendor/model");
    assert.equal((await h.command("deepseek/nope")).kind, "error");
    assert.equal((await h.command("nope")).kind, "error");
    const list = await h.command("list chat");
    assert.equal(list.text, "deepseek/deepseek-chat");
  } finally { h.cleanup(); }
});

test("consultation streams advice with the conversation, limits and usage", async () => {
  const h = harness({ model: "deepseek/deepseek-reasoner", maxTokens: 1000, reasoning: "high" });
  try {
    const result = await h.execute();
    assert.equal(result.status, "reviewed");
    assert.match(result.text, /Reviewed · deepseek\/deepseek-reasoner\n\nCheck the boundary\./);
    assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 7 });
    const [call] = h.calls;
    assert.equal(call.provider, "deepseek");
    assert.equal(call.model, "deepseek-reasoner");
    assert.equal(call.maxTokens, 1000);
    assert.equal(call.reasoningEffort, "high");
    assert.match(call.system!, /independent advisor/);
    const prompt = call.messages[0].content[0].text;
    assert.ok(prompt.includes("Fix the bug") && prompt.includes("Main instructions") && prompt.includes("What did I miss?"));
    assert.ok(!prompt.includes('"m1"'), "message ids are stripped");
    assert.deepEqual(h.tool!.output.render({}, result), [{ type: "text", text: result.text }]);
    assert.match((await h.command("status")).text, /1 consultation\(s\): 100 input \/ 7 output tokens/);
  } finally { h.cleanup(); }
});

test("cordis model overrides the saved choice; saved tuning applies", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dsh-advisor-saved-"));
  try {
    const configPath = join(directory, "advisor.json");
    writeFileSync(configPath, JSON.stringify({ model: "deepseek/deepseek-chat", timeoutMs: 5000 }));
    const h = harness({ configPath, model: null });
    assert.equal(h.tool, undefined);
    const saved = harness({ configPath });
    assert.ok(saved.tool);
    assert.match((await saved.command("status")).text, /deepseek-chat[\s\S]*5s/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("failures, refusals, truncation and empty output are explicit", async () => {
  const h = harness({ model: "deepseek/deepseek-reasoner" });
  try {
    h.script(new Error("provider unavailable"));
    assert.match((await h.execute()).text, /Advisor unavailable: provider unavailable/);
    h.script([{ type: "finish", reason: { kind: "error", failure: { message: "context too large" } } }]);
    assert.match((await h.execute()).text, /context too large/);
    h.script([{ type: "text-delta", index: 0, text: "Partial" }]);
    assert.match((await h.execute()).text, /without finishing/);
    h.script([{ type: "block-end", index: 0, block: { type: "text", text: "DECLINED: no evidence" } }, { type: "finish", reason: { kind: "stop" } }]);
    assert.equal((await h.execute()).status, "declined");
    h.script([{ type: "finish", reason: { kind: "stop" } }]);
    assert.equal((await h.execute()).status, "declined");
    h.script([{ type: "text-delta", index: 0, text: "Partial" }, { type: "finish", reason: { kind: "max-tokens" } }]);
    assert.match((await h.execute()).text, /incomplete/);
    assert.equal((await h.execute(undefined, "  ")).status, "unavailable");
  } finally { h.cleanup(); }
});

test("timeouts, caller aborts and configuration changes cancel consultations", async () => {
  const h = harness({ model: "deepseek/deepseek-reasoner", timeoutMs: 20 });
  const hang = (options: GenerateOptions) => (async function* () {
    await new Promise((_, reject) => options.signal!.addEventListener("abort", () => reject(options.signal!.reason)));
    yield { type: "finish", reason: { kind: "stop" } } as StreamChunk;
  })();
  try {
    h.script(hang);
    assert.match((await h.execute()).text, /timed out/);
    const caller = new AbortController();
    const pending = h.execute(caller.signal);
    caller.abort(new Error("user stopped"));
    await assert.rejects(pending, /user stopped/);
    const stale = h.execute();
    await h.command("deepseek/deepseek-chat");
    assert.match((await stale).text, /cancelled/);
    h.script(hang);
    const unloading = h.execute();
    h.unload();
    assert.match((await unloading).text, /cancelled/);
  } finally { h.cleanup(); }
});

test("built plugin loads under plain Node without TypeScript tooling", () => {
  const output = spawnSync(process.execPath, ["--input-type=module", "-e",
    "const m = await import('./dist/dsh/index.js'); console.log(m.name, typeof m.apply, typeof m.Config['~standard'].validate)"],
  { encoding: "utf8" });
  assert.equal(output.status, 0, output.stderr);
  assert.equal(output.stdout.trim(), "openadvisor function function");
});

test("dsh: context argument, /advisor ask, and session limit", async () => {
  const h = harness({ model: "deepseek/deepseek-reasoner" });
  try {
    await h.execute(undefined, "Safe?", "stack trace here");
    assert.match(h.calls[0].messages[0].content[0].text, /Additional context supplied by the agent[\s\S]*stack trace here/);
    const asked = await h.command("ask are we done?");
    assert.equal(asked.kind, "success");
    assert.equal(asked.text, "Advisor (deepseek/deepseek-reasoner):\n\nCheck the boundary.");
    assert.match(h.calls[1].messages[0].content[0].text, /The user \(not the agent\)/);
    assert.equal((await h.command("limit 2")).kind, "success");
    assert.match((await h.execute()).text, /consultation limit/);
    assert.equal(JSON.parse(readFileSync(h.configPath, "utf8")).maxConsultations, 2);
  } finally { h.cleanup(); }
});

test("dsh: auto review steers once per turn and skips small turns and subagents", async () => {
  const h = harness({ model: "deepseek/deepseek-reasoner", autoReview: true, reviewMinToolCalls: 2 });
  try {
    await h.toolResult("bash", false);
    await h.stopTurn(1);
    assert.equal(h.calls.length, 0, "one tool call is below the minimum");
    h.script([{ type: "text-delta", index: 0, text: "VERDICT: NEEDS_WORK\n- run the tests" }, { type: "finish", reason: { kind: "stop" } }]);
    await h.toolResult("bash", false); await h.toolResult("edit", false);
    await h.stopTurn(2);
    assert.equal(h.steered.length, 1);
    assert.equal(h.steered[0].source.kind, "openadvisor");
    assert.match(h.steered[0].content[0].text, /found gaps[\s\S]*run the tests/);
    await h.toolResult("bash", false); await h.toolResult("bash", false);
    await h.stopTurn(2);
    assert.equal(h.steered.length, 1, "the same turn is reviewed once");
    h.script([{ type: "text-delta", index: 0, text: "VERDICT: COMPLETE" }, { type: "finish", reason: { kind: "stop" } }]);
    await h.toolResult("bash", false); await h.toolResult("bash", false);
    await h.stopTurn(3);
    assert.equal(h.steered.length, 1, "complete verdicts do not steer");
    (h.agent.session as any).header = { origin: "subagent" };
    await h.toolResult("bash", false); await h.toolResult("bash", false);
    await h.stopTurn(4);
    assert.equal(h.calls.length, 2);
    assert.equal((await h.command("review off")).kind, "success");
  } finally { h.cleanup(); }
});

test("dsh: repeated failures attach advice as additional context", async () => {
  const h = harness({ model: "deepseek/deepseek-reasoner", autoOnFailures: 2 });
  try {
    assert.deepEqual(await h.toolResult("bash", true, "first"), { kind: "accept" });
    const decision = await h.toolResult("bash", true, "exit code 127");
    assert.equal(decision.kind, "accept");
    assert.equal(decision.additionalContexts.length, 1);
    assert.match(decision.additionalContexts[0].content[0].text, /^\[Advisor, after 2 consecutive tool failures\]\nCheck the boundary\./);
    assert.match(h.calls[0].messages[0].content[0].text, /exit code 127/);
    assert.deepEqual(await h.toolResult("advisor", true), { kind: "accept" }, "the advisor tool itself is ignored");
    assert.equal(h.calls.length, 1);
  } finally { h.cleanup(); }
});
