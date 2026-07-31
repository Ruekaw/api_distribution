import type { ProxyConfig } from "./types";

const ISO_8601_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;

class ConfigValidationError extends Error {}

function required(env: Env, name: keyof Env): string {
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigValidationError("invalid_configuration");
  }
  return value.trim();
}

function integer(
  env: Env,
  name: keyof Env,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) {
    throw new ConfigValidationError("invalid_configuration");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ConfigValidationError("invalid_configuration");
  }
  return value;
}

function upstreamUrl(env: Env): string {
  const raw = required(env, "UPSTREAM_URL");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigValidationError("invalid_configuration");
  }
  if (parsed.protocol !== "https:") {
    throw new ConfigValidationError("invalid_configuration");
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  if (!path.endsWith("/v1/chat/completions")) {
    throw new ConfigValidationError("invalid_configuration");
  }
  return parsed.toString();
}

function disableAt(env: Env): number | null {
  const raw = env.DISABLE_AT?.trim();
  if (!raw) return null;
  const match = ISO_8601_PATTERN.exec(raw);
  if (match === null) {
    throw new ConfigValidationError("invalid_configuration");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  const daysInMonth =
    month >= 1 && month <= 12
      ? new Date(Date.UTC(year, month, 0)).getUTCDate()
      : 0;
  if (
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 14 ||
    offsetMinute > 59 ||
    (offsetHour === 14 && offsetMinute !== 0)
  ) {
    throw new ConfigValidationError("invalid_configuration");
  }
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) {
    throw new ConfigValidationError("invalid_configuration");
  }
  return timestamp;
}

export function getConfig(env: Env): ProxyConfig {
  const leaseTtlSeconds = integer(env, "LEASE_TTL_SECONDS", 180, 2, 86_400);
  const leaseHeartbeatSeconds = integer(
    env,
    "LEASE_HEARTBEAT_SECONDS",
    60,
    1,
    3_600,
  );
  if (leaseHeartbeatSeconds >= leaseTtlSeconds) {
    throw new ConfigValidationError("invalid_configuration");
  }

  const quotaScope = required(env, "QUOTA_SCOPE");
  if (quotaScope.length > 128) {
    throw new ConfigValidationError("invalid_configuration");
  }
  const modelName = required(env, "MODEL_NAME");
  if (modelName.length > 128) {
    throw new ConfigValidationError("invalid_configuration");
  }

  return {
    upstreamUrl: upstreamUrl(env),
    upstreamApiKey: required(env, "UPSTREAM_API_KEY"),
    groupApiKey: required(env, "GROUP_API_KEY"),
    ipHmacSecret: required(env, "IP_HMAC_SECRET"),
    modelName,
    perIpRpmLimit: integer(env, "PER_IP_RPM_LIMIT", 10, 1, 10_000),
    hourlyUniqueIpLimit: integer(
      env,
      "HOURLY_UNIQUE_IP_LIMIT",
      10,
      1,
      10_000,
    ),
    globalRequestLimit: integer(
      env,
      "GLOBAL_REQUEST_LIMIT",
      150,
      1,
      10_000_000,
    ),
    maxConcurrency: integer(env, "MAX_CONCURRENCY", 3, 1, 1_000),
    leaseTtlSeconds,
    leaseHeartbeatSeconds,
    maxOutputTokens: integer(
      env,
      "MAX_OUTPUT_TOKENS",
      16_384,
      1,
      1_000_000,
    ),
    maxBodyBytes: integer(
      env,
      "MAX_BODY_BYTES",
      4 * 1024 * 1024,
      1_024,
      16 * 1024 * 1024,
    ),
    disableAt: disableAt(env),
    quotaScope,
  };
}

export function isConfigValidationError(error: unknown): boolean {
  return error instanceof ConfigValidationError;
}
