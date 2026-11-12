import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, rm, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { prepareRelease } from './release.mjs';
test('offline release preparation verifies real ZIP, versions, notes and corruption', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'accanto-release-'));
  try {
    for (const f of ['package.json', 'package-lock.json', 'manifest.json', 'CHANGELOG.md', 'artifacts']) await cp(resolve(f), resolve(root, f), { recursive: true });
    await assert.rejects(prepareRelease({ root, tag: 'v0.2.0' }), /versions/);
    await prepareRelease({ root, tag: 'v0.3.0' });
    await prepareRelease({ root, tag: 'v0.3.0', verify: true });
    const lockPath = resolve(root, 'package-lock.json');
    const lock = await readFile(lockPath, 'utf8');
    const wrong = JSON.parse(lock); wrong.packages[''].version = '0.2.0';
    await writeFile(lockPath, JSON.stringify(wrong));
    await assert.rejects(prepareRelease({ root, tag: 'v0.3.0' }), /versions/);
    await writeFile(lockPath, lock);
    await writeFile(resolve(root, 'artifacts/SHA256SUMS'), 'corrupt');
    await assert.rejects(prepareRelease({ root, tag: 'v0.3.0', verify: true }), /Checksum/);
    const zip = resolve(root, 'artifacts/pi-accanto-0.3.0.zip');
    await writeFile(resolve(root, '.env'), 'synthetic-not-a-secret');
    execFileSync('zip', ['-q', zip, '.env'], { cwd: root });
    await assert.rejects(prepareRelease({ root, tag: 'v0.3.0' }), /Private|Unsafe/);
    execFileSync('zip', ['-qd', zip, '.env']);
    execFileSync('zip', ['-qd', zip, 'wasm/jbig2_nowasm_fallback.js']);
    await assert.rejects(prepareRelease({ root, tag: 'v0.3.0' }), /Missing archive asset: wasm\/jbig2/);
    execFileSync('zip', ['-q', zip, 'wasm/jbig2_nowasm_fallback.js'], { cwd: resolve('dist') });
    execFileSync('zip', ['-qd', zip, 'panel.js']);
    await assert.rejects(prepareRelease({ root, tag: 'v0.3.0' }), /Missing archive asset/);
    await rm(zip);
    await assert.rejects(prepareRelease({ root, tag: 'v0.3.0' }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('packaging the same build twice produces immutable identical bytes', async () => {
  const archive = resolve('artifacts/pi-accanto-0.3.0.zip');
  const hash = async () => createHash('sha256').update(await readFile(archive)).digest('hex');
  const before = await hash();
  execFileSync(process.execPath, [resolve('package-extension.mjs')], { cwd: import.meta.dirname, stdio: 'pipe' });
  assert.equal(await hash(), before);
});
test('publisher shell is idempotent and refuses changed or unexpected assets offline', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'accanto-publisher-'));
  try {
    await mkdir(resolve(root, 'bin'));
    const workflow = await readFile(resolve('.github/workflows/release.yml'), 'utf8');
    const shell = workflow.split('run: |\n').at(-1).split('\n').map(line => line.replace(/^ {10}/, '')).join('\n');
    const mock = resolve(root, 'bin/gh');
    await writeFile(mock, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const root = process.env.MOCK_ROOT, args = process.argv.slice(2), action = args[1];
const statePath = path.join(root, 'state.json'), remote = path.join(root, 'remote');
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath)) : null;
const log = action => fs.appendFileSync(path.join(root, 'writes'), action+'\\n');
const save = value => fs.writeFileSync(statePath, JSON.stringify(value));
if (action === 'view') {
  if (!state) process.exit(1);
  if (args.includes('assets')) { const names = fs.readdirSync(remote); if (names.length) console.log(names.join('\\n')); }
  else if (args.includes('--jq')) console.log(state.isDraft);
  else console.log(JSON.stringify(state));
} else if (action === 'create') { fs.mkdirSync(remote, {recursive:true}); save({isDraft:true}); log('create'); }
else if (action === 'download') {
  const files = fs.readdirSync(remote); if (!files.length) process.exit(1);
  const dir = args[args.indexOf('--dir')+1];
  for (const file of files) fs.copyFileSync(path.join(remote,file),path.join(dir,file));
} else if (action === 'upload') {
  const file = args[3], target = path.join(remote,file);
  if (fs.existsSync(target)) process.exit(1);
  fs.copyFileSync(file,target); log('upload');
} else if (action === 'edit') { save({isDraft:false}); log('publish'); }
else process.exit(2);
`);
    await chmod(mock, 0o755);
    const makeRun = async name => {
      const dir = resolve(root, name);
      await mkdir(resolve(dir, 'assets'), { recursive: true });
      for (const file of ['pi-accanto-0.3.0.zip', 'SHA256SUMS', 'RELEASE_NOTES.md']) await cp(resolve('artifacts', file), resolve(dir, 'assets', file));
      return dir;
    };
    // Preparation ensures this test does not depend on a previous CLI invocation.
    await prepareRelease({ tag: 'v0.3.0' });
    const run = dir => execFileSync('bash', ['-c', shell], { cwd: dir, env: { ...process.env, PATH: `${resolve(root, 'bin')}:${process.env.PATH}`, MOCK_ROOT: root, GITHUB_REF_NAME: 'v0.3.0' }, stdio: 'pipe' });
    run(await makeRun('first'));
    assert.equal(JSON.parse(await readFile(resolve(root, 'state.json'))).isDraft, false);
    const writes = await readFile(resolve(root, 'writes'), 'utf8');
    assert.equal(writes, 'create\nupload\nupload\npublish\n');
    run(await makeRun('rerun'));
    assert.equal(await readFile(resolve(root, 'writes'), 'utf8'), writes);
    // A pre-existing draft with an unrelated file must not be published.
    await writeFile(resolve(root, 'state.json'), '{"isDraft":true}');
    await writeFile(resolve(root, 'remote/private.txt'), 'synthetic unrelated asset');
    const unexpected = await makeRun('unexpected');
    assert.throws(() => run(unexpected), /Unexpected release asset/);
    assert.equal(await readFile(resolve(root, 'writes'), 'utf8'), writes);
    await rm(resolve(root, 'remote/private.txt'));
    // Differing immutable bytes must never be overwritten, even in a draft.
    await writeFile(resolve(root, 'remote/pi-accanto-0.3.0.zip'), 'corrupt remote');
    const changed = await makeRun('changed');
    assert.throws(() => run(changed));
    assert.equal(await readFile(resolve(root, 'remote/pi-accanto-0.3.0.zip'), 'utf8'), 'corrupt remote');
    assert.equal(JSON.parse(await readFile(resolve(root, 'state.json'))).isDraft, true);
    assert.equal(await readFile(resolve(root, 'writes'), 'utf8'), writes);
    // A rerun can safely complete a partial draft without reuploading the ZIP.
    await cp(resolve('artifacts/pi-accanto-0.3.0.zip'), resolve(root, 'remote/pi-accanto-0.3.0.zip'));
    await rm(resolve(root, 'remote/SHA256SUMS'));
    run(await makeRun('partial'));
    assert.equal(await readFile(resolve(root, 'writes'), 'utf8'), `${writes}upload\npublish\n`);
    assert.equal(JSON.parse(await readFile(resolve(root, 'state.json'))).isDraft, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
