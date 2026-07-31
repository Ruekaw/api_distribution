import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createApp, MAX_BODY_BYTES } from '../src/app';
import type { Config } from '../src/config';
import { authHeaders, jsonFetch, MemoryQuotaStore, testConfig } from './helpers';

function appFixture(options: {
  config?: Partial<Config>;
  store?: MemoryQuotaStore;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  events?: Array<Record<string, unknown>>;
} = {}) {
  const store = options.store ?? new MemoryQuotaStore();
  const mock = options.fetchImpl ? null : jsonFetch();
  const events = options.events ?? [];
  const app = createApp({
    config: { ...testConfig, ...options.config },
    store,
    fetchImpl: options.fetchImpl ?? mock!.fetch,
    now: options.now,
    auditSink: (event) => events.push(event),
  });
  return { app, store, mock, events };
}

test('1. health is free and reports model/disabled state', async (t) => {
  const { app, store } = appFixture();
  t.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'ok', disabled: false, model: testConfig.modelName });
  assert.equal(store.globalCount, 0);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
});

test('2. models is OpenAI-compatible and free', async (t) => {
  const { app, store } = appFixture();
  t.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: '/v1/models' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    object: 'list',
    data: [{ id: testConfig.modelName, object: 'model', owned_by: 'proxy' }],
  });
  assert.equal(store.globalCount, 0);
});

test('3. bad authentication returns uniform 401 without consuming quota', async (t) => {
  const { app, store, mock } = appFixture();
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { ...authHeaders(), authorization: 'Bearer wrong' },
    payload: { messages: [{ role: 'user', content: 'secret prompt' }] },
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, 'unauthorized');
  assert.equal(store.globalCount, 0);
  assert.equal(mock!.calls.length, 0);
});

