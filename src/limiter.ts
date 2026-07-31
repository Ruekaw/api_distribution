import { DurableObject } from "cloudflare:workers";
import type {
  AcquireFailure,
  AcquireInput,
  AcquireResult,
  AcquireSuccess,
  LimiterStatus,
} from "./types";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;

class AcquireRejected extends Error {
  constructor(readonly result: AcquireFailure) {
    super(result.code);
  }
}

export class ProxyLimiter extends DurableObject<Env> {
  constructor(
    private readonly state: DurableObjectState,
    env: Env,
  ) {
    super(state, env);
    this.initializeSchema();
  }

  acquire(input: AcquireInput): AcquireResult {
    this.validateInput(input);
    this.cleanupOldDataBestEffort(input.nowMs);

    try {
      return this.state.storage.transactionSync(() => {
        const sql = this.state.storage.sql;
        const minuteBucket = Math.floor(input.nowMs / 60_000);
        const hourBucket = Math.floor(input.nowMs / 3_600_000);

        sql.exec(
          "DELETE FROM concurrency_leases WHERE expires_at <= ?",
          input.nowMs,
        );

        const admitted = sql
          .exec<{ present: number }>(
            `SELECT 1 AS present
             FROM hourly_ip_admissions
             WHERE hour_bucket = ? AND ip_hash = ?
             LIMIT 1`,
            hourBucket,
            input.ipHash,
          )
          .toArray();

        if (admitted.length === 0) {
          const { count } = sql
            .exec<{ count: number }>(
              `SELECT COUNT(*) AS count
               FROM hourly_ip_admissions
               WHERE hour_bucket = ?`,
              hourBucket,
            )
            .one();
          if (count >= input.hourlyUniqueIpLimit) {
            throw new AcquireRejected({
              ok: false,
              code: "hourly_unique_ip_limit",
              retryAfterSeconds: secondsUntilBucket(input.nowMs, 3_600_000),
            });
          }
          sql.exec(
            `INSERT INTO hourly_ip_admissions
               (hour_bucket, ip_hash, admitted_at)
             VALUES (?, ?, ?)`,
            hourBucket,
            input.ipHash,
            input.nowMs,
          );
        }

        const minuteUsage = sql
          .exec<{ request_count: number }>(
            `INSERT INTO ip_minute_usage
               (minute_bucket, ip_hash, request_count)
             VALUES (?, ?, 1)
             ON CONFLICT (minute_bucket, ip_hash) DO UPDATE
             SET request_count = request_count + 1
             RETURNING request_count`,
            minuteBucket,
            input.ipHash,
          )
          .one();
        if (minuteUsage.request_count > input.perIpRpmLimit) {
          throw new AcquireRejected({
            ok: false,
            code: "per_ip_rpm_limit",
            retryAfterSeconds: secondsUntilBucket(input.nowMs, 60_000),
          });
        }

        const globalUsage = sql
          .exec<{ request_count: number }>(
            `INSERT INTO global_usage (scope, request_count, updated_at)
             VALUES (?, 1, ?)
             ON CONFLICT (scope) DO UPDATE
             SET request_count = request_count + 1,
                 updated_at = excluded.updated_at
             RETURNING request_count`,
            input.quotaScope,
            input.nowMs,
          )
          .one();
        if (globalUsage.request_count > input.globalRequestLimit) {
          throw new AcquireRejected({
            ok: false,
            code: "global_request_limit",
          });
        }

        const { count: activeLeaseCount } = sql
          .exec<{ count: number }>(
            `SELECT COUNT(*) AS count
             FROM concurrency_leases
             WHERE expires_at > ?`,
            input.nowMs,
          )
          .one();
        if (activeLeaseCount >= input.maxConcurrency) {
          throw new AcquireRejected({
            ok: false,
            code: "max_concurrency",
            retryAfterSeconds: 10,
          });
        }

        const leaseId = crypto.randomUUID();
        sql.exec(
          `INSERT INTO concurrency_leases
             (lease_id, acquired_at, expires_at)
           VALUES (?, ?, ?)`,
          leaseId,
          input.nowMs,
          input.nowMs + input.leaseTtlSeconds * 1000,
        );

        return {
          ok: true,
          leaseId,
          globalRequestCount: globalUsage.request_count,
        } satisfies AcquireSuccess;
      });
    } catch (error) {
      if (error instanceof AcquireRejected) return error.result;
      throw error;
    }
  }

  release(leaseId: string): boolean {
    if (!isLeaseId(leaseId)) return false;
    const cursor = this.state.storage.sql.exec(
      "DELETE FROM concurrency_leases WHERE lease_id = ?",
      leaseId,
    );
    return cursor.rowsWritten > 0;
  }

  renew(leaseId: string, ttlSeconds: number): boolean {
    if (
      !isLeaseId(leaseId) ||
      !Number.isSafeInteger(ttlSeconds) ||
      ttlSeconds < 2 ||
      ttlSeconds > 86_400
    ) {
      return false;
    }
    const nowMs = Date.now();
    const cursor = this.state.storage.sql.exec(
      `UPDATE concurrency_leases
       SET expires_at = ?
       WHERE lease_id = ? AND expires_at > ?`,
      nowMs + ttlSeconds * 1000,
      leaseId,
      nowMs,
    );
    return cursor.rowsWritten > 0;
  }

