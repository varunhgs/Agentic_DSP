import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertProxyableUrl, createPrincipalPropagationClient, userLabel } from '../dist/destination.js';

test('an https destination behind the Cloud Connector is rejected up front', () => {
  // Otherwise the HTTP client tunnels with CONNECT, dropping both the proxy and identity
  // headers, and the connectivity proxy answers 405 with no hint at the real cause.
  assert.throws(() => assertProxyableUrl('https://bw.internal:44300', 'BW4'), /requires http:\/\//);
  assert.doesNotThrow(() => assertProxyableUrl('http://bw.internal:8000', 'BW4'));
});

test('principal propagation requires a JWT', async () => {
  const deps = { btpConfig: {}, destinationName: 'BW4' };
  await assert.rejects(() => createPrincipalPropagationClient(deps, undefined), /requires a JWT bearer token/);
  await assert.rejects(
    () => createPrincipalPropagationClient(deps, { token: 'opaque', scopes: [], clientId: 'x' }),
    /requires a JWT bearer token/,
  );
});

test('userLabel never throws on a malformed token', () => {
  assert.equal(userLabel(undefined), 'anonymous');
  assert.equal(userLabel({ token: 'a.b.c', scopes: [], clientId: 'x' }), 'unknown');
});
