import { join } from "node:path";
import { buildSessionContext, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  ADVISOR_GUIDANCE, ADVISOR_SYSTEM, QUESTION_DESCRIPTION, TOOL_DESCRIPTION, UsageTally,
  consultationPrompt, formatDuration, interpretAdvice, matchModels, modelKey, readConfig, resolveModel, saveModel,
  serializeTranscript, settingsOf, unavailable, type AdvisorSettings,
} from "./core.ts";

type Registry = ExtensionContext["modelRegistry"];

export default function advisorExtension(pi: ExtensionAPI) {
  const configPath = join(getAgentDir(), "advisor.json");
  let selected: string | null = null;
  let settings: AdvisorSettings = settingsOf({});
  let configError: string | undefined;
  let busy = false;
  let generation = 0;
  let activeController: AbortController | undefined;
  let registry: Registry | undefined;
  const tally = new UsageTally();

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

  function cancelInFlight() {
    generation++;
    activeController?.abort();
  }

  function describe(): string {
    const lines = [`Advisor: ${selected ?? "off"}`];
    if (selected) lines.push(`Limits: ${settings.maxTokens} output tokens, ${formatDuration(settings.timeoutMs)}, reasoning ${settings.reasoning}`);
    lines.push(tally.describe());
    if (configError) lines.push(configError);
    return lines.join("\n");
  }

  pi.registerFlag("advisor", {
    type: "string",
    description: "Advisor provider/model-id (or off), for this process only",
  });

  pi.on("session_start", async (_event, ctx) => {
    cancelInFlight();
    registry = ctx.modelRegistry;
    tally.reset();
    try {
      const config = readConfig(configPath);
      selected = config.model;
      settings = settingsOf(config);
      configError = undefined;
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

  pi.on("session_shutdown", async () => { cancelInFlight(); });

  pi.on("before_agent_start", async (event) => {
    if (selected) return { systemPrompt: `${event.systemPrompt}\n\n${ADVISOR_GUIDANCE}` };
  });

  pi.registerCommand("advisor", {
    description: "Choose an advisor model, show status, or turn off (/advisor off)",
    getArgumentCompletions: (prefix) => {
      const keys = ["off", "status", ...(registry?.getAvailable().map(modelKey).sort() ?? [])];
      const items = matchModels(prefix, keys).map((value) => ({ value, label: value }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      registry = ctx.modelRegistry;
      let spec = args.trim();
      if (spec === "status" || (!spec && !ctx.hasUI)) {
        status(ctx, describe());
        return;
      }
      if (!spec) {
        const options = ["off", ...ctx.modelRegistry.getAvailable().map(modelKey).sort()];
        const choice = await ctx.ui.select(`Advisor (current: ${selected ?? "off"})`, options);
        if (!choice) return;
        spec = choice;
      }
      try {
        const next = spec === "off" ? null : modelKey(resolveModel(spec, ctx.modelRegistry.getAll()));
        const saved = await saveModel(configPath, next);
        selected = next;
        settings = settingsOf(saved);
        configError = undefined;
        cancelInFlight();
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
    parameters: Type.Object({ question: Type.String({ minLength: 1, description: QUESTION_DESCRIPTION }) }),
    async execute(_id, { question }, signal, onUpdate, ctx) {
      const modelSpec = selected;
      const limits = settings;
      const requestGeneration = generation;
      const result = (state: string, text: string, extra = {}) => ({
        content: [{ type: "text" as const, text }],
        details: { status: state, model: modelSpec, ...extra },
      });
      if (!modelSpec) return result("unavailable", "Advisor is off. Continue independently or ask the user to configure /advisor.");
      if (busy) return result("unavailable", "Another advisor consultation is in progress.");
      busy = true;
      const controller = new AbortController();
      activeController = controller;
      const signals = [controller.signal, AbortSignal.timeout(limits.timeoutMs)];
      if (signal) signals.push(signal);
      const combined = AbortSignal.any(signals);
      try {
        const model = resolveModel(modelSpec, ctx.modelRegistry.getAll());
        if (combined.aborted) throw new Error("Consultation cancelled");
        ctx.ui.setStatus("advisor", `Advising: ${modelKey(model)}`);
        onUpdate?.(result("advising", `Advising · ${modelKey(model)}`));
        const messages = buildSessionContext(ctx.sessionManager.getBranch()).messages;
        const reasoning = model.reasoning && limits.reasoning !== "off" ? limits.reasoning as "high" : undefined;
        const response = await ctx.modelRegistry.streamSimple(model, {
          systemPrompt: ADVISOR_SYSTEM,
          messages: [{
            role: "user",
            content: consultationPrompt({ systemPrompt: ctx.getSystemPrompt(), transcript: serializeTranscript(messages), question }),
            timestamp: Date.now(),
          }],
        }, { signal: combined, maxTokens: Math.min(limits.maxTokens, model.maxTokens), reasoning }).result();
        if (combined.aborted || generation !== requestGeneration) throw new Error("Consultation cancelled or advisor configuration changed");
        if (response.stopReason === "error" || response.stopReason === "aborted") {
          throw new Error(response.errorMessage || response.stopReason);
        }
        const usage = response.usage;
        tally.add({ input: usage?.input, output: usage?.output, cost: usage?.cost?.total });
        const text = response.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
        const advice = interpretAdvice(modelKey(model), text, response.stopReason === "length");
        return result(advice.status, advice.text, { usage });
      } catch (error) {
        const timedOut = !controller.signal.aborted && !signal?.aborted && combined.aborted;
        const reason = timedOut ? `timed out after ${formatDuration(limits.timeoutMs)}`
          : combined.aborted ? "consultation cancelled" : (error as Error).message;
        const advice = unavailable(reason);
        return result(advice.status, advice.text);
      } finally {
        busy = false;
        if (activeController === controller) activeController = undefined;
        status(ctx);
      }
    },
  });
}
