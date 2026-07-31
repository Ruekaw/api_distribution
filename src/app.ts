import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { Config } from './config';
import { addCommonHeaders, makeOpenAiError } from './errors';
import { hashClientIpFromHeaders } from './ip';
import type {
  AuditContext,
  ChatRequestBody,
  QuotaStore,
  ReservationFailure,
} from './types';

// ── Constants ──────────────────────────────────────────────────────────────

export const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MiB per spec
export const MAX_TOKENS = 16_384;

// ── Options ────────────────────────────────────────────────────────────────

export interface CreateAppOptions {
  config: Config;
  store: QuotaStore;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  auditSink?: (event: Record<string, unknown>) => void;
}

// ── Test-friendly inject types ─────────────────────────────────────────────

export interface InjectOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  payload?: unknown;
}

export interface InjectResponse {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json(): any;
}

export interface AppInstance {
  inject(options: InjectOptions): Promise<InjectResponse>;
  listen(options: { host: string; port: number }): Promise<void>;
  close(): Promise<void>;
  readonly server: http.Server;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function isDisabled(config: Config, now: Date): boolean {
  return config.disableAt !== null && now.getTime() >= config.disableAt.getTime();
}

function hasExpectedBearer(authHeader: string | null | undefined, expected: string): boolean {
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) return false;
  const supplied = authHeader.slice('Bearer '.length);
  const suppliedBytes = Buffer.from(supplied, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  if (suppliedBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(suppliedBytes, expectedBytes);
}

function isJsonContentType(value: string | null | undefined): boolean {
  return value?.toLowerCase().startsWith('application/json') ?? false;
}

function isObject(value: unknown): value is ChatRequestBody {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reservationFailureResponse(failure: ReservationFailure): Response {
  switch (failure.code) {
    case 'hourly_unique_ip_limit':
      return makeOpenAiError(429, 'The hourly unique IP limit has been reached.', 'rate_limit_error', failure.code, failure.retryAfterSeconds);
    case 'per_ip_rpm_limit':
      return makeOpenAiError(429, 'Per-IP requests per minute limit exceeded.', 'rate_limit_error', failure.code, failure.retryAfterSeconds);
    case 'global_request_limit':
      return makeOpenAiError(429, 'Global request limit reached.', 'rate_limit_error', failure.code, failure.retryAfterSeconds);
    case 'max_concurrency':
      return makeOpenAiError(503, 'The service is currently at maximum concurrency.', 'server_overloaded', failure.code, failure.retryAfterSeconds);
  }
}

function auditLog(
  event: Record<string, unknown>,
  sink?: (event: Record<string, unknown>) => void,
): void {
  if (sink) sink(event);
  else process.stdout.write(`${JSON.stringify(event)}\n`);
}

/** Read request body up to maxBytes. Returns null if limit exceeded. */
async function readBodyWithLimit(request: Request, maxBytes: number): Promise<Buffer | null> {
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// ── Core request handler ───────────────────────────────────────────────────

export async function handleRequest(
  request: Request,
  options: CreateAppOptions,
): Promise<Response> {
  const { config, store } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = (options.now ?? (() => new Date()))();
  const startHr = process.hrtime.bigint();

  const url = new URL(request.url, 'https://proxy.local');
  const pathname = url.pathname;
  const method = request.method.toUpperCase();

  const audit: AuditContext = {};

  function finalLog(status: number): void {
    const event: Record<string, unknown> = {
      time: new Date().toISOString(),
      method,
      path: pathname,
      ip_hash_prefix: audit.ipHashPrefix ?? null,
      status,
      duration_ms: Math.max(0, Number(process.hrtime.bigint() - startHr) / 1_000_000),
      stream: audit.stream ?? false,
      error_category: audit.errorCategory ?? null,
      global_request_count: audit.globalRequestCount ?? null,
    };
    auditLog(event, options.auditSink);
  }

  // ── Root path ────────────────────────────────────────────────────────────
  if (method === 'GET' && pathname === '/') {
    const res = new Response(
      JSON.stringify({ status: 'ok', service: 'dify-openai-proxy' }),
      { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
    );
    addCommonHeaders(res.headers);
    finalLog(200);
    return res;
  }

  // ── Health ───────────────────────────────────────────────────────────────
  if (method === 'GET' && pathname === '/health') {
    const body = JSON.stringify({
      status: 'ok',
      disabled: isDisabled(config, now),
      model: config.modelName,
    });
    const res = new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
    addCommonHeaders(res.headers);
    finalLog(200);
    return res;
  }

  // ── Models ───────────────────────────────────────────────────────────────
  if (method === 'GET' && pathname === '/v1/models') {
    const body = JSON.stringify({
      object: 'list',
      data: [{ id: config.modelName, object: 'model', owned_by: 'proxy' }],
    });
    const res = new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
    addCommonHeaders(res.headers);
    finalLog(200);
    return res;
  }

  // ── Chat completions ─────────────────────────────────────────────────────
  if (method === 'POST' && pathname === '/v1/chat/completions') {
    // 1. Disabled check
    if (isDisabled(config, now)) {
      audit.errorCategory = 'proxy_disabled';
      const res = makeOpenAiError(503, 'This temporary proxy has been disabled.', 'service_unavailable', 'proxy_disabled');
      finalLog(503);
      return res;
    }

    // 2. Auth
    if (!hasExpectedBearer(request.headers.get('authorization'), config.groupApiKey)) {
      audit.errorCategory = 'unauthorized';
      const res = makeOpenAiError(401, 'Unauthorized.', 'auth_error', 'unauthorized');
      finalLog(401);
      return res;
    }

    // 3. Content-Type
    if (!isJsonContentType(request.headers.get('content-type'))) {
      audit.errorCategory = 'invalid_content_type';
      const res = makeOpenAiError(415, 'Content-Type must be application/json.', 'invalid_request_error', 'invalid_content_type');
      finalLog(415);
      return res;
    }

    // 4. Body size limit
    const rawBody = await readBodyWithLimit(request, MAX_BODY_BYTES);
    if (rawBody === null) {
      audit.errorCategory = 'invalid_request';
      const res = makeOpenAiError(413, `Request body exceeds the ${MAX_BODY_BYTES / 1024 / 1024} MiB limit.`, 'invalid_request_error', 'request_too_large');
      finalLog(413);
      return res;
    }

    // 5. Parse JSON
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      audit.errorCategory = 'invalid_json';
      const res = makeOpenAiError(400, 'Request body must be valid JSON.', 'invalid_request_error', 'invalid_json');
      finalLog(400);
      return res;
    }

    if (!isObject(body)) {
      audit.errorCategory = 'invalid_request';
      const res = makeOpenAiError(400, 'Request body must be a JSON object.', 'invalid_request_error', 'invalid_request');
      finalLog(400);
      return res;
    }

    // 6. max_tokens validation
    const maxTokens = body.max_tokens;
    if (maxTokens !== undefined && (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens < 1)) {
      audit.errorCategory = 'invalid_request';
      const res = makeOpenAiError(400, 'max_tokens must be a positive integer.', 'invalid_request_error', 'invalid_max_tokens');
      finalLog(400);
      return res;
    }
    if (typeof maxTokens === 'number' && maxTokens > MAX_TOKENS) {
      audit.errorCategory = 'invalid_request';
      const res = makeOpenAiError(400, `max_tokens must be <= ${MAX_TOKENS}.`, 'invalid_request_error', 'max_tokens_too_large');
      finalLog(400);
      return res;
    }

    // 7. IP hash
    const stream = body.stream === true;
    audit.stream = stream;
    const ipHash = hashClientIpFromHeaders(request.headers, config.ipHmacSecret);
    if (!ipHash) {
      audit.errorCategory = 'invalid_ip';
      const res = makeOpenAiError(400, 'A valid client IP address is required.', 'invalid_request_error', 'invalid_client_ip');
      finalLog(400);
      return res;
    }
    audit.ipHashPrefix = ipHash.slice(0, 10);

    // 8. Reserve quota
    let reservation;
    try {
      reservation = await store.reserve({
        ipHash,
        now,
        perIpRpmLimit: config.perIpRpmLimit,
        hourlyUniqueIpLimit: config.hourlyUniqueIpLimit,
        globalRequestLimit: config.globalRequestLimit,
        maxConcurrency: config.maxConcurrency,
        leaseTtlSeconds: config.leaseTtlSeconds,
      });
    } catch {
      audit.errorCategory = 'upstream_error';
      const res = makeOpenAiError(503, 'The proxy storage service is unavailable.', 'server_error', 'storage_unavailable');
      finalLog(503);
      return res;
    }

    if ('code' in reservation) {
      audit.errorCategory = reservation.code;
      const res = reservationFailureResponse(reservation);
      finalLog(res.status);
      return res;
    }

    audit.globalRequestCount = reservation.globalRequestCount;

    // 9. Proxy to upstream
    const controller = new AbortController();
    const onClientAbort = (): void => controller.abort();
    request.signal?.addEventListener('abort', onClientAbort, { once: true });

    try {
      const upstream = await fetchImpl(config.upstreamUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.upstreamApiKey}`,
          'content-type': 'application/json',
          accept: stream ? 'text/event-stream' : 'application/json',
        },
        body: JSON.stringify({ ...body, model: config.modelName, n: 1 }),
        redirect: 'error',
        signal: controller.signal,
      });

      if (!upstream.ok) audit.errorCategory = 'upstream_http_error';

      if (stream) {
        const leaseId = reservation.leaseId;
        const upstreamBody = upstream.body;

        // Wrap the upstream stream so we can release the lease when it completes.
        let streamBody: ReadableStream<Uint8Array> | null = null;
        if (upstreamBody) {
          const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
          (async () => {
            try {
              await upstreamBody.pipeTo(writable);
            } catch {
              // client disconnect or upstream error — writable closes automatically
            } finally {
              await store.releaseLease(leaseId).catch(() => undefined);
            }
          })();
          streamBody = readable;
        } else {
          await store.releaseLease(leaseId).catch(() => undefined);
        }

        const contentType = upstream.headers.get('content-type') ?? 'text/event-stream; charset=utf-8';
        const res = new Response(streamBody, {
          status: upstream.status,
          headers: {
            'Content-Type': contentType,
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
          },
        });
        finalLog(upstream.status);
        return res;
      }

      // Non-streaming
      const bytes = Buffer.from(await upstream.arrayBuffer());
      const contentType = upstream.headers.get('content-type') ?? 'application/json; charset=utf-8';
      const res = new Response(bytes, {
        status: upstream.status,
        headers: { 'Content-Type': contentType },
      });
      addCommonHeaders(res.headers);
      finalLog(upstream.status);
      await store.releaseLease(reservation.leaseId).catch(() => undefined);
      return res;
    } catch (error) {
      const clientAborted = controller.signal.aborted;
      if (!clientAborted) {
        audit.errorCategory = 'upstream_error';
        await store.releaseLease(reservation.leaseId).catch(() => undefined);
        const res = makeOpenAiError(502, 'The upstream model endpoint could not be reached.', 'upstream_error', 'upstream_unavailable');
        finalLog(502);
        return res;
      }
      audit.errorCategory = 'client_aborted';
      await store.releaseLease(reservation.leaseId).catch(() => undefined);
      finalLog(499);
      return new Response(null, { status: 499 });
    } finally {
      request.signal?.removeEventListener('abort', onClientAbort);
    }
  }

  // ── 404 ──────────────────────────────────────────────────────────────────
  const res = makeOpenAiError(404, 'Not found.', 'invalid_request_error', 'not_found');
  finalLog(404);
  return res;
}

// ── createApp: test-friendly HTTP server wrapper ───────────────────────────

export function createApp(options: CreateAppOptions): AppInstance {
  const httpServer = http.createServer(async (req, res) => {
    // Abort the request handler when the socket closes unexpectedly.
    const controller = new AbortController();
    req.once('close', () => controller.abort());
    req.once('aborted', () => controller.abort());

    // Build a ReadableStream from IncomingMessage.
    const bodyStream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        req.on('data', (chunk: Buffer) => ctrl.enqueue(chunk));
        req.on('end', () => ctrl.close());
        req.on('error', (err) => ctrl.error(err));
      },
    });

    const reqUrl = `https://proxy.local${req.url ?? '/'}`;
    const webReq = new Request(reqUrl, {
      method: req.method ?? 'GET',
      headers: req.headers as Record<string, string>,
      body: ['GET', 'HEAD', 'DELETE'].includes(req.method?.toUpperCase() ?? '') ? undefined : bodyStream,
      // @ts-expect-error Node 18+ supports duplex
      duplex: 'half',
      signal: controller.signal,
    });

    const webRes = await handleRequest(webReq, options);

    res.statusCode = webRes.status;
    webRes.headers.forEach((value, key) => res.setHeader(key, value));

    if (webRes.body) {
      const reader = webRes.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await new Promise<void>((resolve, reject) => {
            res.write(value, (err) => (err ? reject(err) : resolve()));
          });
        }
      } catch {
        // client disconnected
      } finally {
        reader.releaseLock();
      }
    }
    res.end();
  });

  return {
    server: httpServer,

    async inject(opts: InjectOptions): Promise<InjectResponse> {
      const base = 'https://proxy.local';
      const fullUrl = opts.url.startsWith('http') ? opts.url : `${base}${opts.url}`;
      const payloadStr =
        opts.payload !== undefined
          ? typeof opts.payload === 'string'
            ? opts.payload
            : JSON.stringify(opts.payload)
          : undefined;

      const controller = new AbortController();
      const webReq = new Request(fullUrl, {
        method: opts.method,
        headers: opts.headers,
        body: payloadStr,
        signal: controller.signal,
      });

      const webRes = await handleRequest(webReq, options);
      const body = await webRes.text();
      const hdrs: Record<string, string> = {};
      webRes.headers.forEach((v, k) => { hdrs[k] = v; });

      return {
        statusCode: webRes.status,
        body,
        headers: hdrs,
        json() { return JSON.parse(body); },
      };
    },

    async listen(opts: { host: string; port: number }): Promise<void> {
      return new Promise((resolve, reject) => {
        httpServer.listen(opts.port, opts.host, () => resolve());
        httpServer.once('error', reject);
      });
    },

    async close(): Promise<void> {
      return new Promise((resolve) => {
        httpServer.close(() => resolve());
      });
    },
  };
}

export { hasExpectedBearer, isDisabled };