test('4. only application/json is accepted', async (t) => {
  const { app, store } = appFixture();
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${testConfig.groupApiKey}`, 'x-forwarded-for': '203.0.113.10', 'content-type': 'text/plain' },
    payload: '{}',
  });
  assert.equal(response.statusCode, 415);
  assert.equal(store.globalCount, 0);
});

test('5. ordinary non-streaming response is passed through', async (t) => {
  const upstreamBody = { id: 'x', choices: [{ message: { role: 'assistant', content: 'hello' } }] };
  const mock = jsonFetch(upstreamBody);
  const { app } = appFixture({ fetchImpl: mock.fetch });
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST', url: '/v1/chat/completions', headers: authHeaders(), payload: { messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), upstreamBody);
});

test('6. proxy forces model and n while preserving client fields', async (t) => {
  const mock = jsonFetch();
  const { app } = appFixture({ fetchImpl: mock.fetch });
  t.after(() => app.close());
  await app.inject({
    method: 'POST', url: '/v1/chat/completions', headers: authHeaders(),
    payload: { model: 'client-model', n: 8, messages: [], temperature: 0.2, response_format: { type: 'json_object' } },
  });
  const outbound = JSON.parse(String(mock.calls[0]!.init!.body));
  assert.equal(outbound.model, testConfig.modelName);
  assert.equal(outbound.n, 1);
  assert.equal(outbound.temperature, 0.2);
  assert.deepEqual(outbound.response_format, { type: 'json_object' });
  assert.equal('max_tokens' in outbound, false);
  assert.deepEqual(Object.keys(mock.calls[0]!.init!.headers as Record<string, string>).sort(), ['accept', 'authorization', 'content-type']);
});

test('7. max_tokens over 16384 is rejected before quota', async (t) => {
  const { app, store } = appFixture();
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST', url: '/v1/chat/completions', headers: authHeaders(), payload: { messages: [], max_tokens: 16385 },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'max_tokens_too_large');
  assert.equal(store.globalCount, 0);
});

test('8. reasoning_content remains separate from content', async (t) => {
  const body = { choices: [{ message: { role: 'assistant', reasoning_content: 'private reasoning', content: 'answer' } }] };
  const { app } = appFixture({ fetchImpl: jsonFetch(body).fetch });
  t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders(), payload: { messages: [] } });
  assert.deepEqual(response.json(), body);
  assert.equal(response.json().choices[0].message.content, 'answer');
});

test('9. non-streaming tool_calls are preserved verbatim', async (t) => {
  const toolCalls = [{ id: 'call_123', type: 'function', function: { name: 'weather', arguments: '{"city":"Paris"}' } }];
  const body = { choices: [{ message: { role: 'assistant', content: null, tool_calls: toolCalls }, finish_reason: 'tool_calls' }] };
  const { app } = appFixture({ fetchImpl: jsonFetch(body).fetch });
  t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders(), payload: { messages: [], tools: [] } });
  assert.deepEqual(response.json().choices[0].message.tool_calls, toolCalls);
});

test('10. SSE bytes and [DONE] are passed through unchanged', async (t) => {
  const sse = 'data: {"choices":[{"delta":{"content":"A"}}]}\n\ndata: {"choices":[{"delta":{"content":"B"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  const fetchImpl = (async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof fetch;
  const { app } = appFixture({ fetchImpl });
  t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders(), payload: { messages: [], stream: true } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, sse);
  assert.equal(response.headers['cache-control'], 'no-cache, no-transform');
  assert.equal(response.headers['content-encoding'], undefined);
});

test('11. streaming reasoning and fragmented tool arguments remain unchanged', async (t) => {
  const sse = [
    'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}',
    '',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_x","function":{"name":"f","arguments":"{\\"a\\":"}}]}}]}',
    '',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]},"finish_reason":"tool_calls"}],"usage":{"total_tokens":3}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  const fetchImpl = (async () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch;
  const { app } = appFixture({ fetchImpl });
  t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders(), payload: { messages: [], stream: true } });
  assert.equal(response.body, sse);
});

test('12. assistant.tool_calls and role=tool complete a second-round loop unchanged', async (t) => {
  const calls: RequestInit[] = [];
  const toolCall = { id: 'call_roundtrip', type: 'function', function: { name: 'lookup', arguments: '{"id":7}' } };
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls.push(init!);
    if (calls.length === 1) {
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [toolCall] }, finish_reason: 'tool_calls' }] }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const { app } = appFixture({ fetchImpl });
  t.after(() => app.close());
  await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders(), payload: { messages: [{ role: 'user', content: 'lookup' }] } });
  const secondMessages = [
    { role: 'user', content: 'lookup' },
    { role: 'assistant', content: null, tool_calls: [toolCall] },
    { role: 'tool', tool_call_id: 'call_roundtrip', content: '{"value":42}' },
  ];
  const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders(), payload: { messages: secondMessages } });
  assert.equal(response.json().choices[0].message.content, 'done');
  assert.deepEqual(JSON.parse(String(calls[1]!.body)).messages, secondMessages);
});

test('13. usage is preserved verbatim', async (t) => {
  const body = { choices: [], usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13, completion_tokens_details: { reasoning_tokens: 3 } } };
  const { app } = appFixture({ fetchImpl: jsonFetch(body).fetch });
  t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders(), payload: { messages: [] } });
  assert.deepEqual(response.json().usage, body.usage);
});

test('14. PER_IP_RPM_LIMIT + 1 returns 429 with Retry-After', async (t) => {
  const { app } = appFixture({ config: { perIpRpmLimit: 2 } });
  t.after(() => app.close());
  for (let i = 0; i < 2; i += 1) {
    assert.equal((await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders(), payload: { messages: [] } })).statusCode, 200);
  }
  const blocked = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders(), payload: { messages: [] } });
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.json().error.code, 'per_ip_rpm_limit');
  assert.ok(Number(blocked.headers['retry-after']) >= 1);
});

test('15. RPM resets at the next UTC minute bucket', async (t) => {
  let clock = new Date('2026-01-01T00:00:30.000Z');
  const { app } = appFixture({ config: { perIpRpmLimit: 1 }, now: () => clock });
  t.after(() => app.close());
  assert.equal((await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders(), payload: { messages: [] } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders(), payload: { messages: [] } })).statusCode, 429);
  clock = new Date('2026-01-01T00:01:00.000Z');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders(), payload: { messages: [] } })).statusCode, 200);
});

test('16. one IP occupies only one hourly admission', async (t) => {
  const store = new MemoryQuotaStore();
  const { app } = appFixture({ store });
  t.after(() => app.close());
  await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders(), payload: { messages: [] } });
  await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders(), payload: { messages: [] } });
  assert.equal([...store.hourAdmissions.values()][0]!.size, 1);
});

test('17. first ten distinct IPs are admitted', async (t) => {
  const { app } = appFixture({ config: { hourlyUniqueIpLimit: 10, perIpRpmLimit: 20 } });
  t.after(() => app.close());
  for (let i = 1; i <= 10; i += 1) {
    const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders(`203.0.113.${i}`), payload: { messages: [] } });
    assert.equal(response.statusCode, 200);
  }
});

test('18. eleventh IP is rejected while an admitted IP still works', async (t) => {
  const { app } = appFixture({ config: { hourlyUniqueIpLimit: 10, perIpRpmLimit: 20 } });
  t.after(() => app.close());
  for (let i = 1; i <= 10; i += 1) {
    await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders(`203.0.113.${i}`), payload: { messages: [] } });
  }
  const eleventh = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders('203.0.113.11'), payload: { messages: [] } });
  assert.equal(eleventh.statusCode, 429);
  assert.equal(eleventh.json().error.code, 'hourly_unique_ip_limit');
  const admitted = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders('203.0.113.1'), payload: { messages: [] } });
  assert.equal(admitted.statusCode, 200);
});

test('19. hourly admissions reset at the next UTC hour', async (t) => {
  let clock = new Date('2026-01-01T00:59:59.000Z');
  const { app } = appFixture({ config: { hourlyUniqueIpLimit: 1 }, now: () => clock });
  t.after(() => app.close());
  assert.equal((await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders('203.0.113.1'), payload: { messages: [] } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders('203.0.113.2'), payload: { messages: [] } })).statusCode, 429);
  clock = new Date('2026-01-01T01:00:00.000Z');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders('203.0.113.2'), payload: { messages: [] } })).statusCode, 200);
});

test('20. health, models, and failed auth never occupy an hourly slot', async (t) => {
  const store = new MemoryQuotaStore();
  const { app } = appFixture({ store });
  t.after(() => app.close());
  await app.inject({ method: 'GET', url: '/health', headers: { 'x-forwarded-for': '203.0.113.1' } });
  await app.inject({ method: 'GET', url: '/v1/models', headers: { 'x-forwarded-for': '203.0.113.2' } });
  await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { ...authHeaders('203.0.113.3'), authorization: 'Bearer bad' }, payload: { messages: [] } });
  assert.equal(store.hourAdmissions.size, 0);
});

test('21. global request limit is enforced without over-counting rejected calls', async (t) => {
  const store = new MemoryQuotaStore();
  const { app } = appFixture({ store, config: { globalRequestLimit: 2 } });
  t.after(() => app.close());
  assert.equal((await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders(), payload: { messages: [] } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders(), payload: { messages: [] } })).statusCode, 200);
  const blocked = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders(), payload: { messages: [] } });
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.json().error.code, 'global_request_limit');
  assert.equal(store.globalCount, 2);
});

test('22. max concurrency returns 503 and rolls back other counters', async (t) => {
  let releaseFirst!: (response: Response) => void;
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (calls === 1) return new Promise<Response>((resolve) => { releaseFirst = resolve; });
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const store = new MemoryQuotaStore();
  const { app } = appFixture({ store, fetchImpl, config: { maxConcurrency: 1 } });
  t.after(() => app.close());
  const first = app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders('203.0.113.1'), payload: { messages: [] } });
  while (store.leases.size === 0) await delay(1);
  const before = store.globalCount;
  const blocked = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders('203.0.113.2'), payload: { messages: [] } });
  assert.equal(blocked.statusCode, 503);
  assert.equal(blocked.json().error.code, 'max_concurrency');
  assert.equal(store.globalCount, before);
  releaseFirst(new Response('{}', { headers: { 'content-type': 'application/json' } }));
  await first;
});

test('23. expired concurrency lease is automatically reclaimable', async () => {
  const store = new MemoryQuotaStore();
  const base = { ipHash: 'a'.repeat(64), perIpRpmLimit: 10, hourlyUniqueIpLimit: 10, globalRequestLimit: 10, maxConcurrency: 1, leaseTtlSeconds: 1 };
  const first = await store.reserve({ ...base, now: new Date('2026-01-01T00:00:00Z') });
  assert.equal('leaseId' in first, true);
  const second = await store.reserve({ ...base, ipHash: 'b'.repeat(64), now: new Date('2026-01-01T00:00:02Z') });
  assert.equal('leaseId' in second, true);
});

test('24. DISABLE_AT blocks chat but keeps health and models available', async (t) => {
  const { app, store } = appFixture({ config: { disableAt: new Date('2026-01-01T00:00:00Z') }, now: () => new Date('2026-01-01T00:00:01Z') });
  t.after(() => app.close());
  assert.equal((await app.inject({ method: 'GET', url: '/health' })).json().disabled, true);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/models' })).statusCode, 200);
  const chat = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders(), payload: { messages: [] } });
  assert.equal(chat.statusCode, 503);
  assert.equal(chat.json().error.code, 'proxy_disabled');
  assert.equal(store.globalCount, 0);
});

test('25. upstream 4xx is passed through safely', async (t) => {
  const body = { error: { message: 'bad request', type: 'invalid_request_error', code: 'upstream_bad' } };
  const { app } = appFixture({ fetchImpl: jsonFetch(body, 400).fetch });
  t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders(), payload: { messages: [] } });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), body);
});

test('26. upstream 5xx is passed through safely', async (t) => {
  const body = { error: { message: 'upstream overloaded', type: 'server_error', code: 'overloaded' } };
  const { app } = appFixture({ fetchImpl: jsonFetch(body, 503).fetch });
  t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders(), payload: { messages: [] } });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), body);
});

test('27. upstream network/timeout error becomes a safe 502 and releases lease', async (t) => {
  const fetchImpl = (async () => { throw new Error('socket failure with internal details'); }) as typeof fetch;
  const store = new MemoryQuotaStore();
  const { app } = appFixture({ store, fetchImpl });
  t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders(), payload: { messages: [] } });
  assert.equal(response.statusCode, 502);
  assert.equal(response.json().error.code, 'upstream_unavailable');
  assert.equal(response.body.includes('socket failure'), false);
  assert.equal(store.leases.size, 0);
});

test('28. request body over 4 MiB is rejected before quota', async (t) => {
  const { app, store } = appFixture();
  t.after(() => app.close());
  const payload = JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(MAX_BODY_BYTES) }] });
  const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders(), payload });
  assert.equal(response.statusCode, 413);
  assert.equal(response.json().error.code, 'request_too_large');
  assert.equal(store.globalCount, 0);
});

test('29. audit logs and errors never contain keys, IP, prompt, or upstream URL', async (t) => {
  const events: Array<Record<string, unknown>> = [];
  const { app } = appFixture({ events, fetchImpl: (async () => { throw new Error(`do not expose ${testConfig.upstreamUrl}`); }) as typeof fetch });
  t.after(() => app.close());
  const rawIp = '203.0.113.77';
  const prompt = 'TOP SECRET PROMPT';
  const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders(rawIp), payload: { messages: [{ role: 'user', content: prompt }] } });
  const material = `${response.body}\n${JSON.stringify(events)}`;
  for (const secret of [testConfig.groupApiKey, testConfig.upstreamApiKey, testConfig.ipHmacSecret, testConfig.upstreamUrl, rawIp, prompt]) {
    assert.equal(material.includes(secret), false);
  }
});

test('30. unknown paths return 404', async (t) => {
  const { app } = appFixture();
  t.after(() => app.close());
  assert.equal((await app.inject({ method: 'GET', url: '/admin' })).statusCode, 404);
});

test('31. concurrent contenders for the tenth hourly slot admit only one', async (t) => {
  const { app } = appFixture({ config: { hourlyUniqueIpLimit: 10, perIpRpmLimit: 50 } });
  t.after(() => app.close());
  for (let i = 1; i <= 9; i += 1) {
    await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders(`203.0.113.${i}`), payload: { messages: [] } });
  }
  const results = await Promise.all([
    app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders('203.0.113.10'), payload: { messages: [] } }),
    app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders('203.0.113.11'), payload: { messages: [] } }),
  ]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 429]);
});

test('32. concurrent contenders for the last global slot do not overrun it', async (t) => {
  const store = new MemoryQuotaStore();
  const { app } = appFixture({ store, config: { globalRequestLimit: 1 } });
  t.after(() => app.close());
  const results = await Promise.all([
    app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders('203.0.113.1'), payload: { messages: [] } }),
    app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders('203.0.113.2'), payload: { messages: [] } }),
  ]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 429]);
  assert.equal(store.globalCount, 1);
});

test('33. client disconnect aborts upstream and releases the lease', async (t) => {
  let upstreamAborted = false;
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'));
        init?.signal?.addEventListener('abort', () => {
          upstreamAborted = true;
          controller.error(new Error('aborted'));
        });
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  const store = new MemoryQuotaStore();
  const { app } = appFixture({ store, fetchImpl });
  await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => app.close());
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');

  await new Promise<void>((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: address.port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: { ...authHeaders(), 'content-length': Buffer.byteLength('{"messages":[],"stream":true}') },
    });
    request.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ECONNRESET') resolve();
      else reject(error);
    });
    request.on('response', (response) => {
      response.once('data', () => {
        request.destroy();
        response.destroy();
        resolve();
      });
    });
    request.end('{"messages":[],"stream":true}');
  });
  for (let i = 0; i < 100 && (!upstreamAborted || store.leases.size !== 0); i += 1) await delay(5);
  assert.equal(upstreamAborted, true);
  assert.equal(store.leases.size, 0);
});
