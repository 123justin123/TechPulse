import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { z } from "zod";
import { AnthropicProvider } from "../../src/llm/anthropic.js";
import { GeminiProvider } from "../../src/llm/gemini.js";
import { OpenAiProvider } from "../../src/llm/openai.js";
import { LlmError, type LlmErrorKind, type LlmProvider, type ProviderOptions } from "../../src/llm/provider.js";
import { type RecordedRequest, type ServerReply, startServer } from "../support/helpers.js";

type Mode = "ok" | "refusal" | "invalid_json" | "server_error" | "not_found" | "unauthorized";

const ANSWER = { label: "Finance", score: 7 };
const Schema = z.object({ label: z.string().describe("Short name."), score: z.number().int().min(0).max(10) });

interface Dialect {
  name: string;
  create: (options: ProviderOptions) => LlmProvider;
  baseUrl: (server: string) => string;
  defaults: { topic: string; scoring: string };
  matches: (url: string) => boolean;
  system: (request: RecordedRequest) => string;
  prompt: (request: RecordedRequest) => string;
  model: (request: RecordedRequest) => string | undefined;
  effort: (request: RecordedRequest) => unknown;
  highEffort: unknown;
  schemaSent: (request: RecordedRequest) => boolean;
  reply: (text: string) => unknown;
  refusal: () => unknown;
}

const DIALECTS: Dialect[] = [
  {
    name: "anthropic",
    create: (options) => new AnthropicProvider(options),
    baseUrl: (server) => server,
    defaults: AnthropicProvider.defaultModels,
    matches: (url) => url.startsWith("/v1/messages"),
    system: (request) => request.body.system,
    prompt: (request) => request.body.messages[0].content,
    model: (request) => request.body.model,
    effort: (request) => request.body.output_config?.effort,
    highEffort: "high",
    schemaSent: (request) => request.body.output_config?.format?.type === "json_schema",
    reply: (text) => ({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "mock",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
    }),
    refusal: () => ({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "mock",
      content: [],
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "cyber", explanation: "test" },
      usage: { input_tokens: 10, output_tokens: 0 },
    }),
  },
  {
    name: "openai",
    create: (options) => new OpenAiProvider(options),
    baseUrl: (server) => `${server}/v1`,
    defaults: OpenAiProvider.defaultModels,
    matches: (url) => url.startsWith("/v1/responses"),
    system: (request) => request.body.instructions,
    prompt: (request) => request.body.input,
    model: (request) => request.body.model,
    effort: (request) => request.body.reasoning?.effort,
    highEffort: "high",
    schemaSent: (request) =>
      request.body.text?.format?.type === "json_schema" && request.body.text.format.strict === true,
    reply: (text) => ({
      id: "resp_test",
      object: "response",
      created_at: 0,
      status: "completed",
      model: "mock",
      output: [
        {
          type: "message",
          id: "msg_test",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      ],
      incomplete_details: null,
      error: null,
      usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
    }),
    refusal: () => ({
      id: "resp_test",
      object: "response",
      created_at: 0,
      status: "completed",
      model: "mock",
      output: [
        {
          type: "message",
          id: "msg_test",
          status: "completed",
          role: "assistant",
          content: [{ type: "refusal", refusal: "I cannot help with this request." }],
        },
      ],
      incomplete_details: null,
      error: null,
    }),
  },
  {
    name: "gemini",
    create: (options) => new GeminiProvider(options),
    baseUrl: (server) => server,
    defaults: GeminiProvider.defaultModels,
    matches: (url) => url.includes(":generateContent"),
    system: (request) => request.body.systemInstruction?.parts?.[0]?.text,
    prompt: (request) => request.body.contents?.[0]?.parts?.[0]?.text,
    model: (request) => /models\/([^:]+):/.exec(request.url)?.[1],
    effort: (request) => request.body.generationConfig?.thinkingConfig?.thinkingLevel,
    highEffort: "HIGH",
    schemaSent: (request) => {
      const config = request.body.generationConfig ?? {};
      return (
        config.responseMimeType === "application/json" &&
        typeof config.responseJsonSchema === "object" &&
        !("$schema" in config.responseJsonSchema)
      );
    },
    reply: (text) => ({
      candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP", index: 0 }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 },
    }),
    refusal: () => ({ candidates: [{ content: { role: "model", parts: [] }, finishReason: "SAFETY", index: 0 }] }),
  },
];

const FAILURES: { mode: Mode; kind: LlmErrorKind }[] = [
  { mode: "refusal", kind: "content" },
  { mode: "invalid_json", kind: "content" },
  { mode: "server_error", kind: "transient" },
  { mode: "not_found", kind: "config" },
  { mode: "unauthorized", kind: "config" },
];

for (const dialect of DIALECTS) {
  describe(`${dialect.name} provider`, () => {
    let mode: Mode = "ok";
    let server: Awaited<ReturnType<typeof startServer>>;

    before(async () => {
      server = await startServer((request): ServerReply => {
        if (!dialect.matches(request.url)) return { status: 400, body: { error: { message: "wrong route" } } };
        const error = (status: number, message: string): ServerReply => ({
          status,
          body: { error: { code: status, message, type: "test_error" } },
        });
        switch (mode) {
          case "refusal":
            return { status: 200, body: dialect.refusal() };
          case "invalid_json":
            return { status: 200, body: dialect.reply("this is not JSON") };
          case "server_error":
            return error(500, "simulated outage");
          case "not_found":
            return error(404, "unknown model");
          case "unauthorized":
            return error(401, "invalid key");
          default:
            return { status: 200, body: dialect.reply(JSON.stringify(ANSWER)) };
        }
      });
    });

    after(async () => {
      await server.close();
    });

    const provider = (models?: ProviderOptions["models"]) =>
      dialect.create({ apiKey: "test-key", baseUrl: dialect.baseUrl(server.url), models });

    it("sends instructions, message and schema in its own format, and returns the validated object", async () => {
      mode = "ok";
      server.requests.length = 0;
      const llm = provider();

      const result = await llm.completeJson({
        system: "INSTRUCTIONS",
        prompt: "MESSAGE",
        schema: Schema,
        model: llm.models.topic,
        effort: "high",
      });

      assert.deepEqual(result, ANSWER);
      const request = server.requests.at(-1);
      assert.ok(request && dialect.matches(request.url), `unexpected route: ${request?.url}`);
      assert.equal(dialect.system(request), "INSTRUCTIONS");
      assert.equal(dialect.prompt(request), "MESSAGE");
      assert.ok(dialect.schemaSent(request), "JSON schema missing or malformed");
      assert.equal(dialect.model(request), dialect.defaults.topic);
      assert.equal(dialect.effort(request), dialect.highEffort);
    });

    it("applies its default models and accepts a partial override", () => {
      assert.deepEqual(provider().models, dialect.defaults);
      assert.deepEqual(provider({ scoring: "override-model" }).models, {
        topic: dialect.defaults.topic,
        scoring: "override-model",
      });
    });

    for (const failure of FAILURES) {
      it(`classifies "${failure.mode}" as a ${failure.kind} error`, async () => {
        mode = failure.mode;
        const llm = provider();
        await assert.rejects(
          llm.completeJson({ system: "INSTRUCTIONS", prompt: "MESSAGE", schema: Schema, model: llm.models.scoring }),
          (error: unknown) => {
            assert.ok(error instanceof LlmError, `expected LlmError, got: ${String(error)}`);
            assert.equal(error.kind, failure.kind, error.message);
            return true;
          },
        );
        mode = "ok";
      });
    }
  });
}
