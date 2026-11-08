import { build } from 'esbuild';
import { mkdir, copyFile, cp, writeFile, readFile, readdir, rm } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
const result = await build({
  entryPoints: ['panel.js'], bundle: true, format: 'esm', platform: 'browser',
  // Extension pages have no Node/Bun process. Drop upstream Node-only fallbacks.
  define: { process: 'undefined' },
  outfile: 'dist/panel.js', metafile: true, minify: false, minifySyntax: true,
});
const worker = await build({
  entryPoints: ['codemode-worker.js'], bundle: true, format: 'esm', platform: 'browser',
  outfile: 'dist/codemode-worker.js', metafile: true,
});
await copyFile('node_modules/quickjs-wasi/quickjs.wasm', 'dist/quickjs.wasm');
await copyFile('node_modules/quickjs-wasi/LICENSE', 'dist/QUICKJS-WASI-LICENSE');
await copyFile('node_modules/basecoat-css/dist/basecoat.cdn.min.css', 'dist/basecoat.css');
for (const file of ['panel.html', 'panel.css', 'background.js', 'companion-host.js', 'companion-bridge.js']) {
  await copyFile(file, `dist/${file}`);
}
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
// Only the source checkout shows build instructions; the bundle uses onClicked.
delete manifest.action.default_popup;
await writeFile('dist/manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile('dist/companion.html', (await readFile('panel.html', 'utf8')).replace('src="panel.js"', 'src="companion-bridge.js"'));
await rm('dist/assets', { recursive: true, force: true });
await cp('assets', 'dist/assets', { recursive: true });
await copyFile('node_modules/pdfjs-dist/build/pdf.worker.mjs', 'dist/pdf.worker.mjs');
for (const directory of ['cmaps', 'standard_fonts']) {
  await cp(`node_modules/pdfjs-dist/${directory}`, `dist/${directory}`, { recursive: true });
}
await copyFile('node_modules/pdfjs-dist/LICENSE', 'dist/PDFJS-LICENSE');
await writeFile('dist/bundle-meta.json', JSON.stringify({
  inputs: { ...result.metafile.inputs, ...worker.metafile.inputs },
  outputs: { ...result.metafile.outputs, ...worker.metafile.outputs },
}, null, 2));
await rm('dist/third-party', { recursive: true, force: true });
const packages = new Set(Object.keys({ ...result.metafile.inputs, ...worker.metafile.inputs })
  .map(input => input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)(?:\/|$)/)?.[1]).filter(Boolean));
packages.add('node_modules/basecoat-css');
packages.add('node_modules/tailwindcss');
const notices = [];
for (const directory of [...packages].sort()) {
  const metadata = JSON.parse(await readFile(`${directory}/package.json`, 'utf8'));
  const destination = `dist/third-party/${metadata.name.replaceAll('/', '__')}`;
  await mkdir(destination, { recursive: true });
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && /^(licen[cs]e|notice|copying)(?:[._-]|$)/i.test(entry.name)).map(entry => entry.name);
  if (!files.length && metadata.name.startsWith('@earendil-works/') && metadata.version === '1.4.0' && metadata.license === 'MIT') {
    await copyFile('licenses/PI-LICENSE', `${destination}/LICENSE`);
    files.push('LICENSE');
  } else if (!files.length && metadata.name === 'standardwebhooks' && metadata.version === '1.1.1' && metadata.license === 'MIT') {
    await copyFile('licenses/STANDARDWEBHOOKS-LICENSE', `${destination}/LICENSE`);
    files.push('LICENSE');
  } else {
    if (!files.length) throw new Error(`Missing license notice for bundled package ${metadata.name}; review before distributing.`);
    for (const file of files) await copyFile(`${directory}/${file}`, `${destination}/${file}`);
  }
  notices.push({ name: metadata.name, version: metadata.version, license: metadata.license, files: files.map(file => `${destination.slice(5)}/${file}`) });
}
await cp('licenses', 'dist/licenses', { recursive: true });
await writeFile('dist/third-party/index.json', JSON.stringify(notices, null, 2));
for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await copyFile(file, `dist/${file}`);
console.log('Built extension in dist/');