  getStatus(nowMs = Date.now()): LimiterStatus {
    const sql = this.state.storage.sql;
    const globalUsage = sql
      .exec<{ scope: string; request_count: number }>(
        `SELECT scope, request_count
         FROM global_usage
         ORDER BY scope`,
      )
      .toArray()
      .map((row) => ({
        scope: row.scope,
        requestCount: row.request_count,
      }));
    const { active } = sql
      .exec<{ active: number }>(
        "SELECT COUNT(*) AS active FROM concurrency_leases WHERE expires_at > ?",
        nowMs,
      )
      .one();
    const { total } = sql
      .exec<{ total: number }>(
        "SELECT COUNT(*) AS total FROM concurrency_leases",
      )
      .one();
    const { hourly } = sql
      .exec<{ hourly: number }>(
        "SELECT COUNT(*) AS hourly FROM hourly_ip_admissions",
      )
      .one();
    const { minute } = sql
      .exec<{ minute: number }>(
        "SELECT COUNT(*) AS minute FROM ip_minute_usage",
      )
      .one();
    return {
      globalUsage,
      activeLeaseCount: active,
      totalLeaseCount: total,
      hourlyAdmissionCount: hourly,
      minuteUsageCount: minute,
    };
  }

  private initializeSchema(): void {
    const sql = this.state.storage.sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS ip_minute_usage (
        minute_bucket INTEGER NOT NULL,
        ip_hash TEXT NOT NULL,
        request_count INTEGER NOT NULL,
        PRIMARY KEY (minute_bucket, ip_hash)
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS hourly_ip_admissions (
        hour_bucket INTEGER NOT NULL,
        ip_hash TEXT NOT NULL,
        admitted_at INTEGER NOT NULL,
        PRIMARY KEY (hour_bucket, ip_hash)
      )
    `);
    sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_hourly_ip_admissions_bucket
      ON hourly_ip_admissions(hour_bucket)
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS global_usage (
        scope TEXT PRIMARY KEY,
        request_count INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS concurrency_leases (
        lease_id TEXT PRIMARY KEY,
        acquired_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
    sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_concurrency_leases_expiry
      ON concurrency_leases(expires_at)
    `);
    sql.exec(
      `INSERT OR IGNORE INTO schema_meta (key, value)
       VALUES ('schema_version', '1'), ('last_cleanup_at', '0')`,
    );
  }

  private cleanupOldDataBestEffort(nowMs: number): void {
    try {
      const row = this.state.storage.sql
        .exec<{ value: string }>(
          "SELECT value FROM schema_meta WHERE key = 'last_cleanup_at'",
        )
        .one();
      const lastCleanupAt = Number(row.value);
      if (
        Number.isFinite(lastCleanupAt) &&
        nowMs - lastCleanupAt < SIX_HOURS_MS
      ) {
        return;
      }

      this.state.storage.transactionSync(() => {
        const sql = this.state.storage.sql;
        const oldestMinuteBucket = Math.floor(
          (nowMs - FORTY_EIGHT_HOURS_MS) / 60_000,
        );
        const oldestHourBucket = Math.floor(
          (nowMs - FORTY_EIGHT_HOURS_MS) / 3_600_000,
        );
        sql.exec(
          "DELETE FROM ip_minute_usage WHERE minute_bucket < ?",
          oldestMinuteBucket,
        );
        sql.exec(
          "DELETE FROM hourly_ip_admissions WHERE hour_bucket < ?",
          oldestHourBucket,
        );
        sql.exec(
          "DELETE FROM concurrency_leases WHERE expires_at <= ?",
          nowMs,
        );
        sql.exec(
          `UPDATE schema_meta
           SET value = ?
           WHERE key = 'last_cleanup_at'`,
          String(nowMs),
        );
      });
    } catch {
      // Historical cleanup is best effort. acquire() still performs the
      // correctness-critical expired lease deletion in its own transaction.
    }
  }

  private validateInput(input: AcquireInput): void {
    const positiveIntegers = [
      input.nowMs,
      input.perIpRpmLimit,
      input.hourlyUniqueIpLimit,
      input.globalRequestLimit,
      input.maxConcurrency,
      input.leaseTtlSeconds,
    ];
    if (
      !/^[a-f0-9]{64}$/.test(input.ipHash) ||
      input.quotaScope.length < 1 ||
      input.quotaScope.length > 128 ||
      positiveIntegers.some(
        (value) => !Number.isSafeInteger(value) || value < 1,
      )
    ) {
      throw new TypeError("Invalid limiter input.");
    }
  }
}

function secondsUntilBucket(nowMs: number, bucketMs: number): number {
  return Math.max(
    1,
    Math.ceil(((Math.floor(nowMs / bucketMs) + 1) * bucketMs - nowMs) / 1000),
  );
}

function isLeaseId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
