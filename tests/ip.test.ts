import assert from 'node:assert/strict';
import test from 'node:test';
import { extractClientIp, hashClientIp } from '../src/ip';

/** Build a minimal HeadersLike from a plain record. */
function makeHeaders(record: Record<string, string>): Headers {
  return new Headers(record);
}

test('IPv4 is normalized and selected from x-forwarded-for', () => {
  assert.equal(extractClientIp(makeHeaders({ 'x-forwarded-for': ' 203.0.113.8 , 198.51.100.1' })), '203.0.113.8');
});

test('first valid forwarded IP is used when an earlier value is invalid', () => {
  assert.equal(extractClientIp(makeHeaders({ 'x-forwarded-for': 'not-an-ip, 203.0.113.9' })), '203.0.113.9');
});

test('IPv6 is canonicalized', () => {
  assert.equal(extractClientIp(makeHeaders({ 'x-forwarded-for': '2001:0db8:0000:0000:0000:ff00:0042:8329' })), '2001:db8::ff00:42:8329');
});

test('IPv4-mapped IPv6 is normalized to IPv4', () => {
  assert.equal(extractClientIp(makeHeaders({ 'x-forwarded-for': '::ffff:192.0.2.128' })), '192.0.2.128');
});

test('x-real-ip is used when x-forwarded-for contains no valid address', () => {
  assert.equal(extractClientIp(makeHeaders({ 'x-forwarded-for': 'invalid', 'x-real-ip': '198.51.100.44' })), '198.51.100.44');
});

test('x-vercel-forwarded-for takes priority over x-forwarded-for', () => {
  assert.equal(
    extractClientIp(makeHeaders({ 'x-vercel-forwarded-for': '203.0.113.1', 'x-forwarded-for': '198.51.100.2' })),
    '203.0.113.1',
  );
});

test('HMAC is deterministic and does not expose the raw IP', () => {
  const hash = hashClientIp('203.0.113.8', 'test-secret');
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(hash.includes('203.0.113.8'), false);
  assert.equal(hash, hashClientIp('203.0.113.8', 'test-secret'));
});
