import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for migrations.');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 2,
  application_name: 'dify-openai-chat-proxy-migrate',
});

async function migrate(): Promise<void> {
  const migrationsDir = path.resolve(process.cwd(), 'migrations');
  const files = (await readdir(migrationsDir))
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .sort();

  const client = await pool.connect();
  try {
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
      const migrationClient = await pool.connect();
      try {
        await migrationClient.query('BEGIN');
        await migrationClient.query('SELECT pg_advisory_xact_lock($1::bigint)', [801274061]);
        const existing = await migrationClient.query(
          'SELECT 1 FROM schema_migrations WHERE version = $1',
          [version],
        );
        if (existing.rowCount === 0) {
          const sql = await readFile(path.join(migrationsDir, file), 'utf8');
          await migrationClient.query(sql);
          await migrationClient.query(
            'INSERT INTO schema_migrations (version) VALUES ($1)',
            [version],
          );
        }
        await migrationClient.query('COMMIT');
      } catch (error) {
        await migrationClient.query('ROLLBACK');
        throw error;
      } finally {
        migrationClient.release();
      }
    }
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The transaction may already have been committed before a later migration failed.
    }
    throw error;
  } finally {
    client.release();
  }
}

migrate()
  .catch((error: unknown) => {
    // Do not print the connection string or query parameters.
    console.error('Database migration failed.');
    process.exitCode = 1;
  })
  .finally(() => pool.end());
