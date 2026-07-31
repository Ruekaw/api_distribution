import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import {
  chatRequest,
  invoke,
  responseJson,
  testEnv,
  TEST_GROUP_KEY,
} from "./helpers";

function mockJsonUpstream(
  body: unknown = {
    id: "chatcmpl-test",
    choices: [
      {
        message: { role: "assistant", content: "OK" },
        finish_reason: "stop",
      },
    ],
  },
  status = 200,
) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("Worker routes and request validation", () => {
  it("GET / returns the service identity", async () => {
    const context = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://proxy.example/"),
      testEnv(),
      context,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      service: "dify-openai-proxy",
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("GET /health reports model and disabled state", async () => {
    const context = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://proxy.example/health"),
      testEnv(),
      context,
    );
    expect(await response.json()).toEqual({
      status: "ok",
      disabled: false,
      model: "claude-opus-4.6",
    });
  });

  it("GET /v1/models returns one OpenAI-compatible model", async () => {
    const context = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://proxy.example/v1/models"),
      testEnv(),
      context,
    );
    expect(await response.json()).toEqual({
      object: "list",
      data: [
        {
          id: "claude-opus-4.6",
          object: "model",
          owned_by: "proxy",
        },
      ],
    });
  });

  it("unknown paths return an OpenAI-compatible 404", async () => {
    const context = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://proxy.example/admin?token=do-not-log"),
      testEnv(),
      context,
    );
    expect(response.status).toBe(404);
    expect((await responseJson(response)).error.code).toBe("not_found");
  });

  it("root, health, and models do not consume Durable Object quota", async () => {
    const context = createExecutionContext();
    for (const path of ["/", "/health", "/v1/models"]) {
      const response = await worker.fetch(
        new Request(`https://proxy.example${path}`),
        testEnv(),
        context,
      );
      await response.arrayBuffer();
    }
    const status = await env.PROXY_LIMITER.getByName("global").getStatus();
    expect(status.globalUsage).toEqual([]);
    expect(status.hourlyAdmissionCount).toBe(0);
  });

  it("accepts the correct Bearer key", async () => {
    mockJsonUpstream();
    const { response } = await invoke(chatRequest());
    expect(response.status).toBe(200);
    expect((await responseJson(response)).choices[0].message.content).toBe(
      "OK",
    );
  });

  it("returns a uniform 401 for an incorrect key", async () => {
    const { response } = await invoke(
      chatRequest({}, { authorization: "Bearer wrong-key" }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        message: "Unauthorized.",
        type: "auth_error",
        code: "unauthorized",
      },
    });
  });

  it("does not reveal whether the supplied key length was correct", async () => {
    const short = await invoke(
      chatRequest({}, { authorization: "Bearer x" }),
    );
    const sameLength = await invoke(
      chatRequest(
        {},
        {
          authorization: `Bearer ${"x".repeat(TEST_GROUP_KEY.length)}`,
        },
      ),
    );
    expect(short.response.status).toBe(401);
    expect(sameLength.response.status).toBe(401);
    expect(await short.response.text()).toBe(
      await sameLength.response.text(),
    );
  });

  it("rejects non-JSON Content-Type before quota", async () => {
    const { response } = await invoke(
      chatRequest("{}", { contentType: "text/plain" }),
    );
    expect(response.status).toBe(415);
    expect((await responseJson(response)).error.code).toBe(
      "invalid_content_type",
    );
    expect(
      (await env.PROXY_LIMITER.getByName("global").getStatus()).globalUsage,
    ).toEqual([]);
  });

  it("accepts application/json with utf-8 and rejects unrelated parameters", async () => {
    mockJsonUpstream();
    const accepted = await invoke(
      chatRequest({}, { contentType: "application/json; charset=utf-8" }),
    );
    expect(accepted.response.status).toBe(200);

    const rejected = await invoke(
      chatRequest({}, { contentType: "application/json; profile=test" }),
    );
    expect(rejected.response.status).toBe(415);
  });

  it("rejects malformed JSON", async () => {
    const { response } = await invoke(
      chatRequest({}, { rawBody: "{\"messages\":" }),
    );
    expect(response.status).toBe(400);
    expect((await responseJson(response)).error.code).toBe("invalid_json");
  });

  it("rejects a body larger than the configured byte limit", async () => {
    const { response } = await invoke(
      chatRequest({}, { rawBody: JSON.stringify({ value: "x".repeat(1_100) }) }),
      { MAX_BODY_BYTES: "1024" },
    );
    expect(response.status).toBe(413);
    expect((await responseJson(response)).error.code).toBe(
      "request_too_large",
    );
  });

  it("rejects JSON values that are not objects", async () => {
    const { response } = await invoke(chatRequest([], { rawBody: "[]" }));
    expect(response.status).toBe(400);
    expect((await responseJson(response)).error.code).toBe("invalid_request");
  });

  it.each([
    ["max_tokens", 0, "invalid_max_tokens"],
    ["max_tokens", 1.5, "invalid_max_tokens"],
    ["max_tokens", "10", "invalid_max_tokens"],
    ["max_tokens", 16_385, "max_tokens_too_large"],
    [
      "max_completion_tokens",
      0,
      "invalid_max_completion_tokens",
    ],
    [
      "max_completion_tokens",
      1.5,
      "invalid_max_completion_tokens",
    ],
    [
      "max_completion_tokens",
      "10",
      "invalid_max_completion_tokens",
    ],
    [
      "max_completion_tokens",
      16_385,
      "max_completion_tokens_too_large",
    ],
  ])("validates %s=%s", async (field, value, code) => {
    const { response } = await invoke(
      chatRequest({ messages: [], [field]: value }),
    );
    expect(response.status).toBe(400);
    expect((await responseJson(response)).error.code).toBe(code);
  });

  it("rejects conflicting token limit fields", async () => {
    const { response } = await invoke(
      chatRequest({
        messages: [],
        max_tokens: 100,
        max_completion_tokens: 101,
      }),
    );
    expect(response.status).toBe(400);
    expect((await responseJson(response)).error.code).toBe(
      "conflicting_token_limits",
    );
  });

  it("permits matching token fields and does not add absent fields", async () => {
    const fetchSpy = mockJsonUpstream();
    const matching = await invoke(
      chatRequest({
        messages: [],
        max_tokens: 100,
        max_completion_tokens: 100,
      }),
    );
    expect(matching.response.status).toBe(200);
    const matchingBody = JSON.parse(
      String(fetchSpy.mock.calls[0]?.[1]?.body),
    );
    expect(matchingBody.max_tokens).toBe(100);
    expect(matchingBody.max_completion_tokens).toBe(100);

    await invoke(chatRequest({ messages: [] }, { ip: "203.0.113.11" }));
    const absentBody = JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body));
    expect("max_tokens" in absentBody).toBe(false);
    expect("max_completion_tokens" in absentBody).toBe(false);
  });

  it("forces model and n while preserving compatible fields", async () => {
    const fetchSpy = mockJsonUpstream();
    const body = {
      model: "client-model",
      n: 99,
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "high",
      parallel_tool_calls: true,
      response_format: { type: "json_object" },
      temperature: 0.2,
    };
    const { response } = await invoke(chatRequest(body));
    expect(response.status).toBe(200);
    const forwarded = JSON.parse(
      String(fetchSpy.mock.calls[0]?.[1]?.body),
    );
    expect(forwarded).toMatchObject({
      ...body,
      model: "claude-opus-4.6",
      n: 1,
    });
  });

  it("DISABLE_AT blocks chat without blocking health or models", async () => {
    const disabledEnv = { DISABLE_AT: "2020-01-01T00:00:00Z" };
    const chat = await invoke(chatRequest(), disabledEnv);
    expect(chat.response.status).toBe(503);
    expect((await responseJson(chat.response)).error.code).toBe(
      "proxy_disabled",
    );

    const context = createExecutionContext();
    const health = await worker.fetch(
      new Request("https://proxy.example/health"),
      testEnv(disabledEnv),
      context,
    );
    expect(
      ((await health.json()) as { disabled: boolean }).disabled,
    ).toBe(true);
    const models = await worker.fetch(
      new Request("https://proxy.example/v1/models"),
      testEnv(disabledEnv),
      context,
    );
    expect(models.status).toBe(200);
  });
});
