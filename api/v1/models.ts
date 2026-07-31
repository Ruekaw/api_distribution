import type { VercelRequest, VercelResponse } from '@vercel/node';
import { loadConfig } from '../../src/config';

export default function handler(_req: VercelRequest, res: VercelResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');

  const modelName = process.env.MODEL_NAME?.trim() || 'claude-opus-4.6';
  res.status(200).json({
    object: 'list',
    data: [{ id: modelName, object: 'model', owned_by: 'proxy' }],
  });
}
