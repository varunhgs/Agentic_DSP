import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BwClient, MEDIA_TYPES } from '../dist/bw-client.js';
import { bwGetAdso } from '../dist/tools/adso.js';

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));

// Deliberately BELOW the hardcoded fallback: this is the case that used to fail, because
// the fallback was kept and the backend then rejected it with HTTP 415.
const ADSO_ADVERTISED = 'application/vnd.sap.bw.modeling.adso-v1_6_0+xml';

const DISCOVERY = `<?xml version="1.0" encoding="utf-8"?>
<app:service xmlns:app="http://www.w3.org/2007/app">
  <app:workspace>
    <app:collection href="/sap/bw/modeling/adso">
      <app:accept>application/vnd.sap.bw.modeling.adso-v1_6_0+json</app:accept>
      <app:accept>${ADSO_ADVERTISED}</app:accept>
    </app:collection>
  </app:workspace>
</app:service>`;

/** A backend that serves one aDSO version and answers 415 for anything else, like BW does. */
function startFakeBw() {
  const seen = { adsoAccept: null };
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/sap/bw/modeling/repo/is/systeminfo')) {
      res.setHeader('x-csrf-token', 'test-token');
      res.end('<systeminfo/>');
    } else if (req.url.startsWith('/sap/bw/modeling/discovery')) {
      res.setHeader('content-type', 'application/atomsvc+xml');
      res.end(DISCOVERY);
    } else if (req.url.includes('/sap/bw/modeling/adso/')) {
      seen.adsoAccept = req.headers.accept ?? '';
      if (!seen.adsoAccept.includes('adso-v1_6_0+xml')) {
        res.statusCode = 415;
        res.end('<exception>ExceptionUnsupportedMediaType</exception>');
      } else {
        res.end('<adso:dataStore name="OBJECT_NAME"/>');
      }
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, seen, port: server.address().port }));
  });
}

function basicClient(port) {
  return new BwClient({
    url: `http://127.0.0.1:${port}`,
    auth: { kind: 'basic', user: 'user', password: 'secret' },
  });
}

test('discovery overrides the hardcoded fallback even when it advertises a lower version', async () => {
  const { server, port } = await startFakeBw();
  try {
    await basicClient(port).loadMediaTypes();
    assert.equal(MEDIA_TYPES['adso'], ADSO_ADVERTISED);
  } finally {
    server.close();
  }
});

test('a discovered media type reaches the wire on the next aDSO read', async () => {
  const { server, seen, port } = await startFakeBw();
  const saved = {
    url: process.env.BW_URL,
    user: process.env.BW_USER,
    password: process.env.BW_PASSWORD,
    cookieFile: process.env.BW_COOKIE_FILE,
  };
  process.env.BW_URL = `http://127.0.0.1:${port}`;
  process.env.BW_USER = 'user';
  process.env.BW_PASSWORD = 'secret';
  delete process.env.BW_COOKIE_FILE;
  try {
    const client = basicClient(port);
    await client.loadMediaTypes();
    // Used to throw "HTTP 415": the Accept header was bound at import time, so the value
    // discovery had just written could never reach the request.
    await bwGetAdso(client, 'OBJECT_NAME', 'raw');
    assert.match(seen.adsoAccept, /adso-v1_6_0\+xml/);
    assert.doesNotMatch(seen.adsoAccept, /adso-v1_7_0/);
  } finally {
    server.close();
    for (const [key, value] of Object.entries({
      BW_URL: saved.url,
      BW_USER: saved.user,
      BW_PASSWORD: saved.password,
      BW_COOKIE_FILE: saved.cookieFile,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('no module-level declaration captures MEDIA_TYPES at import time', () => {
  // Discovery runs lazily on the first tool call, so a top-level `const X = MEDIA_TYPES[...]`
  // freezes the hardcoded fallback for the life of the process. Accept headers must be
  // resolved inside a function instead.
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts')) files.push(full);
    }
  };
  walk(SRC_DIR);

  const offenders = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const [statement] of source.matchAll(/^(?:export\s+)?(?:const|let|var)\s[^;]*?;/gms)) {
      if (!statement.includes('MEDIA_TYPES[')) continue;
      if (statement.includes('=>') || statement.includes('function')) continue;
      offenders.push(`${file}: ${statement.split('\n')[0]}`);
    }
  }
  assert.deepEqual(offenders, []);
});
