import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requiredScope, hasScope, filterToolsByScope } from '../dist/scopes.js';

test('mutating tools require write — including ones whose names do not say so', () => {
  for (const n of ['bw_create_adso', 'bw_update_query_layout', 'bw_delete', 'bw_activate', 'bw_push_data', 'bw_run_dtp']) {
    assert.equal(requiredScope(n), 'write', n);
  }
  // bw_unlock reads as harmless but mutates server-side lock state.
  assert.equal(requiredScope('bw_unlock'), 'write');
});

test('read tools that issue POSTs are still reads', () => {
  // Both POST, neither changes anything: bw_query_data sends BICS navigation,
  // bw_preview_datasource posts an empty body to sample rows.
  assert.equal(requiredScope('bw_query_data'), 'read');
  assert.equal(requiredScope('bw_preview_datasource'), 'read');
});

test('an unrecognised tool requires write, so a new tool fails closed', () => {
  // A tool added later without updating scopes.ts must not be offered to readers.
  assert.equal(requiredScope('bw_some_future_tool'), 'write');
  const reader = { token: 't', clientId: 'c', scopes: ['read'] };
  assert.ok(!hasScope(reader, requiredScope('bw_delete_everything_new')));
});

test('write implies read; read does not imply write', () => {
  const w = { token: 't', clientId: 'c', scopes: ['write'] };
  const r = { token: 't', clientId: 'c', scopes: ['read'] };
  assert.ok(hasScope(w, 'read'));
  assert.ok(hasScope(w, 'write'));
  assert.ok(hasScope(r, 'read'));
  assert.ok(!hasScope(r, 'write'));
});

test('XSUAA-qualified scopes are accepted', () => {
  assert.ok(hasScope({ token: 't', clientId: 'c', scopes: ['bwmcp!t42.write'] }, 'write'));
});

test('stdio has no authInfo and is unrestricted', () => {
  assert.ok(hasScope(undefined, 'write'));
  const tools = [{ name: 'bw_get_adso' }, { name: 'bw_delete' }];
  assert.equal(filterToolsByScope(tools, undefined).length, 2);
});
