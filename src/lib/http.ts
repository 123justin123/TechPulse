export const USER_AGENT = "TechPulse/1.0 (personal tech watch aggregator)";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_AFTER_SECONDS = 15;
const MAX_RETRY_AFTER_SECONDS = 30;
const NETWORK_RETRY_DELAY_MS = 2_000;

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface RequestOptions {
  accept?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface Http {
  text(url: string, options?: RequestOptions): Promise<string>;
  json<T>(url: string, options?: RequestOptions): Promise<T>;
}

export class HttpError extends Error {
  override readonly name = "HttpError";

  constructor(
    readonly status: number,
    url: string,
  ) {
    super(`HTTP ${status} on ${url}`);
  }
}

export class NetworkError extends Error {
  override readonly name = "NetworkError";

  constructor(url: string, cause: unknown) {
    super(`Network error on ${url}: ${describeNetworkFailure(cause)}`, { cause });
  }
}

export function createHttp({
  userAgent = USER_AGENT,
  wait = sleep,
  fetchImpl = fetch,
}: {
  userAgent?: string;
  wait?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
} = {}): Http {
  async function request(url: string, options: RequestOptions, isRetry: boolean): Promise<Response> {
    const { accept, headers, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
    try {
      return await fetchImpl(url, {
        headers: { "User-Agent": userAgent, ...(accept ? { Accept: accept } : {}), ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (isRetry) throw new NetworkError(url, error);
      await wait(NETWORK_RETRY_DELAY_MS);
      return request(url, options, true);
    }
  }

  async function text(url: string, options: RequestOptions = {}, isRetry = false): Promise<string> {
    const response = await request(url, options, false);

    if (response.status === 429 && !isRetry) {
      const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
      const seconds = Number.isFinite(retryAfter) ? retryAfter : DEFAULT_RETRY_AFTER_SECONDS;
      await wait(Math.min(seconds, MAX_RETRY_AFTER_SECONDS) * 1000);
      return text(url, options, true);
    }

    if (!response.ok) {
      throw new HttpError(response.status, url);
    }

    if (response.url && new URL(response.url).pathname.startsWith("/login")) {
      throw new Error(`Authentication required (redirected to ${response.url})`);
    }

    return response.text();
  }

  return {
    text: (url, options) => text(url, options),
    json: async <T>(url: string, options?: RequestOptions): Promise<T> =>
      JSON.parse(await text(url, { accept: "application/json", ...options })) as T,
  };
}

function describeNetworkFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.name === "TimeoutError") return "timed out";
  const cause = error.cause as { code?: string; message?: string } | undefined;
  return cause?.code ?? cause?.message ?? error.message;
}
