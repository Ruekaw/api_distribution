interface Env {
  UPSTREAM_URL: string;
  UPSTREAM_API_KEY: string;
  GROUP_API_KEY: string;
  IP_HMAC_SECRET: string;
  DISABLE_AT?: string;
}

declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {}
}
