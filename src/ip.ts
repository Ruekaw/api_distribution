import { createHmac } from 'node:crypto';
import ipaddr from 'ipaddr.js';

/** A minimal headers interface compatible with both Web API Headers and plain objects. */
export type HeadersLike = {
  get(name: string): string | null;
};

function parseAndNormalize(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128) return null;
  try {
    const address = ipaddr.parse(trimmed);
    if (address instanceof ipaddr.IPv6 && address.isIPv4MappedAddress()) {
      return address.toIPv4Address().toString();
    }
    return address.toString();
  } catch {
    return null;
  }
}

function firstValidForwardedIp(header: string | null | undefined): string | null {
  if (!header) return null;
  for (const candidate of header.split(',')) {
    const normalized = parseAndNormalize(candidate);
    if (normalized) return normalized;
  }
  return null;
}

/**
 * Extract and normalise the real client IP from request headers.
 * Priority (Vercel deployment order):
 *   1. x-vercel-forwarded-for  (set by Vercel edge, single trusted IP)
 *   2. x-forwarded-for         (first address only)
 *   3. x-real-ip
 */
export function extractClientIp(headers: HeadersLike): string | null {
  const vercelForwarded = firstValidForwardedIp(headers.get('x-vercel-forwarded-for'));
  if (vercelForwarded) return vercelForwarded;

  const forwarded = firstValidForwardedIp(headers.get('x-forwarded-for'));
  if (forwarded) return forwarded;

  return parseAndNormalize(headers.get('x-real-ip') ?? '');
}

export function hashClientIp(ip: string, secret: string): string {
  return createHmac('sha256', secret).update(ip, 'utf8').digest('hex');
}

export function hashClientIpFromHeaders(headers: HeadersLike, secret: string): string | null {
  const ip = extractClientIp(headers);
  return ip ? hashClientIp(ip, secret) : null;
}
