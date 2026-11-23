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
  };
  const session = { id: "s1", deriveMessages: () => [
    { role: "system", id: "m0", content: [{ type: "text", text: "Main instructions" }] },
    { role: "user", id: "m1", source: { kind: "user" }, content: [{ type: "text", text: "Fix the bug" }] },
  ] };
  apply(ctx as any, { configPath, ...config } as any);
  return {
    ctx, calls, directory, configPath,
    get tool() { return tool; }, get section() { return section; }, get disposed() { return disposed; },
    command: (input: string, signal = new AbortController().signal) => command.handler({ rawInput: input, signal, agent: { id: "s1", session } }),
    execute: (signal = new AbortController().signal, question = "What did I miss?") =>
      tool!.execute({ question }, { agent: { id: "s1", session }, signal }) as Promise<any>,
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
  assert.equal(output.stdout.trim(), "pi-advisor function function");
});
