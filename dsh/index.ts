// DeepSeek Harness (dsh) plugin: the same advisor tool and /advisor command as the Pi extension.
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ADVISOR_GUIDANCE, ADVISOR_SYSTEM, QUESTION_DESCRIPTION, TOOL_DESCRIPTION, UsageTally,
  consultationPrompt, formatDuration, interpretAdvice, matchModels, parseConfig, readConfig, resolveModel, saveModel,
  serializeTranscript, settingsOf, unavailable, type Advice, type AdvisorConfig,
} from "../extensions/core.ts";
import type { CommandResult, Context, Dispose, LlmService, ToolDefinition, ToolRunContext } from "./types.ts";

export const name = "pi-advisor";
export const inject = ["tools", "llm", "commands", "systemPrompt"];

export interface DshAdvisorConfig {
  /** Advisor as provider/model-id. Overrides the saved choice; "off" or null disables. Omit to use the saved choice. */
  model?: string | null;
  maxTokens?: number;
  timeoutMs?: number;
  /** dsh reasoning effort id passed to the adapter; omit for the adapter default. */
  reasoning?: string;
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
  const parsed = parseConfig({ ...raw, model: raw.model === "off" ? null : raw.model ?? null });
  if (raw.model !== undefined) result.model = parsed.model;
  if (parsed.maxTokens !== undefined) result.maxTokens = parsed.maxTokens;
  if (parsed.timeoutMs !== undefined) result.timeoutMs = parsed.timeoutMs;
  if (parsed.reasoning !== undefined) result.reasoning = parsed.reasoning;
  return result;
}

/** Standard Schema implementation, as Cordis requires for an exported Config. */
export const Config = {
  "~standard": {
    version: 1 as const,
    vendor: "pi-advisor",
    validate(value: unknown) {
      try { return { value: parseDshConfig(value) }; }
      catch (error) { return { issues: [{ message: `pi-advisor: ${(error as Error).message}` }] }; }
    },
  },
};

export function defaultConfigPath(env: Record<string, string | undefined> = process.env): string {
  const home = env.DSH_HOME?.trim();
  return join(home ? home : join(homedir(), ".dsh"), "advisor.json");
}

interface Route { provider: string; model: string }

function numericFields(value: object): Record<string, number> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => typeof entry === "number" && Number.isFinite(entry)));
}

const routeKey = (route: Route) => `${route.provider}/${route.model}`;

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

