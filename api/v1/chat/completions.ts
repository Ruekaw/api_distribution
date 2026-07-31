import type { VercelRequest, VercelResponse } from '@vercel/node';
import { loadConfig } from '../../../src/config';
import { PgQuotaStore } from '../../../src/pg-store';
import { handleRequest } from '../../../src/app';

// Module-level singleton — reused across warm invocations.
const store = new PgQuotaStore();

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const config = loadConfig();

  // Convert Vercel/Node IncomingMessage to Web API Request so handleRequest can
  // process it uniformly.
  const bodyStream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      req.on('data', (chunk: Buffer) => ctrl.enqueue(chunk));
      req.on('end', () => ctrl.close());
      req.on('error', (err) => ctrl.error(err));
    },
  });

  // Abort signal wired to the client connection.
  const controller = new AbortController();
  req.once('close', () => controller.abort());
  req.once('aborted', () => controller.abort());

  const proto = (req.headers['x-forwarded-proto'] as string) || 'https';
  const host = (req.headers['host'] as string) || 'proxy.vercel.app';
  const webReq = new Request(`${proto}://${host}${req.url ?? '/v1/chat/completions'}`, {
    method: req.method ?? 'POST',
    headers: req.headers as Record<string, string>,
    body: bodyStream,
    // @ts-expect-error Node 18+ supports duplex
    duplex: 'half',
    signal: controller.signal,
  });

  const webRes = await handleRequest(webReq, { config, store });

  res.statusCode = webRes.status;
  webRes.headers.forEach((value, key) => {
    // Never forward content-encoding — Vercel handles compression.
    if (key.toLowerCase() === 'content-encoding') return;
    res.setHeader(key, value);
  });

  const isStream = (webRes.headers.get('content-type') ?? '').includes('text/event-stream');

  if (webRes.body) {
    const reader = webRes.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.writableEnded) {
          await new Promise<void>((resolve, reject) => {
            res.write(value, (err) => (err ? reject(err) : resolve()));
          });
          if (isStream) {
            (res as unknown as { flush?: () => void }).flush?.();
          }
        }
      }
    } catch {
      // Client disconnected.
    } finally {
      reader.releaseLock();
    }
  }
  if (!res.writableEnded) res.end();
}
