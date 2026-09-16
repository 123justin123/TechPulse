import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  type CompleteJsonParams,
  DEFAULT_EFFORT,
  DEFAULT_MAX_TOKENS,
  isMalformedOutput,
  LlmError,
  type LlmProvider,
  type ModelChoice,
  malformedOutputError,
  type ProviderOptions,
  resolveModels,
  unexpectedError,
} from "./provider.js";

export class AnthropicProvider implements LlmProvider {
  static readonly defaultModels: ModelChoice = { topic: "claude-opus-5", scoring: "claude-opus-5" };

  readonly models: ModelChoice;
  private readonly client: Anthropic;

  constructor({ apiKey, models, baseUrl }: ProviderOptions) {
    this.models = resolveModels(AnthropicProvider.defaultModels, models);
    this.client = new Anthropic({ apiKey, baseURL: baseUrl });
  }

  async completeJson<T>({
    system,
    prompt,
    schema,
    model,
    maxTokens = DEFAULT_MAX_TOKENS,
    effort = DEFAULT_EFFORT,
  }: CompleteJsonParams<T>): Promise<T> {
    const response = await this.client.messages
      .parse({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: prompt }],
        output_config: { effort, format: zodOutputFormat(schema) },
      })
      .catch((error: unknown) => {
        throw toLlmError(error);
      });

    if (response.stop_reason === "refusal") {
      const category = response.stop_details?.category ?? "unknown reason";
      throw new LlmError(`Request refused by the model (${category}).`, "content");
    }
    if (response.stop_reason === "max_tokens") {
      throw new LlmError("Truncated response: max_tokens reached.", "content");
    }
    if (!response.parsed_output) {
      throw malformedOutputError();
    }
    return response.parsed_output as T;
  }
}

function toLlmError(error: unknown): LlmError {
  if (isMalformedOutput(error)) {
    return malformedOutputError(error);
  }
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new LlmError("Anthropic API key rejected.", "config", error);
  }
  if (error instanceof Anthropic.NotFoundError) {
    return new LlmError(
      `Anthropic model not found: check LLM_TOPIC_MODEL and LLM_SCORING_MODEL (${error.message}).`,
      "config",
      error,
    );
  }
  if (error instanceof Anthropic.BadRequestError) {
    return new LlmError(`Request rejected by the Anthropic API: ${error.message}`, "config", error);
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new LlmError(`Anthropic rate limit reached: ${error.message}`, "transient", error);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new LlmError("Could not connect to the Anthropic API.", "transient", error);
  }
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 0;
    return new LlmError(
      `Anthropic API error ${status}: ${error.message}`,
      status >= 500 ? "transient" : "config",
      error,
    );
  }
  if (error instanceof Anthropic.AnthropicError) {
    return new LlmError(`Unusable model output: ${error.message}`, "content", error);
  }
  return unexpectedError(error);
}
