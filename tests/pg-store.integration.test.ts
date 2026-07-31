/**
 * Integration tests for PgQuotaStore against a real Aurora / PostgreSQL database.
 * These are skipped unless TEST_DATABASE_URL is set (Aurora IAM is handled by
 * the module-level pool in src/db.ts; for local testing, set PGHOST/PGUSER etc.).
 *
 * Run manually:
 *   TEST_DATABASE_URL=postgresql://... npm run test -- tests/pg-store.integration.test.ts
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import { PgQuotaStore } from '../src/pg-store';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const skip = !testDatabaseUrl;

async function resetDatabase(): Promise<void> {
  const pool = new Pool({ connectionString: testDatabaseUrl });
  try {
    const migration = await readFile(path.resolve(process.cwd(), 'migrations/001_initial.sql'), 'utf8');
    await pool.query(migration);
    await pool.query('TRUNCATE ip_minute_usage, hourly_ip_admissions, concurrency_leases');
    await pool.query("UPDATE global_usage SET request_count = 0, updated_at = NOW() WHERE scope = 'lifetime'");
  } finally {
    await pool.end();
  }
}

function input(ipHash: string, overrides: Record<string, number> = {}) {
  return {
    ipHash,
    now: new Date('2026-01-01T12:30:00.000Z'),
    perIpRpmLimit: overrides.perIpRpmLimit ?? 100,
    hourlyUniqueIpLimit: overrides.hourlyUniqueIpLimit ?? 10,
    globalRequestLimit: overrides.globalRequestLimit ?? 100,
    maxConcurrency: overrides.maxConcurrency ?? 100,
    leaseTtlSeconds: overrides.leaseTtlSeconds ?? 360,
  };
}

test('PostgreSQL: two store instances cannot both win the tenth hourly slot', { skip }, async () => {
  await resetDatabase();
  // PgQuotaStore now uses the shared module-level Aurora pool; both instances
  // share the same connection pool in-process.
  const firstStore = new PgQuotaStore();
  const secondStore = new PgQuotaStore();
  try {
    for (let i = 1; i <= 9; i += 1) {
      const reservation = await firstStore.reserve(input(String(i).padStart(64, '0')));
      assert.ok('leaseId' in reservation);
      await firstStore.releaseLease((reservation as { leaseId: string }).leaseId);
    }
    const contenders = await Promise.all([
      firstStore.reserve(input('a'.repeat(64))),
      secondStore.reserve(input('b'.repeat(64))),
    ]);
    assert.equal(contenders.filter((result) => 'leaseId' in result).length, 1);
    assert.equal(contenders.filter((result) => 'code' in result && result.code === 'hourly_unique_ip_limit').length, 1);
  } finally {
    await firstStore.close();
    await secondStore.close();
  }
});

test('PostgreSQL: two store instances cannot overrun the last global slot', { skip }, async () => {
  await resetDatabase();
  const firstStore = new PgQuotaStore();
  const secondStore = new PgQuotaStore();
  try {
    const contenders = await Promise.all([
      firstStore.reserve(input('a'.repeat(64), { globalRequestLimit: 1 })),
      secondStore.reserve(input('b'.repeat(64), { globalRequestLimit: 1 })),
    ]);
    assert.equal(contenders.filter((result) => 'leaseId' in result).length, 1);
    assert.equal(contenders.filter((result) => 'code' in result && result.code === 'global_request_limit').length, 1);
    assert.equal(await firstStore.getGlobalRequestCount(), 1);
  } finally {
    await firstStore.close();
    await secondStore.close();
  }
});

test('PostgreSQL: an expired lease is reclaimed before the concurrency check', { skip }, async () => {
  await resetDatabase();
  const pool = new Pool({ connectionString: testDatabaseUrl });
  await pool.query(`
    INSERT INTO concurrency_leases (lease_id, acquired_at, expires_at)
    VALUES ('00000000-0000-4000-8000-000000000001', NOW() - INTERVAL '2 minutes', NOW() - INTERVAL '1 minute')
  `);
  await pool.end();
  const store = new PgQuotaStore();
  try {
    const reservation = await store.reserve(input('a'.repeat(64), { maxConcurrency: 1 }));
    assert.ok('leaseId' in reservation);
  } finally {
    await store.close();
  }
});
