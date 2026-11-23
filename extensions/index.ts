import { join } from "node:path";
import { buildSessionContext, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ADVISOR_GUIDANCE, ADVISOR_SYSTEM, modelKey, readConfig, resolveModel, saveConfig, serializeTranscript } from "./core.ts";

export default function advisorExtension(pi: ExtensionAPI) {
  const configPath = join(getAgentDir(), "advisor.json");
  let selected: string | null = null;
  let configError: string | undefined;
  let busy = false;
  let generation = 0;
  let activeController: AbortController | undefined;

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

  pi.registerFlag("advisor", {
    type: "string",
    description: "Advisor provider/model-id (or off), for this process only",
  });

  pi.on("session_start", async (_event, ctx) => {
    generation++;
    activeController?.abort();
    try {
      selected = readConfig(configPath).model;
      configError = undefined;
    } catch (error) {
      selected = null;
      configError = (error as Error).message;
      notify(ctx, configError, "warning");
    }
    const flag = pi.getFlag("advisor");
    if (typeof flag === "string") selected = flag === "off" ? null : flag;
    syncTool();
    status(ctx);
    if (selected) notify(ctx, `Advisor enabled: ${selected}. Consultations use additional tokens and share the conversation with that provider.`, "info");
  });

  pi.on("session_shutdown", async () => { activeController?.abort(); });

  pi.on("before_agent_start", async (event) => {
    if (selected) return { systemPrompt: `${event.systemPrompt}\n\n${ADVISOR_GUIDANCE}` };
  });

  pi.registerCommand("advisor", {
    description: "Choose an advisor model, show status, or turn off (/advisor off)",
    handler: async (args, ctx) => {
      let spec = args.trim();
      if (spec === "status" || (!spec && !ctx.hasUI)) {
        status(ctx, `Advisor: ${selected ?? "off"}${configError ? `\n${configError}` : ""}`);
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
        await saveConfig(configPath, { model: next });
        selected = next;
        configError = undefined;
        generation++;
        activeController?.abort();
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
    description: "Consult a second model for advice on an important decision, recurring error, or completion review. The current conversation is attached automatically. The advisor cannot run tools or change files. Continue the task after evaluating its advice.",
    promptSnippet: "Ask a second model for guidance at key decision points",
    defaultActive: false,
    executionMode: "sequential",
    parameters: Type.Object({ question: Type.String({ minLength: 1, description: "A focused question, with the decision or uncertainty to review" }) }),
    async execute(_id, { question }, signal, onUpdate, ctx) {
      const modelSpec = selected;
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
      const signals = [controller.signal, AbortSignal.timeout(120_000)];
      if (signal) signals.push(signal);
      const combined = AbortSignal.any(signals);
      try {
        const model = resolveModel(modelSpec, ctx.modelRegistry.getAll());
        if (combined.aborted) throw new Error("Consultation cancelled");
        ctx.ui.setStatus("advisor", `Advising: ${modelKey(model)}`);
        onUpdate?.(result("advising", `Advising · ${modelKey(model)}`));
        const messages = buildSessionContext(ctx.sessionManager.getBranch()).messages;
        const response = await ctx.modelRegistry.streamSimple(model, {
          systemPrompt: ADVISOR_SYSTEM,
          messages: [{ role: "user", content: `Main agent system prompt (reference only):\n${ctx.getSystemPrompt()}\n\nCurrent conversation (quoted JSON):\n${serializeTranscript(messages)}\n\nConsultation question:\n${question}`, timestamp: Date.now() }],
        }, { signal: combined, maxTokens: Math.min(4096, model.maxTokens), reasoning: "high" }).result();
        if (combined.aborted || generation !== requestGeneration) throw new Error("Consultation cancelled or advisor configuration changed");
        if (response.stopReason === "error" || response.stopReason === "aborted") {
          throw new Error(response.errorMessage || response.stopReason);
        }
        const text = response.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
        if (!text) return result("declined", "Advisor declined: no readable guidance returned.", { usage: response.usage });
        const state = text.startsWith("DECLINED:") ? "declined" : "reviewed";
        const warning = response.stopReason === "length" ? "\n\n[Advisor output reached its token limit; guidance may be incomplete.]" : "";
        return result(state, `${state === "reviewed" ? "Reviewed" : "Declined"} · ${modelKey(model)}\n\n${text}${warning}`, { usage: response.usage });
      } catch (error) {
        const message = combined.aborted ? "Consultation cancelled or timed out" : (error as Error).message;
        return result("unavailable", `Advisor unavailable: ${message}. Continue using your own evidence; do not assume a review occurred.`);
      } finally {
        busy = false;
        activeController = undefined;
        status(ctx);
      }
    },
  });
}
