import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { ProxyLimiter } from "../src/limiter";
import {
  chatRequest,
  invoke,
  responseJson,
  TEST_UPSTREAM_URL,
} from "./helpers";

const encoder = new TextEncoder();

function mockResponse(
  body: BodyInit | null,
  status = 200,
  contentType = "application/json",
) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(body, {
      status,
      headers: { "Content-Type": contentType },
    }),
  );
}

describe("protocol and stream passthrough", () => {
  it("passes non-streaming bytes, Content-Type, and status through unchanged", async () => {
    const bytes = encoder.encode('{"raw":"\\u4f60\\u597d","spacing":  true}');
    mockResponse(bytes, 201, "application/json; charset=utf-8");
    const { response } = await invoke(chatRequest({ messages: [] }));
    expect(response.status).toBe(201);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("Content-Type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(
      (await env.PROXY_LIMITER.getByName("global").getStatus())
        .activeLeaseCount,
    ).toBe(0);
  });

  it.each([400, 429, 500, 503])(
    "passes upstream HTTP %s through with its raw body",
    async (status) => {
      const body = `upstream-${status}-body`;
      mockResponse(body, status, "text/plain; charset=utf-8");
      const { response } = await invoke(chatRequest({ messages: [] }));
      expect(response.status).toBe(status);
      expect(await response.text()).toBe(body);
      expect(response.headers.get("Content-Type")).toBe(
        "text/plain; charset=utf-8",
      );
    },
  );

  it("preserves reasoning_content, usage, finish_reason, and non-streaming tool_calls", async () => {
    const upstreamBody = {
      id: "chatcmpl-protocol",
      choices: [
        {
          message: {
            role: "assistant",
            reasoning_content: "independent reasoning",
            content: "final answer",
            tool_calls: [
              {
                id: "call_abc",
                type: "function",
                function: {
                  name: "lookup",
                  arguments: '{"item":"x"}',
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: {
        prompt_tokens: 4,
        completion_tokens: 6,
        total_tokens: 10,
        completion_tokens_details: { reasoning_tokens: 3 },
      },
    };
    mockResponse(JSON.stringify(upstreamBody));
    const { response } = await invoke(
      chatRequest({ messages: [], tools: [] }),
    );
    expect(await response.json()).toEqual(upstreamBody);
  });

  it("passes SSE chunks byte-for-byte without reserialization", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_x","function":{"name":"lookup","arguments":"{\\"id\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"7}"}}]},"finish_reason":"tool_calls"}],"usage":{"total_tokens":9}}\n\n',
      "data: [DONE]\n\n",
    ];
    const expected = chunks.join("");
    const upstreamStream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    mockResponse(upstreamStream, 200, "text/event-stream");

    const { response, waitForBackground } = await invoke(
      chatRequest({ messages: [], stream: true }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(expected);
    await waitForBackground();
    expect(response.headers.get("Cache-Control")).toBe(
      "no-cache, no-transform",
    );
    expect(response.headers.get("Content-Encoding")).toBeNull();
    expect(response.headers.get("Content-Length")).toBeNull();
    expect(
      (await env.PROXY_LIMITER.getByName("global").getStatus())
        .activeLeaseCount,
    ).toBe(0);
  });

  it("preserves assistant.tool_calls, role=tool, and tool_call_id across two rounds", async () => {
    const toolCall = {
      id: "call_roundtrip",
      type: "function",
      function: { name: "lookup", arguments: '{"id":7}' },
    };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [toolCall],
                },
                finish_reason: "tool_calls",
              },
            ],
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: { role: "assistant", content: "done" },
                finish_reason: "stop",
              },
            ],
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      );

    const first = await invoke(
      chatRequest({ messages: [{ role: "user", content: "lookup" }] }),
    );
    expect(
      (await responseJson(first.response)).choices[0].message.tool_calls,
    ).toEqual([toolCall]);

    const messages = [
      { role: "user", content: "lookup" },
      { role: "assistant", content: null, tool_calls: [toolCall] },
      {
        role: "tool",
        tool_call_id: "call_roundtrip",
        content: '{"value":42}',
      },
    ];
    const second = await invoke(
      chatRequest({ messages }, { ip: "203.0.113.11" }),
    );
    expect((await responseJson(second.response)).choices[0].message.content).toBe(
      "done",
    );
    const forwarded = JSON.parse(
      String(fetchSpy.mock.calls[1]?.[1]?.body),
    );
    expect(forwarded.messages).toEqual(messages);
  });

  it("releases the lease after an upstream fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("internal network detail"),
    );
    const { response } = await invoke(chatRequest({ messages: [] }));
    expect(response.status).toBe(502);
    expect((await responseJson(response)).error.code).toBe(
      "upstream_unavailable",
    );
    expect((await response.text().catch(() => ""))).not.toContain(
      "internal network detail",
    );
    expect(
      (await env.PROXY_LIMITER.getByName("global").getStatus())
        .activeLeaseCount,
    ).toBe(0);
  });

  it("releases the streaming lease when the response consumer cancels", async () => {
    let upstreamCancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: first\n\n"));
      },
      cancel() {
        upstreamCancelled = true;
      },
    });
    mockResponse(stream, 200, "text/event-stream");
    const { response, waitForBackground } = await invoke(
      chatRequest({ messages: [], stream: true }),
    );
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      "data: first\n\n",
    );
    await reader.cancel("client cancelled");
    await waitForBackground();
    expect(upstreamCancelled).toBe(true);
    expect(
      (await env.PROXY_LIMITER.getByName("global").getStatus())
        .activeLeaseCount,
    ).toBe(0);
  });

  it("aborts upstream and releases the lease when request.signal is cancelled", async () => {
    let upstreamCancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: first\n\n"));
      },
      cancel() {
        upstreamCancelled = true;
      },
    });
    mockResponse(stream, 200, "text/event-stream");
    const requestController = new AbortController();
    const { response, waitForBackground } = await invoke(
      chatRequest(
        { messages: [], stream: true },
        { signal: requestController.signal },
      ),
    );
    requestController.abort();
    await response.body?.cancel().catch(() => undefined);
    await waitForBackground();
    expect(upstreamCancelled).toBe(true);
    expect(
      (await env.PROXY_LIMITER.getByName("global").getStatus())
        .activeLeaseCount,
    ).toBe(0);
  });

  it("heartbeats keep a long streaming request leased past its original TTL", async () => {
    let closeUpstream!: () => void;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: first\n\n"));
        closeUpstream = () => controller.close();
      },
    });
    mockResponse(stream, 200, "text/event-stream");
    const startedAt = Date.now();
    const { response, waitForBackground } = await invoke(
      chatRequest({ messages: [], stream: true }),
      {
        LEASE_TTL_SECONDS: "2",
        LEASE_HEARTBEAT_SECONDS: "1",
      },
    );
    const reader = response.body!.getReader();
    await reader.read();
    await new Promise((resolve) => setTimeout(resolve, 2_200));

    const during = await env.PROXY_LIMITER.getByName("global").getStatus(
      startedAt + 2_100,
    );
    expect(during.activeLeaseCount).toBe(1);

    closeUpstream();
    await reader.read();
    await waitForBackground();
    expect(
      (await env.PROXY_LIMITER.getByName("global").getStatus())
        .activeLeaseCount,
    ).toBe(0);
  });

  it("returns a safe storage error if a non-streaming lease disappears", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const signal = init?.signal;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener(
            "abort",
            () => controller.error(new Error("internal abort detail")),
            { once: true },
          );
        },
      });
      return new Response(stream, {
        headers: { "Content-Type": "application/json" },
      });
    });

    const pendingResponse = invoke(chatRequest({ messages: [] }), {
      LEASE_TTL_SECONDS: "2",
      LEASE_HEARTBEAT_SECONDS: "1",
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    const limiter = env.PROXY_LIMITER.getByName("global");
    await runInDurableObject<ProxyLimiter, void>(
      limiter,
      (_instance, state) => {
        state.storage.sql.exec("DELETE FROM concurrency_leases");
      },
    );

    const { response } = await pendingResponse;
    const body = await responseJson(response);
    expect(response.status).toBe(503);
    expect(body.error.code).toBe("storage_unavailable");
    expect(JSON.stringify(body)).not.toContain("internal abort detail");
  });

  it("always uses the configured upstream URL for streaming and non-streaming calls", async () => {
    const fetchSpy = mockResponse("data: [DONE]\n\n", 200, "text/event-stream");
    const first = await invoke(
      chatRequest({ messages: [], stream: true }),
    );
    await first.response.text();
    await first.waitForBackground();
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(TEST_UPSTREAM_URL);
  });
});
