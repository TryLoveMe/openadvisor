// Minimal structural views of the DeepSeek Harness (dsh) services this plugin uses.
// Declared locally so the plugin has no runtime dependency on dsh packages and
// type-checks without a dsh checkout. Shapes follow dsh 0.2.x.

export type Dispose = () => void;

export interface TextBlock { type: "text"; text: string }

export interface TokenUsage { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }

export type StreamChunk =
  | { type: "block-start"; index: number; blockType: string }
  | { type: "text-delta"; index: number; text: string }
  | { type: "reasoning-delta"; index: number; text: string }
  | { type: "tool-call-delta"; index: number }
  | { type: "block-end"; index: number; block: { type: string; text?: string } }
  | { type: "usage"; usage: TokenUsage }
  | { type: "finish"; reason: { kind: string; failure?: { message: string; code?: string } } };

export interface GenerateOptions {
  provider: string;
  model: string;
  reasoningEffort?: string;
  system?: string;
  messages: { role: "user"; content: TextBlock[] }[];
  maxTokens?: number;
  signal?: AbortSignal;
  sessionId?: string;
}

export interface LlmService {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
  listProviders(): { id: string; name: string }[];
  listModels(provider: string): Promise<readonly { provider: string; id: string; name?: string }[]>;
}

export interface Session {
  readonly id: string;
  deriveMessages(): readonly unknown[];
}

export interface Agent { readonly id: string; readonly session: Session }

export interface ToolRunContext { readonly agent: Agent; readonly signal: AbortSignal }

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: Record<string, unknown>;
    render(args: unknown, value: unknown): TextBlock[];
  };
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
  isConcurrencySafe?(args: unknown): boolean;
  presentCall?(args: unknown): unknown;
}

export interface CommandInvocation { readonly agent: Agent; readonly rawInput: string; readonly signal: AbortSignal }

export type CommandResult = { kind: "success"; text?: string } | { kind: "error"; text: string };

export interface CommandDefinition {
  definitionId?: string;
  name: string;
  description: string;
  input?: { hint: string };
  handler(invocation: CommandInvocation): CommandResult | Promise<CommandResult>;
}

export interface PromptSection {
  name: string;
  order: number;
  text: string | ((context: unknown) => string);
  interpolate?: boolean;
  replacement?: string;
  retirement?: string;
}

export interface Context {
  tools: { register(definition: ToolDefinition): Dispose };
  commands: { register(definition: CommandDefinition): Dispose };
  systemPrompt: { section(section: PromptSection): Dispose; getSectionOrder(name: string): number };
  llm: LlmService;
  effect(execute: () => Dispose | void, label?: string): unknown;
}
