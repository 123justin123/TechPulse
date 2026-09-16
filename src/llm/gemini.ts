import { ApiError, FinishReason, GoogleGenAI, ThinkingLevel } from "@google/genai";
import { z } from "zod";
import {
  type CompleteJsonParams,
  DEFAULT_EFFORT,
  DEFAULT_MAX_TOKENS,
  type Effort,
  isMalformedOutput,
  LlmError,
  type LlmProvider,
  type ModelChoice,
  malformedOutputError,
  type ProviderOptions,
  resolveModels,
  unexpectedError,
} from "./provider.js";

const THINKING_LEVELS: Record<Effort, ThinkingLevel> = {
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
  xhigh: ThinkingLevel.HIGH,
  max: ThinkingLevel.HIGH,
};

export class GeminiProvider implements LlmProvider {
  static readonly defaultModels: ModelChoice = { topic: "gemini-pro-latest", scoring: "gemini-pro-latest" };

  readonly models: ModelChoice;
  private readonly client: GoogleGenAI;

  constructor({ apiKey, models, baseUrl }: ProviderOptions) {
    this.models = resolveModels(GeminiProvider.defaultModels, models);
    this.client = new GoogleGenAI({ apiKey, ...(baseUrl ? { httpOptions: { baseUrl } } : {}) });
  }

  async completeJson<T>({
    system,
    prompt,
    schema,
    model,
    maxTokens = DEFAULT_MAX_TOKENS,
    effort = DEFAULT_EFFORT,
  }: CompleteJsonParams<T>): Promise<T> {
    const { $schema: _metaSchema, ...responseJsonSchema } = z.toJSONSchema(schema);

    const response = await this.client.models
      .generateContent({
        model,
        contents: prompt,
        config: {
          systemInstruction: system,
          maxOutputTokens: maxTokens,
          responseMimeType: "application/json",
          responseJsonSchema,
          thinkingConfig: { thinkingLevel: THINKING_LEVELS[effort] },
        },
      })
      .catch((error: unknown) => {
        throw toLlmError(error);
      });

    const blockReason = response.promptFeedback?.blockReason;
    if (blockReason) {
      throw new LlmError(`Request blocked by Gemini (${blockReason}).`, "content");
    }

    const finishReason = response.candidates?.[0]?.finishReason;
    if (finishReason === FinishReason.MAX_TOKENS) {
      throw new LlmError("Truncated response: maxOutputTokens reached.", "content");
    }
    if (finishReason && finishReason !== FinishReason.STOP) {
      throw new LlmError(`Generation stopped by Gemini (${finishReason}).`, "content");
    }

    const text = response.text;
    if (!text) {
      throw new LlmError("Gemini returned no text.", "content");
    }

    return parseOutput(text, schema);
  }
}

function parseOutput<T>(text: string, schema: z.ZodType<T>): T {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw malformedOutputError(error);
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new LlmError(
      `The model did not return JSON matching the schema: ${parsed.error.message}`,
      "content",
      parsed.error,
    );
  }
  return parsed.data;
}

function toLlmError(error: unknown): LlmError {
  if (isMalformedOutput(error)) {
    return malformedOutputError(error);
  }
  if (error instanceof ApiError) {
    const { status } = error;
    const message = readableApiMessage(error.message);
    if (status === 401 || status === 403) {
      return new LlmError("Gemini API key rejected.", "config", error);
    }
    if (status === 404) {
      return new LlmError(
        `Gemini model not found: check LLM_TOPIC_MODEL and LLM_SCORING_MODEL (${message}).`,
        "config",
        error,
      );
    }
    if (status === 429) {
      return new LlmError(`Gemini rate limit reached: ${message}`, "transient", error);
    }
    if (status >= 500) {
      return new LlmError(`Gemini API error ${status}: ${message}`, "transient", error);
    }
    return new LlmError(`Request rejected by the Gemini API (${status}): ${message}`, "config", error);
  }
  if (error instanceof TypeError) {
    return new LlmError(`Could not connect to the Gemini API: ${error.message}`, "transient", error);
  }
  return unexpectedError(error);
}

function readableApiMessage(rawMessage: string): string {
  try {
    const { error } = JSON.parse(rawMessage) as { error?: { message?: string } };
    return error?.message?.replace(/s+/g, " ").trim() || rawMessage;
  } catch {
    return rawMessage;
  }
}
