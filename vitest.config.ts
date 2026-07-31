import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
      miniflare: {
        bindings: {
          UPSTREAM_URL: "https://upstream.example/v1/chat/completions",
          UPSTREAM_API_KEY: "test-upstream-key",
          GROUP_API_KEY: "test-group-key",
          IP_HMAC_SECRET: "test-ip-hmac-secret",
        },
      },
    }),
  ],
  test: {
    fileParallelism: false,
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
  },
});
