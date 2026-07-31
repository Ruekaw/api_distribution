export interface Config {
  upstreamUrl: string;
  upstreamApiKey: string;
  groupApiKey: string;
  ipHmacSecret: string;
  modelName: string;
  perIpRpmLimit: number;
  hourlyUniqueIpLimit: number;
  globalRequestLimit: number;
  disableAt: Date | null;
  maxConcurrency: number;
  leaseTtlSeconds: number;
  databaseUrl: string;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function integer(name: string, fallback: number, minimum: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}.`);
  }
  return value;
}

function url(name: string): string {
  const value = required(name);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL.`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`${name} must use http or https.`);
  }
  const normalizedPath = parsed.pathname.replace(/\/+$/, '');
  if (name === 'UPSTREAM_URL' && !normalizedPath.endsWith('/v1/chat/completions')) {
    throw new Error('UPSTREAM_URL must be the complete /v1/chat/completions URL.');
  }
  return parsed.toString();
}

function disableAt(): Date | null {
  const raw = process.env.DISABLE_AT?.trim();
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new Error('DISABLE_AT must be a valid ISO 8601 timestamp.');
  }
  return date;
}

export function loadConfig(): Config {
  return {
    upstreamUrl: url('UPSTREAM_URL'),
    upstreamApiKey: required('UPSTREAM_API_KEY'),
    groupApiKey: required('GROUP_API_KEY'),
    ipHmacSecret: required('IP_HMAC_SECRET'),
    modelName: process.env.MODEL_NAME?.trim() || 'claude-opus-4.6',
    perIpRpmLimit: integer('PER_IP_RPM_LIMIT', 10, 1),
    hourlyUniqueIpLimit: integer('HOURLY_UNIQUE_IP_LIMIT', 10, 1),
    globalRequestLimit: integer('GLOBAL_REQUEST_LIMIT', 150, 1),
    disableAt: disableAt(),
    maxConcurrency: integer('MAX_CONCURRENCY', 3, 1),
    leaseTtlSeconds: integer('LEASE_TTL_SECONDS', 360, 1),
    databaseUrl: required('DATABASE_URL'),
  };
}
