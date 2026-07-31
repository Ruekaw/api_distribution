/**
 * Idempotent schema migration runner.
 *
 * Usage (after pulling env vars from Vercel):
 *   vercel env pull .env.local --environment=production
 *   npm run migrate
 *
 * The script uses IAM / OIDC authentication when AWS_ROLE_ARN is set,
 * or falls back to a direct SSL connection via PGHOST/PGUSER etc.
 * It never reads a DATABASE_URL or stores a permanent password.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';

async function buildPool(): Promise<Pool> {
  const host = process.env.PGHOST;
  const port = Number(process.env.PGPORT ?? 5432);
  const user = process.env.PGUSER ?? 'postgres';
  const database = process.env.PGDATABASE ?? 'postgres';
  const roleArn = process.env.AWS_ROLE_ARN;
  const region = process.env.AWS_REGION;

  if (!host) throw new Error('PGHOST is required for migrations.');

  if (roleArn && region) {
    // IAM auth via RDS Signer (same as production).
    const { Signer } = await import('@aws-sdk/rds-signer');
    const { awsCredentialsProvider } = await import('@vercel/functions/oidc');
    const signer = new Signer({
      credentials: awsCredentialsProvider({ roleArn, clientConfig: { region } }),
      region,
      hostname: host,
      username: user,
      port,
    });
    return new Pool({
      host, port, user, database,
      password: () => signer.getAuthToken(),
      ssl: { rejectUnauthorized: false },
      max: 2,
      application_name: 'dify-openai-chat-proxy-migrate',
    });
  }

  // Local/CI fallback — expects PGPASSWORD in env.
  return new Pool({
    host, port, user, database,
    ssl: process.env.PGSSLMODE !== 'disable' ? { rejectUnauthorized: false } : undefined,
    max: 2,
    application_name: 'dify-openai-chat-proxy-migrate',
  });
}

async function migrate(): Promise<void> {
  const pool = await buildPool();
  const migrationsDir = path.resolve(process.cwd(), 'migrations');
  const files = (await readdir(migrationsDir))
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();

  const client = await pool.connect();
  try {
    // Bootstrap the migrations table under a serialized advisory lock.
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [801274061]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query('COMMIT');

    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      const migClient = await pool.connect();
      try {
        await migClient.query('BEGIN');
        await migClient.query('SELECT pg_advisory_xact_lock($1::bigint)', [801274061]);
        const existing = await migClient.query(
          'SELECT 1 FROM schema_migrations WHERE version = $1',
          [version],
        );
        if (existing.rowCount === 0) {
          const sql = await readFile(path.join(migrationsDir, file), 'utf8');
          await migClient.query(sql);
          await migClient.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
          console.log(`Applied migration: ${version}`);
        } else {
          console.log(`Skipped (already applied): ${version}`);
        }
        await migClient.query('COMMIT');
      } catch (err) {
        await migClient.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        migClient.release();
      }
    }
    console.log('Migration complete.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(() => {
  // Do not print connection details or query parameters.
  console.error('Database migration failed. Check Aurora connectivity and IAM permissions.');
  process.exitCode = 1;
});
