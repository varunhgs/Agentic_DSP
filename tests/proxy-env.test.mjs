import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { BwClient } from '../dist/bw-client.js';

// RFC 6761 reserves .invalid, so this host never resolves. Any answer at all therefore
// proves the request went through a proxy rather than straight to DNS — which is how the
// BAS case works: the destination host exists only inside the proxy.
const UNRESOLVABLE = 'http://bw-host.invalid';

function startFakeProxy() {
  const seen = { url: null, proxyAuth: null, locationId: null };
  const server = http.createServer((req, res) => {
    seen.url = req.url;
    seen.proxyAuth = req.headers['proxy-authorization'] ?? null;
    seen.locationId = req.headers['sap-connectivity-scc-location_id'] ?? null;
    res.setHeader('x-csrf-token', 'token-via-proxy');
    res.end('<via-proxy/>');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, seen, port: server.address().port }));
  });
}

/** Runs `fn` with the given proxy environment and restores it afterwards. */
async function withProxyEnv(httpProxy, fn) {
  const saved = {
    HTTP_PROXY: process.env.HTTP_PROXY,
    http_proxy: process.env.http_proxy,
    NO_PROXY: process.env.NO_PROXY,
    no_proxy: process.env.no_proxy,
  };
  // Clear first, set second: on Windows process.env is case-insensitive, so deleting
  // `http_proxy` after setting `HTTP_PROXY` would remove the value just written.
  delete process.env.http_proxy;
  delete process.env.NO_PROXY;
  delete process.env.no_proxy;
  process.env.HTTP_PROXY = httpProxy;
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('the environment proxy is honoured when no Cloud Connector hop is configured', async () => {
  const { server, seen, port } = await startFakeProxy();
  try {
    await withProxyEnv(`http://127.0.0.1:${port}`, async () => {
      const client = new BwClient({
        url: UNRESOLVABLE,
        auth: { kind: 'basic', user: 'user', password: 'secret' },
      });
      // `proxy: false` used to disable HTTP_PROXY as well, and this failed with ENOTFOUND.
      const { body } = await client.get('/sap/bw/modeling/adso/object_name/m', 'application/xml');
      assert.equal(body, '<via-proxy/>');
      // Absolute-form request URI — the hallmark of a plain HTTP proxy hop.
      assert.match(seen.url, /^http:\/\/bw-host\.invalid\//);
      assert.equal(seen.proxyAuth, null);
    });
  } finally {
    server.close();
  }
});

test('an explicit Cloud Connector hop wins over the environment proxy', async () => {
  const { server, seen, port } = await startFakeProxy();
  try {
    // Points at a port nothing listens on: if this were used, the request would fail.
    await withProxyEnv('http://127.0.0.1:1', async () => {
      const client = new BwClient({
        url: UNRESOLVABLE,
        auth: { kind: 'basic', user: 'user', password: 'secret' },
        proxy: { host: '127.0.0.1', port, token: 'connectivity-token', locationId: 'LOC' },
      });
      const { body } = await client.get('/sap/bw/modeling/adso/object_name/m', 'application/xml');
      assert.equal(body, '<via-proxy/>');
      assert.equal(seen.proxyAuth, 'Bearer connectivity-token');
      assert.equal(seen.locationId, 'LOC');
    });
  } finally {
    server.close();
  }
});
