import { getConfig } from "./config";
import {
  applyCommonHeaders,
  jsonResponse,
  openAiError,
  storageUnavailable,
} from "./errors";
import { getClientIp, hashClientIp } from "./ip";
import { ProxyLimiter } from "./limiter";
import type {
  AcquireFailure,
  AuditContext,
  ChatRequestBody,
  ProxyConfig,
} from "./types";
import { verifyBearer } from "./auth";

export { ProxyLimiter };

type LimiterStub = DurableObjectStub<ProxyLimiter>;

interface RequestRuntime {
  config: ProxyConfig;
  limiter: LimiterStub;
  audit: AuditContext;
  controller: AbortController;
  heartbeat: LeaseHeartbeat;
  leaseId: string;
  request: Request;
  startedAt: number;
  path: string;
}

const worker = {
  async fetch(request, env, ctx): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

export default worker;

export async function handleRequest(
  request: Request,
  env: Env,
  executionContext: ExecutionContext,
): Promise<Response> {
  const startedAt = Date.now();
  const path = safePath(request.url);
  const audit: AuditContext = { stream: false };
  let config: ProxyConfig;

  try {
    config = getConfig(env);
  } catch {
    audit.errorCategory = "invalid_configuration";
    return finish(
      request,
      path,
      startedAt,
      audit,
      openAiError(
        500,
        "The proxy configuration is invalid.",
        "server_error",
        "invalid_configuration",
      ),
    );
  }

  if (request.method === "GET" && path === "/") {
    return finish(
      request,
      path,
      startedAt,
      audit,
      jsonResponse({ status: "ok", service: "dify-openai-proxy" }),
    );
  }

  if (request.method === "GET" && path === "/health") {
    return finish(
      request,
      path,
      startedAt,
      audit,
      jsonResponse({
        status: "ok",
        disabled:
          config.disableAt !== null && Date.now() >= config.disableAt,
        model: config.modelName,
      }),
    );
  }

  if (request.method === "GET" && path === "/v1/models") {
    return finish(
      request,
      path,
      startedAt,
      audit,
      jsonResponse({
        object: "list",
        data: [
          {
            id: config.modelName,
            object: "model",
            owned_by: "proxy",
          },
        ],
      }),
    );
  }

  if (request.method !== "POST" || path !== "/v1/chat/completions") {
    audit.errorCategory = "not_found";
    return finish(
      request,
      path,
      startedAt,
      audit,
      openAiError(404, "Not found.", "invalid_request_error", "not_found"),
    );
  }

  if (config.disableAt !== null && Date.now() >= config.disableAt) {
    audit.errorCategory = "proxy_disabled";
    return finish(
      request,
      path,
      startedAt,
      audit,
      openAiError(
        503,
        "This temporary proxy has been disabled.",
        "service_unavailable",
        "proxy_disabled",
      ),
    );
  }

  if (
    !(await verifyBearer(
      request.headers.get("Authorization"),
      config.groupApiKey,
    ))
  ) {
    audit.errorCategory = "unauthorized";
    return finish(
      request,
      path,
      startedAt,
      audit,
      openAiError(401, "Unauthorized.", "auth_error", "unauthorized"),
    );
  }

  if (!isAcceptedJsonContentType(request.headers.get("Content-Type"))) {
    audit.errorCategory = "invalid_content_type";
    return finish(
      request,
      path,
      startedAt,
      audit,
      openAiError(
        415,
        "Content-Type must be application/json.",
        "invalid_request_error",
        "invalid_content_type",
      ),
    );
  }

  const declaredLength = request.headers.get("Content-Length");
  if (
    declaredLength !== null &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > config.maxBodyBytes
  ) {
    audit.errorCategory = "request_too_large";
    return finish(
      request,
      path,
      startedAt,
      audit,
      bodyTooLarge(config.maxBodyBytes),
    );
  }

  let rawBody: ArrayBuffer;
  try {
    rawBody = await request.arrayBuffer();
  } catch {
    audit.errorCategory = "invalid_json";
    return finish(
      request,
      path,
      startedAt,
      audit,
      openAiError(
        400,
        "Request body must be valid JSON.",
        "invalid_request_error",
        "invalid_json",
      ),
    );
  }
  if (rawBody.byteLength > config.maxBodyBytes) {
    audit.errorCategory = "request_too_large";
    return finish(
      request,
      path,
      startedAt,
      audit,
      bodyTooLarge(config.maxBodyBytes),
    );
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(rawBody),
    );
  } catch {
    audit.errorCategory = "invalid_json";
    return finish(
      request,
      path,
      startedAt,
      audit,
      openAiError(
        400,
        "Request body must be valid JSON.",
        "invalid_request_error",
        "invalid_json",
      ),
    );
  }
  if (!isJsonObject(parsedBody)) {
    audit.errorCategory = "invalid_request";
    return finish(
      request,
      path,
      startedAt,
      audit,
      openAiError(
        400,
        "Request body must be a JSON object.",
        "invalid_request_error",
        "invalid_request",
      ),
    );
  }

  const tokenError = validateTokenLimits(parsedBody, config.maxOutputTokens);
  if (tokenError !== null) {
    audit.errorCategory = tokenError.error.error.code;
    return finish(request, path, startedAt, audit, tokenError.response);
  }

  audit.stream = parsedBody.stream === true;
  const normalizedIp = getClientIp(request);
  if (normalizedIp === null) {
    audit.errorCategory = "invalid_client_ip";
    return finish(
      request,
      path,
      startedAt,
      audit,
      openAiError(
        400,
        "A valid client IP address is required.",
        "invalid_request_error",
        "invalid_client_ip",
      ),
    );
  }
  const ipHash = await hashClientIp(normalizedIp, config.ipHmacSecret);
  audit.ipHashPrefix = ipHash.slice(0, 10);

  const limiter = env.PROXY_LIMITER.getByName("global");
  let reservation;
  try {
    reservation = await limiter.acquire({
      ipHash,
      nowMs: Date.now(),
      quotaScope: config.quotaScope,
      perIpRpmLimit: config.perIpRpmLimit,
      hourlyUniqueIpLimit: config.hourlyUniqueIpLimit,
      globalRequestLimit: config.globalRequestLimit,
      maxConcurrency: config.maxConcurrency,
      leaseTtlSeconds: config.leaseTtlSeconds,
    });
  } catch {
    audit.errorCategory = "storage_unavailable";
    return finish(
      request,
      path,
      startedAt,
      audit,
      storageUnavailable(),
    );
  }

  if (!reservation.ok) {
    audit.errorCategory = reservation.code;
    return finish(
      request,
      path,
      startedAt,
      audit,
      limiterFailure(reservation),
    );
  }
  audit.globalRequestCount = reservation.globalRequestCount;

  const controller = new AbortController();
  let leaseFailure = false;
  const abortOnClientDisconnect = (): void => {
    audit.errorCategory = "client_aborted";
    controller.abort("client_aborted");
  };
  request.signal.addEventListener("abort", abortOnClientDisconnect, {
    once: true,
  });

  const heartbeat = new LeaseHeartbeat(
    limiter,
    reservation.leaseId,
    config.leaseTtlSeconds,
    config.leaseHeartbeatSeconds,
    () => {
      leaseFailure = true;
      audit.errorCategory = "lease_renew_failed";
      controller.abort("lease_renew_failed");
    },
  );
  const runtime: RequestRuntime = {
    config,
    limiter,
    audit,
    controller,
    heartbeat,
    leaseId: reservation.leaseId,
    request,
    startedAt,
    path,
  };
  if (request.signal.aborted) {
    abortOnClientDisconnect();
  }

  let upstream: Response;
  try {
    upstream = await fetch(config.upstreamUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.upstreamApiKey}`,
        "Content-Type": "application/json",
        Accept:
          parsedBody.stream === true
            ? "text/event-stream"
            : "application/json",
      },
      body: JSON.stringify({
        ...parsedBody,
        model: config.modelName,
        n: 1,
      }),
      redirect: "error",
      signal: controller.signal,
    });
  } catch {
    await cleanupRuntime(runtime, abortOnClientDisconnect);
    if (leaseFailure) {
      return finish(
        request,
        path,
        startedAt,
        audit,
        storageUnavailable(),
      );
    }
    if (request.signal.aborted) {
      return finish(
        request,
        path,
        startedAt,
        audit,
        new Response(null, { status: 499 }),
      );
    }
    audit.errorCategory = "upstream_error";
    return finish(
      request,
      path,
      startedAt,
      audit,
      openAiError(
        502,
        "The upstream model endpoint could not be reached.",
        "upstream_error",
        "upstream_unavailable",
      ),
    );
  }

  if (!upstream.ok) audit.errorCategory = "upstream_http_error";

  if (parsedBody.stream === true) {
    const { readable, writable } = new IdentityTransformStream();
    const completion = streamUpstream(
      upstream,
      writable,
      runtime,
      abortOnClientDisconnect,
    );
    executionContext.waitUntil(completion);

    const headers = new Headers({
      "Content-Type":
        upstream.headers.get("Content-Type") ??
        "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    return new Response(
      cancelAwareReadable(readable, controller, audit),
      {
        status: upstream.status,
        headers,
      },
    );
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await upstream.arrayBuffer();
  } catch {
    await cleanupRuntime(runtime, abortOnClientDisconnect);
    if (leaseFailure) {
      audit.errorCategory = "lease_renew_failed";
      return finish(
        request,
        path,
        startedAt,
        audit,
        storageUnavailable(),
      );
    }
    if (request.signal.aborted) {
      audit.errorCategory = "client_aborted";
      return finish(
        request,
        path,
        startedAt,
        audit,
        new Response(null, { status: 499 }),
      );
    }
    audit.errorCategory = "upstream_error";
    return finish(
      request,
      path,
      startedAt,
      audit,
      openAiError(
        502,
        "The upstream model endpoint could not be reached.",
        "upstream_error",
        "upstream_unavailable",
      ),
    );
  }

  await cleanupRuntime(runtime, abortOnClientDisconnect);
  const headers = applyCommonHeaders(new Headers());
  headers.set(
    "Content-Type",
    upstream.headers.get("Content-Type") ?? "application/json; charset=utf-8",
  );
  return finish(
    request,
    path,
    startedAt,
    audit,
    new Response(bytes, { status: upstream.status, headers }),
  );
}

async function streamUpstream(
  upstream: Response,
  writable: WritableStream,
  runtime: RequestRuntime,
  abortOnClientDisconnect: () => void,
): Promise<void> {
  try {
    if (upstream.body === null) {
      const writer = writable.getWriter();
      await writer.close();
      writer.releaseLock();
    } else {
      await upstream.body.pipeTo(writable, {
        signal: runtime.controller.signal,
      });
    }
  } catch {
    if (runtime.request.signal.aborted) {
      runtime.audit.errorCategory = "client_aborted";
    } else if (runtime.controller.signal.reason === "client_cancelled") {
      runtime.audit.errorCategory = "client_aborted";
    } else if (runtime.audit.errorCategory !== "lease_renew_failed") {
      runtime.audit.errorCategory = "upstream_stream_error";
    }
  } finally {
    await cleanupRuntime(runtime, abortOnClientDisconnect);
    logAudit(
      runtime.request,
      runtime.path,
      runtime.startedAt,
      runtime.audit,
      upstream.status,
    );
  }
}

function cancelAwareReadable(
  source: ReadableStream<Uint8Array>,
  controller: AbortController,
  audit: AuditContext,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(output) {
      const { done, value } = await reader.read();
      if (done) output.close();
      else output.enqueue(value);
    },
    async cancel(reason) {
      audit.errorCategory = "client_aborted";
      controller.abort("client_cancelled");
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

async function cleanupRuntime(
  runtime: RequestRuntime,
  abortOnClientDisconnect: () => void,
): Promise<void> {
  runtime.request.signal.removeEventListener(
    "abort",
    abortOnClientDisconnect,
  );
  await runtime.heartbeat.stop();
  try {
    await runtime.limiter.release(runtime.leaseId);
  } catch {
    if (runtime.audit.errorCategory === undefined) {
      runtime.audit.errorCategory = "lease_release_failed";
    }
  }
}

class LeaseHeartbeat {
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private wake: (() => void) | undefined;
  private readonly task: Promise<void>;

  constructor(
    private readonly limiter: LimiterStub,
    private readonly leaseId: string,
    private readonly ttlSeconds: number,
    private readonly heartbeatSeconds: number,
    private readonly onFailure: () => void,
  ) {
    this.task = this.run();
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      await this.task;
      return;
    }
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.wake?.();
    await this.task;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      await this.waitForNextHeartbeat();
      if (this.stopped) break;
      try {
        const renewed = await this.limiter.renew(
          this.leaseId,
          this.ttlSeconds,
        );
        if (!renewed) {
          this.onFailure();
          break;
        }
      } catch {
        this.onFailure();
        break;
      }
    }
  }

  private waitForNextHeartbeat(): Promise<void> {
    return new Promise((resolve) => {
      this.wake = resolve;
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.wake = undefined;
        resolve();
      }, this.heartbeatSeconds * 1000);
    });
  }
}

function validateTokenLimits(
  body: ChatRequestBody,
  maximum: number,
): { response: Response; error: { error: { code: string } } } | null {
  const maxTokens = body.max_tokens;
  if (
    maxTokens !== undefined &&
    (typeof maxTokens !== "number" ||
      !Number.isInteger(maxTokens) ||
      maxTokens < 1)
  ) {
    return tokenError(
      "max_tokens must be a positive integer.",
      "invalid_max_tokens",
    );
  }
  if (typeof maxTokens === "number" && maxTokens > maximum) {
    return tokenError(
      `max_tokens must be <= ${maximum}.`,
      "max_tokens_too_large",
    );
  }

  const maxCompletionTokens = body.max_completion_tokens;
  if (
    maxCompletionTokens !== undefined &&
    (typeof maxCompletionTokens !== "number" ||
      !Number.isInteger(maxCompletionTokens) ||
      maxCompletionTokens < 1)
  ) {
    return tokenError(
      "max_completion_tokens must be a positive integer.",
      "invalid_max_completion_tokens",
    );
  }
  if (
    typeof maxCompletionTokens === "number" &&
    maxCompletionTokens > maximum
  ) {
    return tokenError(
      `max_completion_tokens must be <= ${maximum}.`,
      "max_completion_tokens_too_large",
    );
  }
  if (
    typeof maxTokens === "number" &&
    typeof maxCompletionTokens === "number" &&
    maxTokens !== maxCompletionTokens
  ) {
    return tokenError(
      "max_tokens and max_completion_tokens must match when both are provided.",
      "conflicting_token_limits",
    );
  }
  return null;
}

function tokenError(
  message: string,
  code: string,
): { response: Response; error: { error: { code: string } } } {
  return {
    response: openAiError(400, message, "invalid_request_error", code),
    error: { error: { code } },
  };
}

function limiterFailure(failure: AcquireFailure): Response {
  switch (failure.code) {
    case "per_ip_rpm_limit":
      return openAiError(
        429,
        "Per-IP requests per minute limit exceeded.",
        "rate_limit_error",
        failure.code,
        failure.retryAfterSeconds,
      );
    case "hourly_unique_ip_limit":
      return openAiError(
        429,
        "The hourly unique IP limit has been reached.",
        "rate_limit_error",
        failure.code,
        failure.retryAfterSeconds,
      );
    case "global_request_limit":
      return openAiError(
        429,
        "Global request limit reached.",
        "rate_limit_error",
        failure.code,
      );
    case "max_concurrency":
      return openAiError(
        503,
        "The service is currently at maximum concurrency.",
        "server_overloaded",
        failure.code,
        failure.retryAfterSeconds,
      );
  }
}

function bodyTooLarge(limit: number): Response {
  return openAiError(
    413,
    `Request body exceeds the ${limit} byte limit.`,
    "invalid_request_error",
    "request_too_large",
  );
}

function isAcceptedJsonContentType(value: string | null): boolean {
  if (value === null) return false;
  const parts = value.split(";").map((part) => part.trim());
  if (parts[0]?.toLowerCase() !== "application/json") return false;
  return parts
    .slice(1)
    .every((part) => /^charset\s*=\s*utf-8$/i.test(part));
}

function isJsonObject(value: unknown): value is ChatRequestBody {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "/";
  }
}

function finish(
  request: Request,
  path: string,
  startedAt: number,
  audit: AuditContext,
  response: Response,
): Response {
  logAudit(request, path, startedAt, audit, response.status);
  return response;
}

function logAudit(
  request: Request,
  path: string,
  startedAt: number,
  audit: AuditContext,
  status: number,
): void {
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      method: request.method,
      path,
      ip_hash_prefix: audit.ipHashPrefix ?? null,
      status,
      duration_ms: Math.max(0, Date.now() - startedAt),
      stream: audit.stream ?? false,
      error_category: audit.errorCategory ?? null,
      global_request_count: audit.globalRequestCount ?? null,
    }),
  );
}
