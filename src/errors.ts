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

const COMMON_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
} as const;

export function makeOpenAiError(
  statusCode: number,
  message: string,
  type: string,
  code: string,
  retryAfterSeconds?: number,
): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    ...COMMON_HEADERS,
  };
  if (retryAfterSeconds !== undefined) {
    headers['Retry-After'] = String(Math.max(1, Math.ceil(retryAfterSeconds)));
  }
  return new Response(JSON.stringify({ error: { message, type, code } }), {
    status: statusCode,
    headers,
  });
}

export function addCommonHeaders(headers: Headers): void {
  for (const [k, v] of Object.entries(COMMON_HEADERS)) {
    headers.set(k, v);
  }
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
