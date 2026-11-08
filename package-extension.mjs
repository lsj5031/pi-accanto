import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const dist = resolve('dist');
const manifest = JSON.parse(await readFile(resolve(dist, 'manifest.json'), 'utf8'));
if (manifest.action.default_popup) throw new Error('Package the built dist folder, not the source checkout.');
if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(manifest.version)) throw new Error('Invalid extension version.');
for (const file of ['panel.js', 'panel.html', 'companion.html', 'companion-bridge.js', 'companion-host.js', 'background.js', 'codemode-worker.js', 'quickjs.wasm', 'basecoat.css', 'panel.css', 'pdf.worker.mjs', 'third-party/index.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
  await access(resolve(dist, file));
}
// esbuild's metadata identifies any imports left for Chrome to resolve.
const metadata = JSON.parse(await readFile(resolve(dist, 'bundle-meta.json'), 'utf8'));
for (const entry of ['dist/panel.js', 'dist/codemode-worker.js']) {
  if (!metadata.outputs[entry]) throw new Error(`Missing bundle metadata for ${entry}. Rebuild before packaging.`);
}
for (const output of Object.values(metadata.outputs)) {
  if (output.imports.some(item => item.external)) throw new Error('The extension bundle still contains external imports.');
}
await mkdir('artifacts', { recursive: true });
const archive = resolve('artifacts', `pi-accanto-${manifest.version}.zip`);
await rm(archive, { force: true });
if (process.platform === 'win32') {
  // Paths are passed as environment variables, never interpolated as commands.
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Compress-Archive -Path (Join-Path $env:ACCANTO_DIST "*") -DestinationPath $env:ACCANTO_ARCHIVE'], {
    env: { ...process.env, ACCANTO_DIST: dist, ACCANTO_ARCHIVE: archive }, stdio: 'inherit',
  });
} else {
  execFileSync('zip', ['-q', '-r', archive, ...await readdir(dist)], { cwd: dist, stdio: 'inherit' });
}
console.log(`Installable extension: ${archive}`);
