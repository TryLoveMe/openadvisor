// DeepSeek Harness (dsh) plugin: the same advisor tool and /advisor command as the Pi extension.
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ADVISOR_GUIDANCE, ADVISOR_SYSTEM, CONTEXT_DESCRIPTION, Consultant, QUESTION_DESCRIPTION, REVIEW_QUESTION,
  TOOL_DESCRIPTION, USER_ASK_PREFIX, adviceBody, consultationPrompt, failureNote, failureQuestion, formatDuration,
  matchModels, parseConfig, readConfig, resolveModel, reviewMessage, saveModel, serializeTranscript, settingsOf,
  unavailable, updateConfig, type AdvisorConfig, type Consultation,
} from "../extensions/core.ts";
import type { Agent, CommandResult, Context, Dispose, LlmService, ToolDefinition, UserMessage } from "./types.ts";

export const name = "openadvisor";
export const inject = ["tools", "llm", "commands", "systemPrompt"];

/** Message source kind for advisor notes the main model receives. */
export const SOURCE_KIND = "openadvisor";

export interface DshAdvisorConfig extends Partial<Omit<AdvisorConfig, "model">> {
  /** Advisor as provider/model-id. Overrides the saved choice; "off" or null disables. Omit to use the saved choice. */
  model?: string | null;
  /** Where /advisor saves its choice. Defaults to $DSH_HOME/advisor.json (~/.dsh/advisor.json). */
  configPath?: string;
}

function parseDshConfig(value: unknown): DshAdvisorConfig {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object");
  const raw = value as Record<string, unknown>;
  const result: DshAdvisorConfig = {};
  if (raw.configPath !== undefined) {
    if (typeof raw.configPath !== "string" || !raw.configPath.trim()) throw new Error("expected configPath to be a nonempty string");
    result.configPath = raw.configPath;
  }
  const { model, ...tuning } = parseConfig({ ...raw, model: raw.model === "off" ? null : raw.model ?? null });
  if (raw.model !== undefined) result.model = model;
  return { ...result, ...tuning };
}

/** Standard Schema implementation, as Cordis requires for an exported Config. */
export const Config = {
  "~standard": {
    version: 1 as const,
    vendor: "openadvisor",
    validate(value: unknown) {
      try { return { value: parseDshConfig(value) }; }
      catch (error) { return { issues: [{ message: `openadvisor: ${(error as Error).message}` }] }; }
    },
  },
};

export function defaultConfigPath(env: Record<string, string | undefined> = process.env): string {
  const home = env.DSH_HOME?.trim();
  return join(home ? home : join(homedir(), ".dsh"), "advisor.json");
}

interface Route { provider: string; model: string }

const routeKey = (route: Route) => `${route.provider}/${route.model}`;

function numericFields(value: object): Record<string, number> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => typeof entry === "number" && Number.isFinite(entry)));
}

/** Split provider/model using registered provider routes; model ids may contain slashes. */
function splitRoute(spec: string, providers: readonly string[]): Route | undefined {
  const provider = providers.filter((id) => spec.startsWith(`${id}/`)).sort((a, b) => b.length - a.length)[0];
  return provider ? { provider, model: spec.slice(provider.length + 1) } : undefined;
}

async function listAll(llm: LlmService, signal?: AbortSignal) {
  const providers = llm.listProviders().map((provider) => provider.id);
  const lists = await Promise.allSettled(providers.map(async (provider) => {
    signal?.throwIfAborted();
    return (await llm.listModels(provider)).map((model) => ({ provider, id: model.id }));
  }));
  return lists.flatMap((list) => list.status === "fulfilled" ? list.value : []);
}

/** Validate a user-supplied spec against the provider catalog. */
async function resolveRoute(llm: LlmService, spec: string, signal?: AbortSignal): Promise<Route> {
  const providers = llm.listProviders().map((provider) => provider.id);
  const split = splitRoute(spec, providers);
  if (split) {
    let models: readonly { id: string }[] = [];
    try { models = await llm.listModels(split.provider); } catch { /* catalog unavailable: trust the explicit route */ }
    if (models.length && !models.some((model) => model.id === split.model)) {
      throw new Error(`Unknown model "${split.model}" for provider "${split.provider}". Use /advisor list.`);
    }
    return split;
  }
  const match = resolveModel(spec, await listAll(llm, signal));
  return { provider: match.provider, model: match.id };
}

