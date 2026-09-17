import type { Config } from "../config/config.js";
import { AnthropicProvider } from "./anthropic.js";
import { GeminiProvider } from "./gemini.js";
import { OpenAiProvider } from "./openai.js";
import type { LlmProvider, ProviderName, ProviderOptions } from "./provider.js";

type ProviderConstructor = new (options: ProviderOptions) => LlmProvider;

const PROVIDERS: Record<ProviderName, ProviderConstructor> = {
  anthropic: AnthropicProvider,
  openai: OpenAiProvider,
  gemini: GeminiProvider,
};

export function createLlmProvider({ provider, apiKey, models }: Config["llm"]): LlmProvider {
  return new PROVIDERS[provider]({ apiKey, models });
}
