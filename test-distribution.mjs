import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

const root = import.meta.dirname;
test('manifest public key pins the documented extension identity', async () => {
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  const der = Buffer.from(manifest.key, 'base64');
  assert.equal(createPublicKey({ key: der, format: 'der', type: 'spki' }).asymmetricKeyType, 'rsa');
  const id = createHash('sha256').update(der).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
  assert.equal(id, 'iojliefpiallbakabkahmiaadgmlfjkf', 'Changing the key changes the gateway origin and extension storage identity');
});

const required = ['panel.js', 'panel.html', 'companion.html', 'companion-bridge.js', 'companion-host.js', 'background.js', 'codemode-worker.js', 'quickjs.wasm', 'basecoat.css', 'panel.css', 'pdf.worker.mjs', 'third-party/index.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md'];
const extract = (archive, destination) => {
  if (process.platform === 'win32') {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Expand-Archive -LiteralPath $env:ACCANTO_ARCHIVE -DestinationPath $env:ACCANTO_EXTRACT'], {
      env: { ...process.env, ACCANTO_ARCHIVE: archive, ACCANTO_EXTRACT: destination },
    });
  } else execFileSync('unzip', ['-q', archive, '-d', destination]);
};

test('source install opens build instructions instead of unbundled agent code', async () => {
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.action.default_popup, 'source-setup.html');
  const setup = await readFile(resolve(root, manifest.action.default_popup), 'utf8');
  assert.match(setup, /npm ci/);
  assert.match(setup, /npm run build/);
  assert.match(setup, /dist/);
  assert.doesNotMatch(setup, /<script\b/i);
});

test('packager creates an unpackable ZIP and rejects source or unbundled output', async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), 'accanto-distribution-'));
  try {
    await cp(resolve(root, 'package-extension.mjs'), resolve(scratch, 'package-extension.mjs'));
    const dist = resolve(scratch, 'dist');
    await mkdir(resolve(dist, 'third-party'), { recursive: true });
    for (const file of required) await writeFile(resolve(dist, file), `fixture: ${file}`);
    const manifest = { version: '0.2.0', action: {} };
    await writeFile(resolve(dist, 'manifest.json'), JSON.stringify(manifest));
    const bundledMetadata = { outputs: { 'dist/panel.js': { imports: [] }, 'dist/codemode-worker.js': { imports: [] } } };
    await writeFile(resolve(dist, 'bundle-meta.json'), JSON.stringify(bundledMetadata));
    const pack = () => execFileSync(process.execPath, [resolve(scratch, 'package-extension.mjs')], { cwd: scratch, stdio: 'pipe' });
    pack();
    const extracted = resolve(scratch, 'extracted');
    extract(resolve(scratch, 'artifacts/pi-accanto-0.2.0.zip'), extracted);
    assert.deepEqual(JSON.parse(await readFile(resolve(extracted, 'manifest.json'), 'utf8')), manifest);
    for (const file of required) assert.equal(await readFile(resolve(extracted, file), 'utf8'), `fixture: ${file}`);
    await writeFile(resolve(dist, 'manifest.json'), JSON.stringify({ ...manifest, action: { default_popup: 'source-setup.html' } }));
    assert.throws(pack, /Package the built dist folder/);
    await writeFile(resolve(dist, 'manifest.json'), JSON.stringify(manifest));
    await writeFile(resolve(dist, 'bundle-meta.json'), JSON.stringify({ outputs: { 'dist/panel.js': { imports: [] }, 'dist/codemode-worker.js': { imports: [{ external: true, path: 'unbundled-package' }] } } }));
    assert.throws(pack, /still contains external imports/);
    await writeFile(resolve(dist, 'bundle-meta.json'), JSON.stringify({ outputs: {} }));
    assert.throws(pack, /Missing bundle metadata/);
    await writeFile(resolve(dist, 'bundle-meta.json'), JSON.stringify(bundledMetadata));
    await rm(resolve(dist, 'quickjs.wasm'));
    assert.throws(pack, /quickjs.wasm/);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test('built download contains the real extension at the archive root', async t => {
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  const archive = resolve(root, 'artifacts', `pi-accanto-${manifest.version}.zip`);
  try { await access(archive); }
  catch { t.skip('Run npm run package to validate the real build archive.'); return; }
  const scratch = await mkdtemp(resolve(tmpdir(), 'accanto-download-'));
  try {
    extract(archive, scratch);
    const built = JSON.parse(await readFile(resolve(scratch, 'manifest.json'), 'utf8'));
    delete manifest.action.default_popup;
    assert.deepEqual(built, manifest);
    for (const file of required) {
      assert.deepEqual(await readFile(resolve(scratch, file)), await readFile(resolve(root, 'dist', file)));
    }
    const metadata = JSON.parse(await readFile(resolve(scratch, 'bundle-meta.json'), 'utf8'));
    for (const entry of ['dist/panel.js', 'dist/codemode-worker.js']) {
      assert.ok(metadata.outputs[entry], `${entry} must be bundled`);
      assert.equal(metadata.outputs[entry].imports.some(item => item.external), false);
    }
    for (const icons of [built.icons, built.action.default_icon]) {
      for (const file of Object.values(icons)) await access(resolve(scratch, file));
    }
    for (const directory of ['cmaps', 'standard_fonts', 'licenses']) await access(resolve(scratch, directory));
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
