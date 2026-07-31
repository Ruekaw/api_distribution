/**
 * Aurora PostgreSQL connection pool using IAM / OIDC authentication.
 * Module-level singleton — hot Vercel instances reuse the same Pool.
 * Never stores a static password; the Signer fetches a short-lived token
 * on each connection attempt.
 */
import { Pool } from 'pg';
import { Signer } from '@aws-sdk/rds-signer';
import { awsCredentialsProvider } from '@vercel/functions/oidc';
import { attachDatabasePool } from '@vercel/functions';

const signer = new Signer({
  credentials: awsCredentialsProvider({
    roleArn: process.env.AWS_ROLE_ARN!,
    clientConfig: { region: process.env.AWS_REGION },
  }),
  region: process.env.AWS_REGION!,
  hostname: process.env.PGHOST!,
  username: process.env.PGUSER ?? 'postgres',
  port: Number(process.env.PGPORT ?? 5432),
});

export const pool = new Pool({
  host: process.env.PGHOST,
  database: process.env.PGDATABASE ?? 'postgres',
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? 'postgres',
  // Auth token is valid ≤15 min; fetch fresh on each new connection.
  password: () => signer.getAuthToken(),
  ssl: { rejectUnauthorized: false },
  // Small pool per serverless instance.
  max: 3,
  idleTimeoutMillis: 20_000,
  connectionTimeoutMillis: 10_000,
  application_name: 'dify-openai-chat-proxy',
});

attachDatabasePool(pool);
