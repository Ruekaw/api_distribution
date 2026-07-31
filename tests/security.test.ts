import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { getConfig } from "../src/config";
import { hashClientIp, normalizeIp } from "../src/ip";
import { ProxyLimiter } from "../src/limiter";
import worker from "../src/index";
import {
  chatRequest,
  invoke,
  responseJson,
  testEnv,
  TEST_GROUP_KEY,
  TEST_HMAC_SECRET,
  TEST_UPSTREAM_KEY,
  TEST_UPSTREAM_URL,
} from "./helpers";

function mockOk() {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        choices: [
          { message: { role: "assistant", content: "OK" } },
        ],
      }),
      { headers: { "Content-Type": "application/json" } },
    ),
  );
}

describe("configuration and security boundaries", () => {
  it.each([
    "http://example.com/v1/chat/completions",
    "https://example.com/v1",
    "not-a-url",
  ])("rejects an invalid upstream URL: %s", (upstreamUrl) => {
    expect(() => getConfig(testEnv({ UPSTREAM_URL: upstreamUrl }))).toThrow();
  });

  it("accepts an absolute HTTPS Chat Completions URL", () => {
    expect(
      getConfig(
        testEnv({
          UPSTREAM_URL:
            "https://example.com/custom/v1/chat/completions?endpoint=1",
        }),
      ).upstreamUrl,
    ).toBe(
      "https://example.com/custom/v1/chat/completions?endpoint=1",
    );
  });

  it.each([
    "UPSTREAM_URL",
    "UPSTREAM_API_KEY",
    "GROUP_API_KEY",
    "IP_HMAC_SECRET",
  ])("rejects a missing %s without naming or exposing it", async (name) => {
    const context = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://proxy.example/health"),
      testEnv({ [name]: "" }),
      context,
    );
    const body = await response.text();
    expect(response.status).toBe(500);
    expect(body).not.toContain(name);
    expect(body).not.toContain(TEST_UPSTREAM_KEY);
    expect(body).not.toContain(TEST_HMAC_SECRET);
    expect(JSON.parse(body).error.code).toBe("invalid_configuration");
  });

  it.each([
    ["zero RPM", { PER_IP_RPM_LIMIT: "0" }],
    ["fractional concurrency", { MAX_CONCURRENCY: "1.5" }],
    ["undersized body limit", { MAX_BODY_BYTES: "1023" }],
    [
      "heartbeat equal to TTL",
      {
        LEASE_TTL_SECONDS: "60",
        LEASE_HEARTBEAT_SECONDS: "60",
      },
    ],
    ["empty quota scope", { QUOTA_SCOPE: "" }],
    ["oversized quota scope", { QUOTA_SCOPE: "x".repeat(129) }],
    ["relative disable time", { DISABLE_AT: "tomorrow" }],
    ["date-only disable time", { DISABLE_AT: "2026-08-01" }],
    ["impossible disable date", { DISABLE_AT: "2026-02-30T00:00:00Z" }],
    ["invalid timezone offset", { DISABLE_AT: "2026-08-01T00:00:00+14:30" }],
  ])("rejects invalid configuration: %s", (_label, override) => {
    expect(() =>
      getConfig(testEnv(override as Record<string, unknown>)),
    ).toThrow();
  });

  it("only trusts CF-Connecting-IP and ignores spoofed forwarding headers", async () => {
    const withoutCloudflareIp = await invoke(
      chatRequest(
        { messages: [] },
        {
          ip: null,
          extraHeaders: {
            "X-Forwarded-For": "203.0.113.9",
            "X-Real-IP": "203.0.113.9",
          },
        },
      ),
    );
    expect(withoutCloudflareIp.response.status).toBe(400);
    expect((await responseJson(withoutCloudflareIp.response)).error.code).toBe(
      "invalid_client_ip",
    );

    const fetchSpy = mockOk();
    const withCloudflareIp = await invoke(
      chatRequest(
        { messages: [] },
        {
          ip: "198.51.100.8",
          extraHeaders: {
            "X-Forwarded-For": "203.0.113.9",
            "X-Real-IP": "203.0.113.9",
          },
        },
      ),
    );
    expect(withCloudflareIp.response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("normalizes IPv4, IPv6, and IPv4-mapped IPv6 deterministically", () => {
    expect(normalizeIp(" 203.0.113.8 ")).toBe("203.0.113.8");
    expect(
      normalizeIp("2001:0db8:0000:0000:0000:ff00:0042:8329"),
    ).toBe("2001:db8::ff00:42:8329");
    expect(normalizeIp("::ffff:192.0.2.128")).toBe("192.0.2.128");
    expect(normalizeIp("not-an-ip")).toBeNull();
  });

  it("stores only the full HMAC and never the raw client IP", async () => {
    mockOk();
    const rawIp = "203.0.113.88";
    const { response } = await invoke(
      chatRequest({ messages: [] }, { ip: rawIp }),
    );
    await response.arrayBuffer();

    const limiter = env.PROXY_LIMITER.getByName("global");
    const hashes = await runInDurableObject<ProxyLimiter, string[]>(
      limiter,
      (_instance, state) =>
        state.storage.sql
          .exec<{ ip_hash: string }>(
            "SELECT ip_hash FROM hourly_ip_admissions",
          )
          .toArray()
          .map((row) => row.ip_hash),
    );
    expect(hashes).toEqual([
      await hashClientIp(rawIp, TEST_HMAC_SECRET),
    ]);
    expect(JSON.stringify(hashes)).not.toContain(rawIp);
  });

  it("never forwards the client Authorization and sends only the upstream key", async () => {
    const fetchSpy = mockOk();
    const { response } = await invoke(chatRequest({ messages: [] }));
    await response.arrayBuffer();
    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init?.headers).toEqual({
      Authorization: `Bearer ${TEST_UPSTREAM_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    });
    expect(JSON.stringify(init?.headers)).not.toContain(TEST_GROUP_KEY);
  });

  it("client-supplied URL, Host, and API key fields cannot change the target", async () => {
    const fetchSpy = mockOk();
    const clientBody = {
      messages: [],
      url: "https://attacker.invalid/v1/chat/completions",
      host: "attacker.invalid",
      api_key: "attacker-key",
      authorization: "Bearer attacker-key",
    };
    const { response } = await invoke(chatRequest(clientBody));
    await response.arrayBuffer();
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(TEST_UPSTREAM_URL);
    expect(fetchSpy.mock.calls[0]?.[1]?.headers).toEqual({
      Authorization: `Bearer ${TEST_UPSTREAM_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    });
  });

  it("audit logs contain only safe fields and no prompt, tools, results, IP, URL, or keys", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    mockOk();
    const rawIp = "203.0.113.77";
    const prompt = "TOP SECRET PROMPT";
    const toolResult = "PRIVATE TOOL RESULT";
    const { response } = await invoke(
      chatRequest(
        {
          messages: [
            { role: "user", content: prompt },
            {
              role: "tool",
              tool_call_id: "call_secret",
              content: toolResult,
            },
          ],
          tools: [
            {
              type: "function",
              function: { name: "private_tool", parameters: {} },
            },
          ],
        },
        { ip: rawIp },
      ),
    );
    await response.arrayBuffer();

    const logs = logSpy.mock.calls
      .map((call) => String(call[0]))
      .join("\n");
    for (const forbidden of [
      rawIp,
      prompt,
      toolResult,
      "private_tool",
      TEST_GROUP_KEY,
      TEST_UPSTREAM_KEY,
      TEST_HMAC_SECRET,
      TEST_UPSTREAM_URL,
      "Authorization",
    ]) {
      expect(logs).not.toContain(forbidden);
    }
    const event = JSON.parse(logs.split("\n").at(-1)!);
    expect(Object.keys(event).sort()).toEqual(
      [
        "duration_ms",
        "error_category",
        "global_request_count",
        "ip_hash_prefix",
        "method",
        "path",
        "status",
        "stream",
        "time",
      ].sort(),
    );
    expect(event.ip_hash_prefix).toMatch(/^[a-f0-9]{10}$/);
  });

  it("logs only the safe pathname and never query parameters", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const context = createExecutionContext();
    const response = await worker.fetch(
      new Request(
        "https://proxy.example/unknown?api_key=secret-query-value",
      ),
      testEnv(),
      context,
    );
    await response.arrayBuffer();
    const logs = logSpy.mock.calls
      .map((call) => String(call[0]))
      .join("\n");
    expect(logs).toContain('"path":"/unknown"');
    expect(logs).not.toContain("secret-query-value");
  });

  it("sets baseline security headers on normal and error responses", async () => {
    const rootContext = createExecutionContext();
    const root = await worker.fetch(
      new Request("https://proxy.example/"),
      testEnv(),
      rootContext,
    );
    const unauthorized = await invoke(
      chatRequest({}, { authorization: "Bearer wrong" }),
    );
    for (const response of [root, unauthorized.response]) {
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  });
});