function note(text: string): UserMessage {
  return { role: "user", id: randomUUID(), content: [{ type: "text", text }], source: { kind: SOURCE_KIND } };
}

const USAGE = "Usage: /advisor provider/model-id | list [filter] | ask <question> | review on|off | failures <n>|off | limit <n>|off | off | status";

type Details = { usage?: Record<string, number> };

export function apply(ctx: Context, config: DshAdvisorConfig = {}) {
  const configPath = config.configPath ?? defaultConfigPath();
  const { model: configModel, configPath: _path, ...configTuning } = config;
  let saved: AdvisorConfig = { model: null };
  let configError: string | undefined;
  try { saved = readConfig(configPath); }
  catch (error) { configError = (error as Error).message; console.warn(`[openadvisor] ${configError}`); }

  let selected: string | null = configModel !== undefined ? configModel : saved.model;
  let tuning: Partial<AdvisorConfig> = { ...saved, ...configTuning };
  const consultant = new Consultant();
  // Per session: tool calls since the last turn end, consecutive failures, and the last reviewed turn.
  const toolCalls = new Map<string, number>();
  const failures = new Map<string, number>();
  const reviewedTurn = new Map<string, number>();
  let disposeTool: Dispose | undefined;

  const limits = () => settingsOf(tuning);
  const reasoningEffort = () => tuning.reasoning && tuning.reasoning !== "off" ? tuning.reasoning : undefined;

  function currentRoute(): Route {
    if (!selected) throw new Error("advisor is off");
    const route = splitRoute(selected, ctx.llm.listProviders().map((provider) => provider.id));
    if (!route) throw new Error(`advisor model "${selected}" does not name a registered provider; run /advisor provider/model-id`);
    return route;
  }

  /** Run one consultation over the agent's derived history. Never throws unless asked to rethrow a caller abort. */
  async function consult(agent: Agent, question: string, options: { context?: string; signal?: AbortSignal; rethrow?: boolean } = {}): Promise<Consultation<Details>> {
    if (!selected) return { ...unavailable("advisor is off; ask the user to configure /advisor"), model: "off" };
    let route: Route;
    try { route = currentRoute(); }
    catch (error) { return { ...unavailable((error as Error).message), model: selected }; }
    const { maxTokens, timeoutMs, maxConsultations } = limits();
    const effort = reasoningEffort();
    return consultant.consult<Details>({
      key: agent.session.id,
      model: routeKey(route),
      timeoutMs,
      maxConsultations,
      signal: options.signal,
      rethrowCallerAbort: options.rethrow,
      call: async (signal) => {
        const prompt = consultationPrompt({ transcript: serializeTranscript(agent.session.deriveMessages()), question, context: options.context });
        const texts = new Map<number, string>();
        let finish: { kind: string; failure?: { message: string } } | undefined;
        let usage: Record<string, number> | undefined;
        for await (const chunk of ctx.llm.stream({
          provider: route.provider,
          model: route.model,
          system: ADVISOR_SYSTEM,
          messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
          maxTokens,
          signal,
          sessionId: agent.session.id,
          ...(effort ? { reasoningEffort: effort } : {}),
        })) {
          if (chunk.type === "text-delta") texts.set(chunk.index, (texts.get(chunk.index) ?? "") + chunk.text);
          else if (chunk.type === "block-end" && chunk.block.type === "text" && typeof chunk.block.text === "string") texts.set(chunk.index, chunk.block.text);
          else if (chunk.type === "usage") usage = numericFields(chunk.usage);
          else if (chunk.type === "finish") finish = chunk.reason;
        }
        if (!finish) throw new Error("model stream ended without finishing");
        if (finish.kind === "error" || finish.kind === "aborted") throw new Error(finish.failure?.message || finish.kind);
        return {
          text: [...texts.entries()].sort(([a], [b]) => a - b).map(([, value]) => value).join("\n"),
          truncated: finish.kind === "max-tokens",
          usage: { input: (usage?.inputTokens ?? 0) + (usage?.cacheReadTokens ?? 0) + (usage?.cacheWriteTokens ?? 0), output: usage?.outputTokens },
          details: usage ? { usage } : {},
        };
      },
    });
  }

  const tool: ToolDefinition = {
    name: "advisor",
    description: TOOL_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: QUESTION_DESCRIPTION },
        context: { type: "string", description: CONTEXT_DESCRIPTION },
      },
      required: ["question"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["reviewed", "declined", "unavailable"] },
          model: { oneOf: [{ type: "string" }, { type: "null" }] },
          text: { type: "string" },
          usage: { type: "object", additionalProperties: true },
        },
        required: ["status", "model", "text"],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: "text", text: (value as { text: string }).text }],
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => {
      const question = (args as { question?: unknown } | null)?.question;
      return { card: "generic", title: "Advisor", ...(typeof question === "string" ? { content: [{ type: "text", text: question }] } : {}) };
    },
    async execute(args, exec) {
      const { question, context } = (args ?? {}) as { question?: unknown; context?: unknown };
      if (typeof question !== "string" || !question.trim()) {
        return { ...unavailable("the question argument must be a nonempty string"), model: selected };
      }
      const advice = await consult(exec.agent, question.trim(), {
        context: typeof context === "string" ? context : undefined,
        signal: exec.signal,
        rethrow: true,
      });
      return {
        status: advice.status,
        model: advice.model === "off" ? null : advice.model,
        text: advice.text,
        ...(advice.details?.usage ? { usage: advice.details.usage } : {}),
      };
    },
  };

  function syncTool() {
    if (selected && !disposeTool) disposeTool = ctx.tools.register(tool);
    else if (!selected && disposeTool) { const dispose = disposeTool; disposeTool = undefined; dispose(); }
  }

  let order = 2850;
  try { order = ctx.systemPrompt.getSectionOrder("TOOL_SUBAGENT") + 50; } catch { /* keep the fallback position */ }
  ctx.systemPrompt.section({
    name: "openadvisor:guidance",
    order,
    interpolate: false,
    replacement: "",
    text: () => selected ? ADVISOR_GUIDANCE : "",
  });

  // Count tool calls and consult automatically after repeated failures; the advice
  // reaches the model as context right after the failing result.
  ctx.on("tools/post-execute", async (exec, result, next) => {
    const decision = await next();
    const agent = exec.agent;
    if (!agent || exec.name === "advisor") return decision;
    const key = agent.session.id;
    toolCalls.set(key, (toolCalls.get(key) ?? 0) + 1);
    if (!result.isError) { failures.set(key, 0); return decision; }
    const count = (failures.get(key) ?? 0) + 1;
    failures.set(key, count);
    const threshold = limits().autoOnFailures;
    if (!selected || threshold <= 0 || count < threshold) return decision;
    failures.set(key, 0);
    const error = result.content.map((block) => block.type === "text" ? block.text ?? "" : `[${block.type}]`).join("\n");
    const advice = await consult(agent, failureQuestion(count, exec.name, error), { signal: exec.signal });
    if (advice.status !== "reviewed") return decision;
    return { ...decision, additionalContexts: [...(decision.additionalContexts ?? []), note(failureNote(count, advice.text).trim())] };
  });

  // Review once per turn before it closes; gaps are steered back as one more step.
  ctx.on("agent/turn-stopping", async ({ agent, turn, signal }) => {
    const key = agent.session.id;
    const calls = toolCalls.get(key) ?? 0;
    toolCalls.set(key, 0);
    failures.set(key, 0);
    const { autoReview, reviewMinToolCalls } = limits();
    if (!selected || !autoReview || reviewedTurn.get(key) === turn || calls < reviewMinToolCalls) return;
    if (agent.session.header?.origin === "subagent") return;
    reviewedTurn.set(key, turn);
    const advice = await consult(agent, REVIEW_QUESTION, { signal });
    if (advice.verdict === "needs_work" && !signal.aborted) agent.steer(note(reviewMessage(advice.model, advice.text)));
  });

  function describe(sessionId: string): string {
    const settings = limits();
    const lines = [`Advisor: ${selected ?? "off"}`];
    if (selected) {
      lines.push(`Limits: ${settings.maxTokens} output tokens, ${formatDuration(settings.timeoutMs)}, reasoning ${reasoningEffort() ?? "adapter default"}`);
      lines.push(`Auto review before finishing: ${settings.autoReview ? `on (turns with ${settings.reviewMinToolCalls}+ tool calls)` : "off"}`);
      lines.push(`Auto consult after failures: ${settings.autoOnFailures ? `${settings.autoOnFailures} in a row` : "off"}`);
      const used = consultant.used(sessionId);
      lines.push(`Session limit: ${settings.maxConsultations ? `${used}/${settings.maxConsultations}` : `${used} used, unlimited`}`);
    }
    if (configModel !== undefined) lines.push("The model is set in cordis.yml; /advisor changes apply to this process and the saved default.");
    lines.push(consultant.tally.describe());
    if (configError) lines.push(configError);
    return lines.join("\n");
  }

  async function setOption(patch: Partial<AdvisorConfig>, message: string): Promise<CommandResult> {
    try {
      saved = await updateConfig(configPath, patch);
      tuning = { ...saved, ...configTuning, ...patch };
      configError = undefined;
      return { kind: "success", text: message };
    } catch (error) {
      return { kind: "error", text: (error as Error).message };
    }
  }

  function parseCount(value: string): number | undefined {
    if (value === "off") return 0;
    const count = Number(value);
    return Number.isInteger(count) && count > 0 ? count : undefined;
  }

  async function command(input: string, agent: Agent, signal: AbortSignal): Promise<CommandResult> {
    const trimmed = input.trim();
    const [verb = "", ...rest] = trimmed.split(/\s+/);
    const value = rest.join(" ");
    if (!verb || verb === "status") return { kind: "success", text: `${describe(agent.session.id)}\n\n${USAGE}` };
    if (verb === "list") {
      const keys = (await listAll(ctx.llm, signal)).map((model) => `${model.provider}/${model.id}`).sort();
      const shown = matchModels(value, keys, 200);
      return { kind: "success", text: shown.length ? shown.join("\n") : "No models matched." };
    }
    if (verb === "ask") {
      if (!value) return { kind: "error", text: "Usage: /advisor ask <question>" };
      const advice = await consult(agent, `${USER_ASK_PREFIX}${value}`, { signal });
      return advice.status === "unavailable"
        ? { kind: "error", text: advice.text }
        : { kind: "success", text: `Advisor (${advice.model}):\n\n${adviceBody(advice.text)}` };
    }
    if (verb === "review") {
      if (value !== "on" && value !== "off") return { kind: "error", text: "Usage: /advisor review on|off" };
      return setOption({ autoReview: value === "on" }, `Automatic review before finishing: ${value}`);
    }
    if (verb === "failures" || verb === "limit") {
      const count = parseCount(value);
      if (count === undefined) return { kind: "error", text: `Usage: /advisor ${verb} <positive integer>|off` };
      return verb === "failures"
        ? setOption({ autoOnFailures: count }, `Automatic consultation after failures: ${count ? `${count} in a row` : "off"}`)
        : setOption({ maxConsultations: count }, `Consultations per session: ${count || "unlimited"}`);
    }
    if (rest.length && !trimmed.includes("/")) return { kind: "error", text: USAGE };
    try {
      const next = verb === "off" ? null : routeKey(await resolveRoute(ctx.llm, trimmed, signal));
      saved = await saveModel(configPath, next);
      selected = next;
      tuning = { ...saved, ...configTuning };
      configError = undefined;
      consultant.cancelAll();
      syncTool();
      return { kind: "success", text: next ? `Advisor set to ${next}. Consultations share the current conversation and use additional tokens.` : "Advisor off" };
    } catch (error) {
      return { kind: "error", text: (error as Error).message };
    }
  }

  ctx.commands.register({
    definitionId: "openadvisor/advisor",
    name: "advisor",
    description: "Choose an advisor, ask it a question, or configure automatic reviews",
    input: { hint: "provider/model-id | list | ask <question> | review on|off | failures <n>|off | off | status" },
    handler: (invocation) => command(invocation.rawInput, invocation.agent, invocation.signal),
  });

  syncTool();
  ctx.effect(() => () => { consultant.cancelAll(); }, "openadvisor in-flight consultations");
}
