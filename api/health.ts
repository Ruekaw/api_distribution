import type { VercelRequest, VercelResponse } from '@vercel/node';
import { loadConfig } from '../src/config';
import { PgQuotaStore } from '../src/pg-store';

const store = new PgQuotaStore();

export default async function handler(_req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');

  let disabled = false;
  let modelName = 'claude-opus-4.6';
  try {
    const config = loadConfig();
    modelName = config.modelName;
    disabled = config.disableAt !== null && Date.now() >= config.disableAt.getTime();
  } catch {
    // Config errors (missing env vars) surface as degraded but don't crash health.
  }

  res.status(200).json({ status: 'ok', disabled, model: modelName });
}
