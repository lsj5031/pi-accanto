import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const root = import.meta.dirname;
const extension = resolve(process.env.ACCANTO_FIREFOX_EXTENSION || resolve(root, 'dist-firefox'));

test('unsigned Firefox download preserves the built runtime and security boundaries', async () => {
  const source = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  const built = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
  const archive = resolve(process.env.ACCANTO_FIREFOX_PACKAGE || resolve(root, 'artifacts', `pi-accanto-${built.version}-firefox.zip`));
  const entries = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8', timeout: 10000 }).trim().split('\n');
  assert.ok(entries.includes('manifest.json'), 'Manifest must be at archive root');
  assert.equal(entries.some(entry => entry.startsWith('/') || entry.split('/').includes('..')), false);
  const packaged = file => execFileSync('unzip', ['-p', archive, file], { timeout: 10000, maxBuffer: 32 * 1024 * 1024 });
  const files = async (directory, prefix = '') => {
    const result = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) result.push(...await files(resolve(directory, entry.name), `${name}/`));
      else {
        assert.ok(entry.isFile(), `Unexpected non-file in distribution: ${name}`);
        result.push(name);
      }
    }
    return result;
  };
  const builtFiles = (await files(extension)).sort();
  assert.deepEqual(entries.filter(entry => !entry.endsWith('/')).sort(), builtFiles, 'ZIP contains exactly the final distribution files');
  for (const file of builtFiles) {
    assert.ok(packaged(file).equals(await readFile(resolve(extension, file))), `${file} differs from final build`);
  }
  assert.deepEqual(JSON.parse(packaged('manifest.json')), built);
  assert.equal(built.key, undefined, 'Chrome public key is not a Firefox runtime identity');
  assert.equal(built.background.service_worker, undefined);
  assert.ok(built.background.scripts.length);
  assert.equal(built.browser_specific_settings.gecko.strict_min_version, '153.0');
  assert.ok(built.browser_specific_settings.gecko.id);
  assert.equal(built.incognito, 'not_allowed');
  assert.equal(built.action.default_popup, undefined, 'Shipping toolbar must start the real background flow');
  assert.deepEqual(built.permissions, source.permissions);
  assert.deepEqual(built.optional_host_permissions, source.optional_host_permissions);
  assert.deepEqual(built.web_accessible_resources, source.web_accessible_resources);
  assert.deepEqual(built.content_security_policy, source.content_security_policy, 'Port must not weaken CSP for tests or Wasm');
  for (const file of [
    ...built.background.scripts, 'panel.html', 'panel.js', 'companion.html',
    'companion-bridge.js', 'companion-host.js', 'codemode-worker.js', 'quickjs.wasm',
    'pdf.worker.mjs', 'wasm/openjpeg_nowasm_fallback.js', 'wasm/jbig2_nowasm_fallback.js',
    'third-party/index.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
  ]) {
    assert.ok(packaged(file).equals(await readFile(resolve(extension, file))), `${file} differs from tested build`);
  }
  assert.equal(entries.some(entry => /(^|\/)(?:node_modules|test-results|firefox-[^/]*\.mjs)(?:\/|$)/.test(entry)), false, 'No test harness belongs in the shipping package');
});
