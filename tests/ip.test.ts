import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { extractClientIp, hashClientIp } from '../src/ip';

async function capturedIp(headers: Record<string, string>): Promise<string | null> {
  let result: string | null = null;
  const app = Fastify({ logger: false });
  app.get('/', async (request) => {
    result = extractClientIp(request);
    return { ok: true };
  });
  await app.inject({ method: 'GET', url: '/', headers });
  await app.close();
  return result;
}

test('IPv4 is normalized and selected from x-forwarded-for', async () => {
  assert.equal(await capturedIp({ 'x-forwarded-for': ' 203.0.113.8 , 198.51.100.1' }), '203.0.113.8');
});

test('first valid forwarded IP is used when an earlier value is invalid', async () => {
  assert.equal(await capturedIp({ 'x-forwarded-for': 'not-an-ip, 203.0.113.9' }), '203.0.113.9');
});

test('IPv6 is canonicalized', async () => {
  assert.equal(await capturedIp({ 'x-forwarded-for': '2001:0db8:0000:0000:0000:ff00:0042:8329' }), '2001:db8::ff00:42:8329');
});

test('IPv4-mapped IPv6 is normalized to IPv4', async () => {
  assert.equal(await capturedIp({ 'x-forwarded-for': '::ffff:192.0.2.128' }), '192.0.2.128');
});

test('x-real-ip is used when x-forwarded-for contains no valid address', async () => {
  assert.equal(await capturedIp({ 'x-forwarded-for': 'invalid', 'x-real-ip': '198.51.100.44' }), '198.51.100.44');
});

test('HMAC is deterministic and does not expose the raw IP', () => {
  const hash = hashClientIp('203.0.113.8', 'test-secret');
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(hash.includes('203.0.113.8'), false);
  assert.equal(hash, hashClientIp('203.0.113.8', 'test-secret'));
});
