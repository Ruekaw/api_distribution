import type { ErrorBody } from "./types";

export function applyCommonHeaders(headers: Headers): Headers {
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Cache-Control", "no-store");
  return headers;
}

export function jsonResponse(
  body: unknown,
  status = 200,
  additionalHeaders?: HeadersInit,
): Response {
  const headers = applyCommonHeaders(new Headers(additionalHeaders));
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers });
}

export function openAiError(
  status: number,
  message: string,
  type: string,
  code: string,
  retryAfterSeconds?: number,
): Response {
  const headers = new Headers();
  if (retryAfterSeconds !== undefined) {
    headers.set("Retry-After", String(Math.max(1, Math.ceil(retryAfterSeconds))));
  }
  const body: ErrorBody = { error: { message, type, code } };
  return jsonResponse(body, status, headers);
}

export function storageUnavailable(): Response {
  return openAiError(
    503,
    "The proxy storage service is unavailable.",
    "server_error",
    "storage_unavailable",
  );
}
