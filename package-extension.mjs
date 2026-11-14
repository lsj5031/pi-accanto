import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, readdir, rm, utimes } from 'node:fs/promises';
import { resolve } from 'node:path';

const target = process.argv.slice(2);
if (target.length > 1 || (target.length && !['--browser=chrome', '--browser=firefox'].includes(target[0]))) throw new Error('Usage: node package-extension.mjs [--browser=chrome|--browser=firefox]');
const firefox = target[0] === '--browser=firefox';
const directory = firefox ? 'dist-firefox' : 'dist';
const dist = resolve(directory);
const manifest = JSON.parse(await readFile(resolve(dist, 'manifest.json'), 'utf8'));
if (firefox !== Boolean(manifest.browser_specific_settings?.gecko)) throw new Error('Manifest browser target does not match the package target.');
if (manifest.action.default_popup) throw new Error('Package the built dist folder, not the source checkout.');
if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(manifest.version)) throw new Error('Invalid extension version.');
for (const file of ['panel.js', 'panel.html', 'companion.html', 'companion-bridge.js', 'companion-host.js', 'background.js', 'codemode-worker.js', 'quickjs.wasm', 'basecoat.css', 'panel.css', 'pdf.worker.mjs', 'third-party/index.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
  await access(resolve(dist, file));
}
// esbuild's metadata identifies any imports left for Chrome to resolve.
const metadata = JSON.parse(await readFile(resolve(dist, 'bundle-meta.json'), 'utf8'));
for (const entry of [`${directory}/panel.js`, `${directory}/codemode-worker.js`]) {
  if (!metadata.outputs[entry]) throw new Error(`Missing bundle metadata for ${entry}. Rebuild before packaging.`);
}
for (const output of Object.values(metadata.outputs)) {
  if (output.imports.some(item => item.external)) throw new Error('The extension bundle still contains external imports.');
}
await mkdir('artifacts', { recursive: true });
const archive = resolve('artifacts', `pi-accanto-${manifest.version}${firefox ? '-firefox' : ''}.zip`);
await rm(archive, { force: true });
if (process.platform === 'win32') {
  // Paths are passed as environment variables, never interpolated as commands.
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Compress-Archive -Path (Join-Path $env:ACCANTO_DIST "*") -DestinationPath $env:ACCANTO_ARCHIVE'], {
    env: { ...process.env, ACCANTO_DIST: dist, ACCANTO_ARCHIVE: archive }, stdio: 'inherit',
  });
} else {
  const files = [];
  async function walk(prefix = '') {
    for (const entry of (await readdir(resolve(dist, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const name = `${prefix}${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error('Package must not contain symlinks.');
      if (entry.isDirectory()) await walk(`${name}/`);
      else {
        await utimes(resolve(dist, name), new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
        files.push(name);
      }
    }
  }
  await walk();
  execFileSync('zip', ['-X', '-q', archive, ...files], { cwd: dist, stdio: 'inherit', env: { ...process.env, TZ: 'UTC' } });
}
console.log(`Installable extension: ${archive}`);
