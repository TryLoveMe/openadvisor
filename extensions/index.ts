import { join } from "node:path";
import { buildSessionContext, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  ADVISOR_GUIDANCE, ADVISOR_SYSTEM, CONTEXT_DESCRIPTION, Consultant, QUESTION_DESCRIPTION, REVIEW_QUESTION,
  TOOL_DESCRIPTION, USER_ASK_PREFIX, adviceBody, consultationPrompt, failureNote, failureQuestion, formatDuration,
  matchModels, modelKey, readConfig, resolveModel, reviewMessage, saveModel, serializeTranscript, settingsOf,
  unavailable, updateConfig, type AdvisorConfig, type AdvisorSettings, type Consultation,
} from "./core.ts";

type Registry = ExtensionContext["modelRegistry"];

const SESSION = "session";
const SUBCOMMANDS = ["off", "status", "ask ", "review on", "review off", "failures 3", "failures off", "limit 20", "limit off"];
const USAGE = "Usage: /advisor [provider/model-id | off | status | ask <question> | review on|off | failures <n>|off | limit <n>|off]";

export default function advisorExtension(pi: ExtensionAPI) {
  const configPath = join(getAgentDir(), "advisor.json");
  let selected: string | null = null;
  let settings: AdvisorSettings = settingsOf({});
  let configError: string | undefined;
  let registry: Registry | undefined;
  const consultant = new Consultant();
  // Per user request: tool calls made, consecutive failures, and whether the final review ran.
  let toolCalls = 0;
  let failureStreak = 0;
  let reviewed = false;

  function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") {
    if (ctx.hasUI) ctx.ui.notify(message, level);
    else process.stderr.write(`${message}\n`);
  }

  function status(ctx: ExtensionContext, message?: string) {
    ctx.ui.setStatus("advisor", selected ? `Advisor: ${selected}` : undefined);
    if (message) notify(ctx, message);
  }

  function syncTool() {
    const active = pi.getActiveTools().filter((name) => name !== "advisor");
    if (selected) active.push("advisor");
    pi.setActiveTools(active);
  }

  function describe(): string {
    const lines = [`Advisor: ${selected ?? "off"}`];
    if (selected) {
      lines.push(`Limits: ${settings.maxTokens} output tokens, ${formatDuration(settings.timeoutMs)}, reasoning ${settings.reasoning}`);
      lines.push(`Auto review before finishing: ${settings.autoReview ? `on (requests with ${settings.reviewMinToolCalls}+ tool calls)` : "off"}`);
      lines.push(`Auto consult after failures: ${settings.autoOnFailures ? `${settings.autoOnFailures} in a row` : "off"}`);
      lines.push(`Session limit: ${settings.maxConsultations ? `${consultant.used(SESSION)}/${settings.maxConsultations}` : `${consultant.used(SESSION)} used, unlimited`}`);
    }
    lines.push(consultant.tally.describe());
    if (configError) lines.push(configError);
    return lines.join("\n");
  }

  /** Run one consultation over the current branch. Never throws. */
  async function consult(ctx: ExtensionContext, question: string, options: { context?: string; signal?: AbortSignal } = {}): Promise<Consultation<{ usage: unknown }>> {
    const modelSpec = selected;
    if (!modelSpec) return { ...unavailable("advisor is off; ask the user to configure /advisor"), model: "off" };
    let model;
    try { model = resolveModel(modelSpec, ctx.modelRegistry.getAll()); }
    catch (error) { return { ...unavailable((error as Error).message), model: modelSpec }; }
    const limits = settings;
    try {
      return await consultant.consult({
        key: SESSION,
        model: modelKey(model),
        timeoutMs: limits.timeoutMs,
        maxConsultations: limits.maxConsultations,
        signal: options.signal,
        call: async (signal) => {
          ctx.ui.setStatus("advisor", `Advising: ${modelKey(model)}`);
          const messages = buildSessionContext(ctx.sessionManager.getBranch()).messages;
          const reasoning = model.reasoning && limits.reasoning !== "off" ? limits.reasoning as "high" : undefined;
          const response = await ctx.modelRegistry.streamSimple(model, {
            systemPrompt: ADVISOR_SYSTEM,
            messages: [{
              role: "user",
              content: consultationPrompt({ systemPrompt: ctx.getSystemPrompt(), transcript: serializeTranscript(messages), question, context: options.context }),
              timestamp: Date.now(),
            }],
          }, { signal, maxTokens: Math.min(limits.maxTokens, model.maxTokens), reasoning }).result();
          if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error(response.errorMessage || response.stopReason);
          return {
            text: response.content.filter((block) => block.type === "text").map((block) => block.text).join("\n"),
            truncated: response.stopReason === "length",
            usage: { input: response.usage?.input, output: response.usage?.output, cost: response.usage?.cost?.total },
            details: { usage: response.usage },
          };
        },
      });
    } finally {
      status(ctx);
    }
  }

  function applyConfig(config: AdvisorConfig) {
    settings = settingsOf(config);
    configError = undefined;
  }

  pi.registerFlag("advisor", {
    type: "string",
    description: "Advisor provider/model-id (or off), for this process only",
  });

  pi.on("session_start", async (_event, ctx) => {
    consultant.reset();
    registry = ctx.modelRegistry;
    toolCalls = failureStreak = 0;
    reviewed = false;
    try {
      const config = readConfig(configPath);
      selected = config.model;
      applyConfig(config);
    } catch (error) {
      selected = null;
      settings = settingsOf({});
      configError = (error as Error).message;
      notify(ctx, configError, "warning");
    }
    const flag = pi.getFlag("advisor");
    if (typeof flag === "string" && flag.trim()) selected = flag.trim() === "off" ? null : flag.trim();
    if (selected) {
      // Normalize bare IDs and catch typos at startup instead of at the first consultation.
      try { selected = modelKey(resolveModel(selected, ctx.modelRegistry.getAll())); }
      catch (error) { notify(ctx, `${(error as Error).message} Consultations will fail until it is fixed.`, "warning"); }
    }
    syncTool();
    status(ctx);
    if (selected) notify(ctx, `Advisor enabled: ${selected}. Consultations use additional tokens and share the conversation with that provider.`, "info");
  });

  pi.on("session_shutdown", async () => { consultant.cancelAll(); });

  pi.on("before_agent_start", async (event) => {
    if (event.messageType !== "custom") {
      toolCalls = failureStreak = 0;
      reviewed = false;
    }
    if (selected) return { systemPrompt: `${event.systemPrompt}\n\n${ADVISOR_GUIDANCE}` };
  });

  pi.on("tool_execution_end", async (event) => {
    if (event.toolName !== "advisor") toolCalls++;
  });

  // Automatic consultation after repeated failures: the advice rides on the failing tool result.
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName === "advisor") return;
    if (!event.isError) { failureStreak = 0; return; }
    failureStreak++;
    const threshold = settings.autoOnFailures;
    if (!selected || threshold <= 0 || failureStreak < threshold) return;
    const count = failureStreak;
    failureStreak = 0;
    const error = event.content.map((block) => block.type === "text" ? block.text : "[image]").join("\n");
    const advice = await consult(ctx, failureQuestion(count, event.toolName, error), { signal: ctx.signal });
    if (advice.status !== "reviewed") return;
    return { content: [...event.content, { type: "text" as const, text: failureNote(count, advice.text) }] };
  });

  // Automatic review before the agent hands back: gaps become one more turn of work.
  pi.on("agent_before_settle", async (event, ctx) => {
    if (!selected || !settings.autoReview || reviewed || event.continue || event.outcome !== "completed") return;
    // context.canContinue is false here (the transcript ends with the reply); the appended review makes it continuable.
    if (toolCalls < settings.reviewMinToolCalls) return;
    reviewed = true;
    const advice = await consult(ctx, REVIEW_QUESTION, { signal: ctx.signal });
    if (advice.verdict === "needs_work") {
      return {
        entries: [...event.entries, {
          type: "custom_message" as const,
          customType: "advisor-review",
          content: reviewMessage(advice.model, advice.text),
          display: true,
          details: { status: advice.status, model: advice.model, verdict: advice.verdict },
        }],
        continue: true,
      };
    }
    if (advice.verdict === "complete") notify(ctx, `Advisor review (${advice.model}): complete.`);
    else notify(ctx, `Advisor review did not run: ${advice.text}`, "warning");
  });

  async function setOption(ctx: ExtensionContext, patch: Partial<AdvisorConfig>, message: string) {
    try {
      applyConfig(await updateConfig(configPath, patch));
      status(ctx, message);
    } catch (error) {
      notify(ctx, (error as Error).message, "error");
    }
  }

  function parseCount(value: string): number | undefined {
    if (value === "off") return 0;
    const count = Number(value);
    return Number.isInteger(count) && count > 0 ? count : undefined;
  }

  pi.registerCommand("advisor", {
    description: "Choose an advisor, ask it a question, or configure automatic reviews",
    getArgumentCompletions: (prefix) => {
      const keys = [...SUBCOMMANDS, ...(registry?.getAvailable().map(modelKey).sort() ?? [])];
      const items = matchModels(prefix, keys).map((value) => ({ value, label: value.trim() }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      registry = ctx.modelRegistry;
      const input = args.trim();
      const [verb = "", ...rest] = input.split(/\s+/);
      const value = rest.join(" ");
      if (verb === "status" || (!input && !ctx.hasUI)) return status(ctx, describe());
      if (verb === "ask") {
        if (!value) return notify(ctx, "Usage: /advisor ask <question>", "error");
        const advice = await consult(ctx, `${USER_ASK_PREFIX}${value}`, { signal: ctx.signal });
        return notify(ctx, advice.status === "unavailable" ? advice.text : `Advisor (${advice.model}):\n\n${adviceBody(advice.text)}`,
          advice.status === "unavailable" ? "warning" : "info");
      }
      if (verb === "review") {
        if (value !== "on" && value !== "off") return notify(ctx, "Usage: /advisor review on|off", "error");
        return setOption(ctx, { autoReview: value === "on" }, `Automatic review before finishing: ${value}`);
      }
      if (verb === "failures" || verb === "limit") {
        const count = parseCount(value);
        if (count === undefined) return notify(ctx, `Usage: /advisor ${verb} <positive integer>|off`, "error");
        return verb === "failures"
          ? setOption(ctx, { autoOnFailures: count }, `Automatic consultation after failures: ${count ? `${count} in a row` : "off"}`)
          : setOption(ctx, { maxConsultations: count }, `Consultations per session: ${count || "unlimited"}`);
      }
      let spec = input;
      if (!spec) {
        const options = ["off", ...ctx.modelRegistry.getAvailable().map(modelKey).sort()];
        const choice = await ctx.ui.select(`Advisor (current: ${selected ?? "off"})`, options);
        if (!choice) return;
        spec = choice;
      }
      if (spec.includes(" ")) return notify(ctx, USAGE, "error");
      try {
        const next = spec === "off" ? null : modelKey(resolveModel(spec, ctx.modelRegistry.getAll()));
        const saved = await saveModel(configPath, next);
        selected = next;
        applyConfig(saved);
        consultant.cancelAll();
        syncTool();
        status(ctx, next ? `Advisor set to ${next}. Consultations share the current conversation and use additional tokens.` : "Advisor off");
      } catch (error) {
        notify(ctx, (error as Error).message, "error");
      }
    },
  });

  pi.registerTool({
    name: "advisor",
    label: "Advisor",
    description: TOOL_DESCRIPTION,
    promptSnippet: "Ask a second model for guidance at key decision points",
    defaultActive: false,
    executionMode: "sequential",
    parameters: Type.Object({
      question: Type.String({ minLength: 1, description: QUESTION_DESCRIPTION }),
      context: Type.Optional(Type.String({ description: CONTEXT_DESCRIPTION })),
    }),
    async execute(_id, { question, context }, signal, onUpdate, ctx) {
      if (selected) onUpdate?.({ content: [{ type: "text", text: `Advising · ${selected}` }], details: { status: "advising", model: selected } });
      const advice = await consult(ctx, question, { context, signal });
      return {
        content: [{ type: "text" as const, text: advice.text }],
        details: { status: advice.status, model: advice.status === "unavailable" && !selected ? null : advice.model, ...(advice.details ?? {}) },
      };
    },
  });
}
