import { timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Config } from './config';
import { sendOpenAiError } from './errors';
import { hashClientIpFromRequest } from './ip';
import type {
  AuditContext,
  ChatRequestBody,
  QuotaStore,
  ReservationFailure,
} from './types';

declare module 'fastify' {
  interface FastifyRequest {
    audit: AuditContext | null;
  }
}

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_TOKENS = 16_384;

interface CreateAppOptions {
  config: Config;
  store: QuotaStore;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  auditSink?: (event: Record<string, unknown>) => void;
}

function isDisabled(config: Config, now: Date): boolean {
  return config.disableAt !== null && now.getTime() >= config.disableAt.getTime();
}

function hasExpectedBearer(request: FastifyRequest, expected: string): boolean {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false;
  const supplied = authorization.slice('Bearer '.length);
  const suppliedBytes = Buffer.from(supplied, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  if (suppliedBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(suppliedBytes, expectedBytes);
}

function isJsonContentType(value: string | undefined): boolean {
  return value?.toLowerCase().startsWith('application/json') ?? false;
}

function isObject(value: unknown): value is ChatRequestBody {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reservationFailureResponse(
  reply: FastifyReply,
  request: FastifyRequest,
  failure: ReservationFailure,
): void {
  request.audit!.errorCategory = failure.code;
  switch (failure.code) {
    case 'hourly_unique_ip_limit':
      sendOpenAiError(
        reply,
        429,
        'The hourly unique IP limit has been reached.',
        'rate_limit_error',
        failure.code,
        failure.retryAfterSeconds,
      );
      return;
    case 'per_ip_rpm_limit':
      sendOpenAiError(
        reply,
        429,
        'Per-IP requests per minute limit exceeded.',
        'rate_limit_error',
        failure.code,
        failure.retryAfterSeconds,
      );
      return;
    case 'global_request_limit':
      sendOpenAiError(
        reply,
        429,
        'Global request limit reached.',
        'rate_limit_error',
        failure.code,
        failure.retryAfterSeconds,
      );
      return;
    case 'max_concurrency':
      sendOpenAiError(
        reply,
        503,
        'The service is currently at maximum concurrency.',
        'server_overloaded',
        failure.code,
        failure.retryAfterSeconds,
      );
      return;
  }
}

function setCommonHeaders(reply: FastifyReply): void {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('Cache-Control', 'no-store');
}

function safeRoutePath(request: FastifyRequest): string {
  const routePath = request.routeOptions.url;
  if (routePath) return routePath;
  return request.url.split('?', 1)[0] || '/';
}

function auditLog(
  request: FastifyRequest,
  reply: FastifyReply,
  sink?: (event: Record<string, unknown>) => void,
): void {
  const audit = request.audit;
  const event = {
    time: new Date().toISOString(),
    method: request.method,
    path: safeRoutePath(request),
    ip_hash_prefix: audit?.ipHashPrefix ?? null,
    status: reply.statusCode,
    duration_ms: Math.max(0, Number(process.hrtime.bigint() - (request as FastifyRequest & { auditStart?: bigint }).auditStart!) / 1_000_000),
    stream: audit?.stream ?? false,
    error_category: audit?.errorCategory ?? null,
    global_request_count: audit?.globalRequestCount ?? null,
  };
  // Deliberately emit only the allow-listed operational fields above.
  if (sink) sink(event);
  else process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function proxyToUpstream(
  request: FastifyRequest,
  reply: FastifyReply,
  body: ChatRequestBody,
  reservation: { leaseId: string; globalRequestCount: number },
  options: CreateAppOptions,
): Promise<void> {
  const { config, store } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const stream = body.stream === true;
  const controller = new AbortController();
  let responseFinished = false;
  const abortOnDisconnect = (): void => {
    if (!responseFinished && !reply.raw.writableFinished) controller.abort();
  };
  request.raw.once('aborted', abortOnDisconnect);
  reply.raw.once('close', abortOnDisconnect);

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
    if (!upstream.ok) request.audit!.errorCategory = 'upstream_http_error';

    if (stream) {
      reply.hijack();
      reply.raw.statusCode = upstream.status;
      const contentType = upstream.headers.get('content-type') ?? 'text/event-stream; charset=utf-8';
      reply.raw.setHeader('content-type', contentType);
      reply.raw.setHeader('cache-control', 'no-cache, no-transform');
      reply.raw.setHeader('x-content-type-options', 'nosniff');
      reply.raw.setHeader('referrer-policy', 'no-referrer');
      reply.raw.setHeader('x-accel-buffering', 'no');
      reply.raw.removeHeader('content-length');
      reply.raw.removeHeader('content-encoding');
      reply.raw.flushHeaders();
      if (upstream.body) {
        await pipeline(
          Readable.from(upstream.body as unknown as AsyncIterable<Uint8Array>),
          reply.raw,
        );
      } else {
        reply.raw.end();
      }
      responseFinished = true;
      return;
    }

    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (!reply.raw.destroyed) {
      const contentType = upstream.headers.get('content-type');
      if (contentType) reply.type(contentType);
      reply.code(upstream.status).send(bytes);
    }
    responseFinished = true;
  } catch (error) {
    const clientAborted = controller.signal.aborted || request.raw.aborted || reply.raw.destroyed;
    if (!clientAborted) {
      request.audit!.errorCategory = 'upstream_error';
      sendOpenAiError(
        reply,
        502,
        'The upstream model endpoint could not be reached.',
        'upstream_error',
        'upstream_unavailable',
      );
    } else {
      request.audit!.errorCategory = 'client_aborted';
    }
  } finally {
    responseFinished = true;
    request.raw.removeListener('aborted', abortOnDisconnect);
    reply.raw.removeListener('close', abortOnDisconnect);
    await store.releaseLease(reservation.leaseId).catch(() => undefined);
  }
}

export function createApp(options: CreateAppOptions): FastifyInstance {
  const { config, store } = options;
  const now = options.now ?? (() => new Date());
  const app = Fastify({
    logger: false,
    bodyLimit: MAX_BODY_BYTES,
    trustProxy: false,
  });

  app.decorateRequest('audit', null);
  app.addHook('onRequest', async (request) => {
    (request as FastifyRequest & { auditStart?: bigint }).auditStart = process.hrtime.bigint();
    request.audit = {};
  });
  app.addHook('onSend', async (_request, reply) => {
    setCommonHeaders(reply);
  });
  app.addHook('onResponse', async (request, reply) => {
    auditLog(request, reply, options.auditSink);
  });
  app.setErrorHandler((error, request, reply) => {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 413) {
      request.audit!.errorCategory = 'invalid_request';
      sendOpenAiError(reply, 413, 'Request body exceeds the 8 MiB limit.', 'invalid_request_error', 'request_too_large');
      return;
    }
    if (statusCode === 400) {
      request.audit!.errorCategory = 'invalid_json';
      sendOpenAiError(reply, 400, 'Request body must be valid JSON.', 'invalid_request_error', 'invalid_json');
      return;
    }
    request.audit!.errorCategory = 'invalid_request';
    sendOpenAiError(reply, 500, 'Internal proxy error.', 'server_error', 'internal_error');
  });

  app.get('/health', async (_request, reply) => {
    setCommonHeaders(reply);
    return reply.send({
      status: 'ok',
      disabled: isDisabled(config, now()),
      model: config.modelName,
    });
  });

  app.get('/v1/models', async (_request, reply) => {
    setCommonHeaders(reply);
    return reply.send({
      object: 'list',
      data: [{ id: config.modelName, object: 'model', owned_by: 'proxy' }],
    });
  });

  app.post<{ Body: ChatRequestBody }>('/v1/chat/completions', async (request, reply) => {
    const currentTime = now();
    if (isDisabled(config, currentTime)) {
      request.audit!.errorCategory = 'proxy_disabled';
      sendOpenAiError(
        reply,
        503,
        'This temporary proxy has been disabled.',
        'service_unavailable',
        'proxy_disabled',
      );
      return;
    }

    if (!hasExpectedBearer(request, config.groupApiKey)) {
      request.audit!.errorCategory = 'unauthorized';
      sendOpenAiError(reply, 401, 'Unauthorized.', 'auth_error', 'unauthorized');
      return;
    }

    if (!isJsonContentType(request.headers['content-type'])) {
      request.audit!.errorCategory = 'invalid_content_type';
      sendOpenAiError(
        reply,
        415,
        'Content-Type must be application/json.',
        'invalid_request_error',
        'invalid_content_type',
      );
      return;
    }

    const body = request.body;
    if (!isObject(body)) {
      request.audit!.errorCategory = 'invalid_request';
      sendOpenAiError(reply, 400, 'Request body must be a JSON object.', 'invalid_request_error', 'invalid_request');
      return;
    }
    const maxTokens = body.max_tokens;
    if (maxTokens !== undefined &&
        (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens < 1)) {
      request.audit!.errorCategory = 'invalid_request';
      sendOpenAiError(reply, 400, 'max_tokens must be a positive integer.', 'invalid_request_error', 'invalid_max_tokens');
      return;
    }
    if (typeof maxTokens === 'number' && maxTokens > MAX_TOKENS) {
      request.audit!.errorCategory = 'invalid_request';
      sendOpenAiError(reply, 400, `max_tokens must be <= ${MAX_TOKENS}.`, 'invalid_request_error', 'max_tokens_too_large');
      return;
    }

    const stream = body.stream === true;
    request.audit!.stream = stream;
    const ipHash = hashClientIpFromRequest(request, config.ipHmacSecret);
    if (!ipHash) {
      request.audit!.errorCategory = 'invalid_ip';
      sendOpenAiError(reply, 400, 'A valid client IP address is required.', 'invalid_request_error', 'invalid_client_ip');
      return;
    }
    request.audit!.ipHashPrefix = ipHash.slice(0, 10);

    let reservation;
    try {
      reservation = await store.reserve({
        ipHash,
        now: currentTime,
        perIpRpmLimit: config.perIpRpmLimit,
        hourlyUniqueIpLimit: config.hourlyUniqueIpLimit,
        globalRequestLimit: config.globalRequestLimit,
        maxConcurrency: config.maxConcurrency,
        leaseTtlSeconds: config.leaseTtlSeconds,
      });
    } catch {
      request.audit!.errorCategory = 'upstream_error';
      sendOpenAiError(reply, 503, 'The proxy storage service is unavailable.', 'server_error', 'storage_unavailable');
      return;
    }

    if ('code' in reservation) {
      reservationFailureResponse(reply, request, reservation);
      return;
    }
    request.audit!.globalRequestCount = reservation.globalRequestCount;
    await proxyToUpstream(request, reply, body, reservation, options);
  });

  return app;
}

export { MAX_BODY_BYTES, MAX_TOKENS, hasExpectedBearer, isDisabled };
