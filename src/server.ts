import { createApp } from './app';
import { loadConfig } from './config';
import { PgQuotaStore } from './pg-store';

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new PgQuotaStore(config.databaseUrl);
  const app = createApp({ config, store });

  const shutdown = async (): Promise<void> => {
    await app.close().catch(() => undefined);
    await store.close().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    await store.close().catch(() => undefined);
    console.error('Proxy failed to start.');
    process.exitCode = 1;
  }
}

void main();
