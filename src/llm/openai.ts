import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
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

const OUTPUT_FORMAT_NAME = "techpulse_output";

export class OpenAiProvider implements LlmProvider {
  static readonly defaultModels: ModelChoice = { topic: "gpt-5.5", scoring: "gpt-5.5" };

  readonly models: ModelChoice;
  private readonly client: OpenAI;

  constructor({ apiKey, models, baseUrl }: ProviderOptions) {
    this.models = resolveModels(OpenAiProvider.defaultModels, models);
    this.client = new OpenAI({ apiKey, baseURL: baseUrl });
  }

  async completeJson<T>({
    system,
    prompt,
    schema,
    model,
    maxTokens = DEFAULT_MAX_TOKENS,
    effort = DEFAULT_EFFORT,
  }: CompleteJsonParams<T>): Promise<T> {
    const response = await this.client.responses
      .parse({
        model,
        instructions: system,
        input: prompt,
        max_output_tokens: maxTokens,
        reasoning: { effort },
        text: { format: zodTextFormat(schema, OUTPUT_FORMAT_NAME) },
      })
      .catch((error: unknown) => {
        throw toLlmError(error);
      });

    const refusal = response.output
      .flatMap((item) => (item.type === "message" ? item.content : []))
      .find((part) => part.type === "refusal");
    if (refusal) {
      throw new LlmError(`Request refused by the model: ${refusal.refusal}`, "content");
    }

    if (response.status === "incomplete") {
      const reason = response.incomplete_details?.reason ?? "unknown reason";
      throw new LlmError(`Incomplete response (${reason}).`, "content");
    }
    if (response.output_parsed === null) {
      throw malformedOutputError();
    }
    return response.output_parsed as T;
  }
}

function toLlmError(error: unknown): LlmError {
  if (isMalformedOutput(error)) {
    return malformedOutputError(error);
  }
  if (error instanceof OpenAI.AuthenticationError || error instanceof OpenAI.PermissionDeniedError) {
    return new LlmError("OpenAI API key rejected.", "config", error);
  }
  if (error instanceof OpenAI.NotFoundError) {
    return new LlmError(
      `OpenAI model not found: check LLM_TOPIC_MODEL and LLM_SCORING_MODEL (${error.message}).`,
      "config",
      error,
    );
  }
  if (error instanceof OpenAI.BadRequestError) {
    return new LlmError(`Request rejected by the OpenAI API: ${error.message}`, "config", error);
  }
  if (error instanceof OpenAI.RateLimitError) {
    return new LlmError(`OpenAI rate limit reached: ${error.message}`, "transient", error);
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return new LlmError("Could not connect to the OpenAI API.", "transient", error);
  }
  if (error instanceof OpenAI.APIError) {
    const status = error.status ?? 0;
    return new LlmError(`OpenAI API error ${status}: ${error.message}`, status >= 500 ? "transient" : "config", error);
  }
  return unexpectedError(error);
}
