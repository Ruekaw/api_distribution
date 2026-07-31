import type { FastifyReply } from 'fastify';

export type ErrorCategory =
  | 'proxy_disabled'
  | 'unauthorized'
  | 'invalid_content_type'
  | 'invalid_json'
  | 'invalid_request'
  | 'invalid_ip'
  | 'hourly_unique_ip_limit'
  | 'per_ip_rpm_limit'
  | 'global_request_limit'
  | 'max_concurrency'
  | 'upstream_error'
  | 'upstream_http_error'
  | 'client_aborted';

export function sendOpenAiError(
  reply: FastifyReply,
  statusCode: number,
  message: string,
  type: string,
  code: string,
  retryAfterSeconds?: number,
): void {
  if (retryAfterSeconds !== undefined) {
    reply.header('Retry-After', String(Math.max(1, Math.ceil(retryAfterSeconds))));
  }
  reply
    .code(statusCode)
    .type('application/json; charset=utf-8')
    .send({ error: { message, type, code } });
}

export function secondsUntilNextMinute(now: Date): number {
  const next = new Date(now);
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(next.getUTCMinutes() + 1);
  return Math.max(1, (next.getTime() - now.getTime()) / 1000);
}

export function secondsUntilNextHour(now: Date): number {
  const next = new Date(now);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(next.getUTCHours() + 1);
  return Math.max(1, (next.getTime() - now.getTime()) / 1000);
}
