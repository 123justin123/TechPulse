import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHttp, HttpError, NetworkError } from "../../src/lib/http.js";

function fetchReturning(responses: (() => Response | Promise<Response>)[]): {
  fetchImpl: typeof fetch;
  calls: () => number;
} {
  let call = 0;
  const fetchImpl = (async () => {
    const next = responses[call++];
    if (!next) throw new Error("unexpected call");
    return next();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => call };
}

const networkFailure = () => {
  throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
};

const noWait = async (): Promise<void> => {};

describe("createHttp", () => {
  it("retries once after a network failure", async () => {
    const { fetchImpl, calls } = fetchReturning([networkFailure, () => new Response("ok")]);
    const http = createHttp({ fetchImpl, wait: noWait });

    assert.equal(await http.text("https://feed.test/rss"), "ok");
    assert.equal(calls(), 2);
  });

  it("reports the network cause when the retry fails too", async () => {
    const { fetchImpl } = fetchReturning([networkFailure, networkFailure]);
    const http = createHttp({ fetchImpl, wait: noWait });

    await assert.rejects(http.text("https://feed.test/rss"), (error: unknown) => {
      assert.ok(error instanceof NetworkError);
      assert.equal(error.message, "Network error on https://feed.test/rss: ECONNRESET");
      return true;
    });
  });

  it("does not retry HTTP errors other than rate limits", async () => {
    const { fetchImpl, calls } = fetchReturning([() => new Response("gone", { status: 404 })]);
    const http = createHttp({ fetchImpl, wait: noWait });

    await assert.rejects(http.text("https://feed.test/rss"), HttpError);
    assert.equal(calls(), 1);
  });
});