export function apply(ctx: Context, config: DshAdvisorConfig = {}) {
  const configPath = config.configPath ?? defaultConfigPath();
  let saved: AdvisorConfig = { model: null };
  let configError: string | undefined;
  try { saved = readConfig(configPath); }
  catch (error) { configError = (error as Error).message; console.warn(`[pi-advisor] ${configError}`); }

  let selected: string | null = config.model !== undefined ? config.model : saved.model;
  let tuning: AdvisorConfig = { ...saved, ...config, model: selected };
  const tally = new UsageTally();
  const busy = new Set<string>();
  const controllers = new Set<AbortController>();
  let generation = 0;
  let disposeTool: Dispose | undefined;

  const limits = () => settingsOf(tuning);
  const reasoningEffort = () => tuning.reasoning && tuning.reasoning !== "off" ? tuning.reasoning : undefined;

  function cancelInFlight() {
    generation++;
    for (const controller of controllers) controller.abort();
  }

  function currentRoute(): Route {
    if (!selected) throw new Error("advisor is off");
    const route = splitRoute(selected, ctx.llm.listProviders().map((provider) => provider.id));
    if (!route) throw new Error(`advisor model "${selected}" does not name a registered provider; run /advisor provider/model-id`);
    return route;
  }

  async function consult(question: string, exec: ToolRunContext): Promise<Advice & { model: string | null; usage?: Record<string, number> }> {
    const modelSpec = selected;
    if (!modelSpec) return { ...unavailable("advisor is off; ask the user to configure /advisor"), model: null };
    const sessionId = exec.agent.session.id;
    if (busy.has(sessionId)) return { ...unavailable("another advisor consultation is in progress"), model: modelSpec };
    const requestGeneration = generation;
    const { maxTokens, timeoutMs } = limits();
    const controller = new AbortController();
    const combined = AbortSignal.any([controller.signal, exec.signal, AbortSignal.timeout(timeoutMs)]);
    busy.add(sessionId);
    controllers.add(controller);
    try {
      const route = currentRoute();
      combined.throwIfAborted();
      const prompt = consultationPrompt({ transcript: serializeTranscript(exec.agent.session.deriveMessages()), question });
      const effort = reasoningEffort();
      const texts = new Map<number, string>();
      let finish: { kind: string; failure?: { message: string } } | undefined;
      let usage: Record<string, number> | undefined;
      for await (const chunk of ctx.llm.stream({
        provider: route.provider,
        model: route.model,
        system: ADVISOR_SYSTEM,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
        maxTokens,
        signal: combined,
        sessionId,
        ...(effort ? { reasoningEffort: effort } : {}),
      })) {
        if (chunk.type === "text-delta") texts.set(chunk.index, (texts.get(chunk.index) ?? "") + chunk.text);
        else if (chunk.type === "block-end" && chunk.block.type === "text" && typeof chunk.block.text === "string") texts.set(chunk.index, chunk.block.text);
        else if (chunk.type === "usage") usage = numericFields(chunk.usage);
        else if (chunk.type === "finish") finish = chunk.reason;
      }
      if (combined.aborted || generation !== requestGeneration) throw new Error("consultation cancelled or advisor configuration changed");
      if (!finish) throw new Error("model stream ended without finishing");
      if (finish.kind === "error" || finish.kind === "aborted") throw new Error(finish.failure?.message || finish.kind);
      tally.add({ input: (usage?.inputTokens ?? 0) + (usage?.cacheReadTokens ?? 0) + (usage?.cacheWriteTokens ?? 0), output: usage?.outputTokens });
      const text = [...texts.entries()].sort(([a], [b]) => a - b).map(([, value]) => value).join("\n");
      return { ...interpretAdvice(routeKey(route), text, finish.kind === "max-tokens"), model: routeKey(route), ...(usage ? { usage } : {}) };
    } catch (error) {
      const timedOut = combined.aborted && !controller.signal.aborted && !exec.signal.aborted;
      // Let the registry record a caller cancellation as a tool abort.
      if (exec.signal.aborted) throw exec.signal.reason ?? error;
      const reason = timedOut ? `timed out after ${formatDuration(timeoutMs)}`
        : combined.aborted ? "consultation cancelled" : (error as Error).message;
      return { ...unavailable(reason), model: modelSpec };
    } finally {
      busy.delete(sessionId);
      controllers.delete(controller);
    }
  }

  const tool: ToolDefinition = {
    name: "advisor",
    description: TOOL_DESCRIPTION,
    parameters: {
      type: "object",
      properties: { question: { type: "string", description: QUESTION_DESCRIPTION } },
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
      const question = (args as { question?: unknown } | null)?.question;
      if (typeof question !== "string" || !question.trim()) {
        return { ...unavailable("the question argument must be a nonempty string"), model: selected };
      }
      return consult(question.trim(), exec);
    },
  };

  function syncTool() {
    if (selected && !disposeTool) disposeTool = ctx.tools.register(tool);
    else if (!selected && disposeTool) { const dispose = disposeTool; disposeTool = undefined; dispose(); }
  }

  let order = 2850;
  try { order = ctx.systemPrompt.getSectionOrder("TOOL_SUBAGENT") + 50; } catch { /* keep the fallback position */ }
  ctx.systemPrompt.section({
    name: "pi-advisor:guidance",
    order,
    interpolate: false,
    replacement: "",
    text: () => selected ? ADVISOR_GUIDANCE : "",
  });

  function describe(): string {
    const { maxTokens, timeoutMs } = limits();
    const lines = [`Advisor: ${selected ?? "off"}`];
    if (selected) lines.push(`Limits: ${maxTokens} output tokens, ${formatDuration(timeoutMs)}, reasoning ${reasoningEffort() ?? "adapter default"}`);
    if (config.model !== undefined) lines.push("The model is set in cordis.yml; /advisor changes apply to this process and the saved default.");
    lines.push(tally.describe());
    if (configError) lines.push(configError);
    return lines.join("\n");
  }

  async function command(input: string, signal: AbortSignal): Promise<CommandResult> {
    const [verb, ...rest] = input.trim().split(/\s+/);
    if (!verb || verb === "status") return { kind: "success", text: `${describe()}\n\nUsage: /advisor provider/model-id | list [filter] | off | status` };
    if (verb === "list") {
      const keys = (await listAll(ctx.llm, signal)).map((model) => `${model.provider}/${model.id}`).sort();
      const shown = matchModels(rest.join(" "), keys, 200);
      return { kind: "success", text: shown.length ? shown.join("\n") : "No models matched." };
    }
    try {
      const next = verb === "off" ? null : routeKey(await resolveRoute(ctx.llm, input.trim(), signal));
      const saved = await saveModel(configPath, next);
      selected = next;
      tuning = { ...saved, ...config, model: next };
      configError = undefined;
      cancelInFlight();
      syncTool();
      return { kind: "success", text: next ? `Advisor set to ${next}. Consultations share the current conversation and use additional tokens.` : "Advisor off" };
    } catch (error) {
      return { kind: "error", text: (error as Error).message };
    }
  }

  ctx.commands.register({
    definitionId: "pi-advisor/advisor",
    name: "advisor",
    description: "Choose an advisor model, list models, show status, or turn off",
    input: { hint: "provider/model-id | list | off | status" },
    handler: (invocation) => command(invocation.rawInput, invocation.signal),
  });

  syncTool();
  ctx.effect(() => () => { cancelInFlight(); }, "pi-advisor in-flight consultations");
}
