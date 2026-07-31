import { randomUUID } from 'node:crypto';
import type { Config } from '../src/config';
import type {
  QuotaStore,
  Reservation,
  ReservationFailure,
  ReservationInput,
} from '../src/types';

export const testConfig: Config = {
  upstreamUrl: 'https://upstream.invalid/v1/chat/completions',
  upstreamApiKey: 'upstream-secret-value',
  groupApiKey: 'group-secret-value',
  ipHmacSecret: 'ip-hmac-secret-value',
  modelName: 'claude-opus-4.6',
  perIpRpmLimit: 10,
  hourlyUniqueIpLimit: 10,
  globalRequestLimit: 150,
  disableAt: null,
  maxConcurrency: 3,
  leaseTtlSeconds: 900,
  databaseUrl: 'postgresql://unused.invalid/test',
  port: 3000,
  host: '127.0.0.1',
};

interface Lease {
  expiresAt: number;
}

export class MemoryQuotaStore implements QuotaStore {
  readonly minuteCounts = new Map<string, number>();
  readonly hourAdmissions = new Map<string, Set<string>>();
  readonly leases = new Map<string, Lease>();
  readonly reservationInputs: ReservationInput[] = [];
  globalCount = 0;

  async reserve(input: ReservationInput): Promise<Reservation | ReservationFailure> {
    this.reservationInputs.push(input);
    this.expireLeases(input.now);
    const minuteKey = `${Math.floor(input.now.getTime() / 60_000)}:${input.ipHash}`;
    const hourKey = String(Math.floor(input.now.getTime() / 3_600_000));
    const admitted = this.hourAdmissions.get(hourKey) ?? new Set<string>();
    const isNewIp = !admitted.has(input.ipHash);

    if (isNewIp && admitted.size >= input.hourlyUniqueIpLimit) {
      return { code: 'hourly_unique_ip_limit', retryAfterSeconds: secondsToBoundary(input.now, 3_600_000) };
    }
    const rpm = this.minuteCounts.get(minuteKey) ?? 0;
    if (rpm >= input.perIpRpmLimit) {
      return { code: 'per_ip_rpm_limit', retryAfterSeconds: secondsToBoundary(input.now, 60_000) };
    }
    if (this.globalCount >= input.globalRequestLimit) {
      return { code: 'global_request_limit', retryAfterSeconds: 60 };
    }
    if (this.leases.size >= input.maxConcurrency) {
      return { code: 'max_concurrency', retryAfterSeconds: 10 };
    }

    admitted.add(input.ipHash);
    this.hourAdmissions.set(hourKey, admitted);
    this.minuteCounts.set(minuteKey, rpm + 1);
    this.globalCount += 1;
    const leaseId = randomUUID();
    this.leases.set(leaseId, { expiresAt: input.now.getTime() + input.leaseTtlSeconds * 1000 });
    return { leaseId, globalRequestCount: this.globalCount };
  }

  async releaseLease(leaseId: string): Promise<void> {
    this.leases.delete(leaseId);
  }

  async getGlobalRequestCount(): Promise<number> {
    return this.globalCount;
  }

  async close(): Promise<void> {
    this.leases.clear();
  }

  expireLeases(now: Date): void {
    for (const [id, lease] of this.leases) {
      if (lease.expiresAt <= now.getTime()) this.leases.delete(id);
    }
  }
}

export interface RecordedFetch {
  calls: Array<{ input: string | URL | Request; init?: RequestInit }>;
  fetch: typeof fetch;
}

export function jsonFetch(
  responseBody: unknown = {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  },
  status = 200,
): RecordedFetch {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
  const implementation = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ input, init });
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, fetch: implementation as typeof fetch };
}

export function authHeaders(ip = '203.0.113.10'): Record<string, string> {
  return {
    authorization: `Bearer ${testConfig.groupApiKey}`,
    'content-type': 'application/json',
    'x-forwarded-for': ip,
  };
}

function secondsToBoundary(now: Date, bucketMs: number): number {
  return Math.max(1, (bucketMs - (now.getTime() % bucketMs)) / 1000);
}
