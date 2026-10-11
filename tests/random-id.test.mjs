import test from 'node:test';
import assert from 'node:assert/strict';
import { secureRandomUUID, createLocalId } from '../src/lib/random-id.ts';
import { mockCrypto } from './helpers/crypto-context.mjs';

test('HTTP-compatible secure UUID uses getRandomValues with the correct version and variant', (context) => {
  let calls = 0;
  mockCrypto(context, { getRandomValues: (bytes) => { calls++; bytes.fill(0xab); return bytes; } });
  context.mock.method(Math, 'random', () => { throw new Error('weak entropy must not be used'); });
  assert.equal(secureRandomUUID(), 'abababab-abab-4bab-abab-abababababab');
  assert.equal(calls, 1);
});

test('no Web Crypto permits distinct local identities but refuses a security nonce', (context) => {
  mockCrypto(context, undefined);
  context.mock.method(Date, 'now', () => 1000);
  context.mock.method(Math, 'random', () => 0.5);
  assert.notEqual(createLocalId(), createLocalId());
  assert.match(createLocalId(), /^[a-z0-9-]+$/);
  assert.throws(secureRandomUUID, /安全随机数/);
});
