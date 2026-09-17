import { sleep } from "../../lib/http.js";
import type { Logger } from "../../lib/logger.js";
import type { WebhookPayload } from "./render.js";

const WEBHOOK_TIMEOUT_MS = 15_000;
const WEBHOOK_MAX_ATTEMPTS = 3;

export async function postWebhook(url: string, payload: WebhookPayload, log: Logger, attempt = 1): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
  });

  if (response.status === 429 && attempt < WEBHOOK_MAX_ATTEMPTS) {
    const body = (await response.json().catch(() => ({}))) as { retry_after?: number };
    const retryAfterSeconds = body.retry_after ?? 1;
    log.warn(`Discord rate limit, retrying in ${retryAfterSeconds} s.`);
    await sleep(retryAfterSeconds * 1000);
    return postWebhook(url, payload, log, attempt + 1);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Discord webhook failed (${response.status}): ${detail}`);
  }
}
