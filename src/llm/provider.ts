import type { ZodType } from "zod";

export const PROVIDER_NAMES = ["anthropic", "openai", "gemini"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export const DEFAULT_MAX_TOKENS = 16_000;
export const DEFAULT_EFFORT: Effort = "medium";

export interface ModelChoice {
  topic: string;
  scoring: string;
}

export interface ProviderOptions {
  apiKey: string;
  models?: Partial<ModelChoice>;
  baseUrl?: string;
}

export interface CompleteJsonParams<T> {
  system: string;
  prompt: string;
  schema: ZodType<T>;
  model: string;
  maxTokens?: number;
  effort?: Effort;
}

export interface LlmProvider {
  readonly models: ModelChoice;
  completeJson<T>(params: CompleteJsonParams<T>): Promise<T>;
}

export type LlmErrorKind = "config" | "transient" | "content";

export class LlmError extends Error {
  override readonly name = "LlmError";

  constructor(
    message: string,
    readonly kind: LlmErrorKind,
    cause?: unknown,
  ) {
    super(message, { cause });
  }
}

export function isMalformedOutput(error: unknown): boolean {
  return error instanceof SyntaxError || (error instanceof Error && error.name === "ZodError");
}

export function malformedOutputError(cause?: unknown): LlmError {
  return new LlmError("The model did not return JSON matching the schema.", "content", cause);
}

export function unexpectedError(error: unknown): LlmError {
  const message = error instanceof Error ? error.message : String(error);
  return new LlmError(`Unexpected error: ${message}`, "config", error);
}

export function resolveModels(defaults: ModelChoice, overrides: Partial<ModelChoice> = {}): ModelChoice {
  return {
    topic: overrides.topic || defaults.topic,
    scoring: overrides.scoring || defaults.scoring,
  };
}
