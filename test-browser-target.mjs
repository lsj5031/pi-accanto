import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { injectedDocument } from './document-identity.js';
import { hostPermission } from './host-permission.js';

const root = import.meta.dirname;
test('Firefox host patterns omit ports while transport/Chrome keep their origin', () => {
  const firefox = { browser_specific_settings: { gecko: {} } };
  assert.equal(hostPermission('http://localhost:41234/v1', firefox), 'http://localhost/*');
  assert.equal(hostPermission('http://localhost:41234/v1', {}), 'http://localhost:41234/*');
  assert.equal(hostPermission('https://example.test:8443/path', firefox), 'https://example.test/*');
  assert.throws(() => hostPermission('file:///tmp/private.pdf', firefox), /HTTP/);
});
test('document reads fail closed for empty, errored, missing and different identities', () => {
  for (const results of [undefined, [], [{}], [{ error: 'denied' }], [{ documentId: 'document-B', error: 'denied', result: {} }], [{ result: {} }], [{ documentId: '', result: {} }], [{ documentId: 'bad identity', result: {} }], [{ documentId: 'document-A', result: {} }]]) {
    assert.throws(() => injectedDocument(results, 'document-B'), /securely/);
  }
  const result = { documentId: 'document-B', result: { text: 'selected document' } };
  assert.equal(injectedDocument([result], 'document-B'), result);
  assert.throws(() => injectedDocument([{ ...result, result: { error: 'Attach this PDF as a file' } }]), /Attach this PDF as a file/);
});

test('browser builds preserve Chrome identity and Firefox security/assets at ZIP root', async () => {
  const source = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  const chrome = JSON.parse(await readFile(resolve(root, 'dist/manifest.json'), 'utf8'));
  delete source.action.default_popup;
  assert.deepEqual(chrome, source);
  const firefox = JSON.parse(await readFile(resolve(root, 'dist-firefox/manifest.json'), 'utf8'));
  assert.equal(firefox.key, undefined);
  assert.deepEqual(firefox.background, { scripts: ['background.js'], type: 'module' });
  assert.equal(firefox.incognito, 'not_allowed');
  assert.equal(firefox.browser_specific_settings.gecko.id, 'pi-accanto@lsj5031.github.io');
  assert.equal(firefox.browser_specific_settings.gecko.strict_min_version, '153.0');
  assert.deepEqual(firefox.browser_specific_settings.gecko.data_collection_permissions.required, ['websiteContent', 'browsingActivity', 'searchTerms', 'personalCommunications', 'authenticationInfo']);
  for (const key of ['permissions', 'host_permissions', 'optional_host_permissions', 'content_security_policy', 'web_accessible_resources']) assert.deepEqual(firefox[key], chrome[key]);
  const scratch = await mkdtemp(resolve(tmpdir(), 'accanto-target-'));
  try {
    execFileSync('unzip', ['-q', resolve(root, `artifacts/pi-accanto-${source.version}-firefox.zip`), '-d', scratch]);
    assert.deepEqual(JSON.parse(await readFile(resolve(scratch, 'manifest.json'), 'utf8')), firefox);
    for (const file of ['quickjs.wasm', 'PDFJS-LICENSE', 'pdf.worker.mjs', 'wasm/jbig2_nowasm_fallback.js', 'wasm/openjpeg_nowasm_fallback.js', 'wasm/LICENSE_JBIG2', 'wasm/LICENSE_OPENJPEG', 'third-party/index.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
      assert.deepEqual(await readFile(resolve(scratch, file)), await readFile(resolve(root, 'dist-firefox', file)));
    }
    const notices = JSON.parse(await readFile(resolve(scratch, 'third-party/index.json'), 'utf8'));
    for (const notice of notices) for (const file of notice.files) assert.ok((await readFile(resolve(scratch, file))).length);
    const metadata = JSON.parse(await readFile(resolve(scratch, 'bundle-meta.json'), 'utf8'));
    assert.ok(metadata.outputs['dist-firefox/panel.js']);
    assert.ok(metadata.outputs['dist-firefox/codemode-worker.js']);
    for (const output of Object.values(metadata.outputs)) assert.equal(output.imports.some(item => item.external), false);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test('unknown build/package flags fail before touching artifacts', () => {
  for (const script of ['build.mjs', 'package-extension.mjs']) assert.throws(() => execFileSync(process.execPath, [resolve(root, script), '--browser=unknown'], { cwd: root, stdio: 'pipe' }), /Usage:/);
});
