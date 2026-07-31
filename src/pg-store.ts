import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import type {
  QuotaStore,
  Reservation,
  ReservationFailure,
  ReservationInput,
} from './types';

const HOURLY_LOCK = 71024831;
const GLOBAL_LOCK = 71024832;
const CONCURRENCY_LOCK = 71024833;

class ReservationRejected extends Error {
  constructor(
    public readonly failure: ReservationFailure,
  ) {
    super(failure.code);
  }
}

export class PgQuotaStore implements QuotaStore {
  private readonly pool: Pool;
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(databaseUrl: string) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: 'dify-openai-chat-proxy',
    });
    this.cleanupTimer = setInterval(() => {
      void this.cleanupOldData();
    }, 6 * 60 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  async reserve(input: ReservationInput): Promise<Reservation | ReservationFailure> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // One transaction owns the hour admission, RPM, global count, and lease.
      // A failed later check rolls back all earlier reservations.
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [HOURLY_LOCK]);
      const alreadyAdmitted = await client.query(
        `
          SELECT 1
          FROM hourly_ip_admissions
          WHERE hour_bucket = date_trunc('hour', $1::timestamptz)
            AND ip_hash = $2
          LIMIT 1
        `,
        [input.now.toISOString(), input.ipHash],
      );

      if (alreadyAdmitted.rowCount === 0) {
        const total = await client.query<{ count: number }>(
          `
            SELECT COUNT(*)::int AS count
            FROM hourly_ip_admissions
            WHERE hour_bucket = date_trunc('hour', $1::timestamptz)
          `,
          [input.now.toISOString()],
        );
        if ((total.rows[0]?.count ?? 0) >= input.hourlyUniqueIpLimit) {
          throw new ReservationRejected({
            code: 'hourly_unique_ip_limit',
            retryAfterSeconds: secondsUntilNextHour(input.now),
          });
        }
        await client.query(
          `
            INSERT INTO hourly_ip_admissions (hour_bucket, ip_hash)
            VALUES (date_trunc('hour', $1::timestamptz), $2)
          `,
          [input.now.toISOString(), input.ipHash],
        );
      }

      const rpm = await client.query(
        `
          INSERT INTO ip_minute_usage (minute_bucket, ip_hash, request_count)
          VALUES (date_trunc('minute', $1::timestamptz), $2, 1)
          ON CONFLICT (minute_bucket, ip_hash) DO UPDATE
          SET request_count = ip_minute_usage.request_count + 1
          WHERE ip_minute_usage.request_count < $3
          RETURNING request_count
        `,
        [input.now.toISOString(), input.ipHash, input.perIpRpmLimit],
      );
      if (rpm.rowCount === 0) {
        throw new ReservationRejected({
          code: 'per_ip_rpm_limit',
          retryAfterSeconds: secondsUntilNextMinute(input.now),
        });
      }

      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [GLOBAL_LOCK]);
      const global = await client.query<{ request_count: number }>(
        `
          UPDATE global_usage
          SET request_count = request_count + 1, updated_at = NOW()
          WHERE scope = 'lifetime' AND request_count < $1
          RETURNING request_count
        `,
        [input.globalRequestLimit],
      );
      if (global.rowCount === 0) {
        throw new ReservationRejected({
          code: 'global_request_limit',
          retryAfterSeconds: 60,
        });
      }

      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [CONCURRENCY_LOCK]);
      await client.query('DELETE FROM concurrency_leases WHERE expires_at <= NOW()');
      const active = await client.query<{ count: number }>(
        'SELECT COUNT(*)::int AS count FROM concurrency_leases',
      );
      if ((active.rows[0]?.count ?? 0) >= input.maxConcurrency) {
        throw new ReservationRejected({
          code: 'max_concurrency',
          retryAfterSeconds: 10,
        });
      }

      const leaseId = randomUUID();
      await client.query(
        `
          INSERT INTO concurrency_leases (lease_id, acquired_at, expires_at)
          VALUES ($1::uuid, NOW(), NOW() + ($2::integer * INTERVAL '1 second'))
        `,
        [leaseId, input.leaseTtlSeconds],
      );
      await client.query('COMMIT');
      return {
        leaseId,
        globalRequestCount: global.rows[0]?.request_count ?? 0,
      } satisfies Reservation;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof ReservationRejected) return error.failure;
      throw error;
    } finally {
      client.release();
    }
  }

  async releaseLease(leaseId: string): Promise<void> {
    await this.pool.query('DELETE FROM concurrency_leases WHERE lease_id = $1::uuid', [leaseId]);
  }

  async getGlobalRequestCount(): Promise<number> {
    const result = await this.pool.query<{ request_count: number }>(
      "SELECT request_count FROM global_usage WHERE scope = 'lifetime'",
    );
    return result.rows[0]?.request_count ?? 0;
  }

  async close(): Promise<void> {
    clearInterval(this.cleanupTimer);
    await this.pool.end();
  }

  private async cleanupOldData(): Promise<void> {
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      await client.query("DELETE FROM ip_minute_usage WHERE minute_bucket < NOW() - INTERVAL '48 hours'");
      await client.query("DELETE FROM hourly_ip_admissions WHERE hour_bucket < NOW() - INTERVAL '48 hours'");
      await client.query('COMMIT');
    } catch {
      await client?.query('ROLLBACK').catch(() => undefined);
      // Cleanup is best effort and must never break a model request.
    } finally {
      client?.release();
    }
  }
}

function secondsUntilNextMinute(now: Date): number {
  const next = new Date(now);
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(next.getUTCMinutes() + 1);
  return Math.max(1, (next.getTime() - now.getTime()) / 1000);
}

function secondsUntilNextHour(now: Date): number {
  const next = new Date(now);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(next.getUTCHours() + 1);
  return Math.max(1, (next.getTime() - now.getTime()) / 1000);
}
