import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import { PgQuotaStore } from '../src/pg-store';

const databaseUrl = process.env.TEST_DATABASE_URL;

async function resetDatabase(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
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
    leaseTtlSeconds: overrides.leaseTtlSeconds ?? 900,
  };
}

test('PostgreSQL: two store instances cannot both win the tenth hourly slot', { skip: !databaseUrl }, async () => {
  await resetDatabase();
  const firstStore = new PgQuotaStore(databaseUrl!);
  const secondStore = new PgQuotaStore(databaseUrl!);
  try {
    for (let i = 1; i <= 9; i += 1) {
      const reservation = await firstStore.reserve(input(String(i).padStart(64, '0')));
      assert.ok('leaseId' in reservation);
      await firstStore.releaseLease(reservation.leaseId);
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

test('PostgreSQL: two store instances cannot overrun the last global slot', { skip: !databaseUrl }, async () => {
  await resetDatabase();
  const firstStore = new PgQuotaStore(databaseUrl!);
  const secondStore = new PgQuotaStore(databaseUrl!);
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

test('PostgreSQL: an expired lease is reclaimed before the concurrency check', { skip: !databaseUrl }, async () => {
  await resetDatabase();
  const pool = new Pool({ connectionString: databaseUrl });
  await pool.query(`
    INSERT INTO concurrency_leases (lease_id, acquired_at, expires_at)
    VALUES ('00000000-0000-4000-8000-000000000001', NOW() - INTERVAL '2 minutes', NOW() - INTERVAL '1 minute')
  `);
  await pool.end();
  const store = new PgQuotaStore(databaseUrl!);
  try {
    const reservation = await store.reserve(input('a'.repeat(64), { maxConcurrency: 1 }));
    assert.ok('leaseId' in reservation);
  } finally {
    await store.close();
  }
});
