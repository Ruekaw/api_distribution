import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import worker from "../src/index";
import type { AcquireInput } from "../src/types";

export const TEST_UPSTREAM_URL =
  "https://upstream.example/v1/chat/completions";
export const TEST_UPSTREAM_KEY = "test-upstream-key";
export const TEST_GROUP_KEY = "test-group-key";
export const TEST_HMAC_SECRET = "test-ip-hmac-secret";

export function testEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    ...env,
    UPSTREAM_URL: TEST_UPSTREAM_URL,
    UPSTREAM_API_KEY: TEST_UPSTREAM_KEY,
    GROUP_API_KEY: TEST_GROUP_KEY,
    IP_HMAC_SECRET: TEST_HMAC_SECRET,
    ...overrides,
  } as Env;
}

export function chatRequest(
  body: unknown = { messages: [] },
  options: {
    ip?: string | null;
    authorization?: string | null;
    contentType?: string | null;
    extraHeaders?: Record<string, string>;
    signal?: AbortSignal;
    rawBody?: string | ArrayBuffer;
  } = {},
): Request {
  const headers = new Headers(options.extraHeaders);
  const authorization =
    options.authorization === undefined
      ? `Bearer ${TEST_GROUP_KEY}`
      : options.authorization;
  if (authorization !== null) headers.set("Authorization", authorization);
  const contentType =
    options.contentType === undefined ? "application/json" : options.contentType;
  if (contentType !== null) headers.set("Content-Type", contentType);
  const ip = options.ip === undefined ? "203.0.113.10" : options.ip;
  if (ip !== null) headers.set("CF-Connecting-IP", ip);

  const requestBody =
    options.rawBody ??
    (typeof body === "string" ? body : JSON.stringify(body));
  return new Request("https://proxy.example/v1/chat/completions", {
    method: "POST",
    headers,
    body: requestBody,
    signal: options.signal,
  });
}

export async function invoke(
  request: Request,
  overrides: Record<string, unknown> = {},
): Promise<{
  response: Response;
  context: ExecutionContext;
  waitForBackground: () => Promise<void>;
}> {
  const context = createExecutionContext();
  const response = await worker.fetch(
    request as never,
    testEnv(overrides),
    context,
  );
  return {
    response,
    context,
    waitForBackground: () => waitOnExecutionContext(context),
  };
}

export function limiterInput(
  ipHash: string,
  overrides: Partial<AcquireInput> = {},
): AcquireInput {
  return {
    ipHash,
    nowMs: Date.now(),
    quotaScope: "test-scope",
    perIpRpmLimit: 10,
    hourlyUniqueIpLimit: 10,
    globalRequestLimit: 150,
    maxConcurrency: 3,
    leaseTtlSeconds: 180,
    ...overrides,
  };
}

export function hashFor(index: number): string {
  return index.toString(16).padStart(64, "0");
}

export async function responseJson(response: Response): Promise<any> {
  return response.json();
}
