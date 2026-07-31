import { createHmac } from 'node:crypto';
import ipaddr from 'ipaddr.js';
import type { FastifyRequest } from 'fastify';

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

function firstValidForwardedIp(header: string | undefined): string | null {
  if (!header) return null;
  for (const candidate of header.split(',')) {
    const normalized = parseAndNormalize(candidate);
    if (normalized) return normalized;
  }
  return null;
}

export function extractClientIp(request: FastifyRequest): string | null {
  const forwardedHeader = request.headers['x-forwarded-for'];
  const forwarded = firstValidForwardedIp(
    Array.isArray(forwardedHeader) ? forwardedHeader.join(',') : forwardedHeader,
  );
  if (forwarded) return forwarded;

  const real = request.headers['x-real-ip'];
  const realIp = parseAndNormalize(Array.isArray(real) ? real[0] ?? '' : real ?? '');
  if (realIp) return realIp;

  return parseAndNormalize(request.ip);
}

export function hashClientIp(ip: string, secret: string): string {
  return createHmac('sha256', secret).update(ip, 'utf8').digest('hex');
}

export function hashClientIpFromRequest(request: FastifyRequest, secret: string): string | null {
  const ip = extractClientIp(request);
  return ip ? hashClientIp(ip, secret) : null;
}
