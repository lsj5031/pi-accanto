import { build } from 'esbuild';
import { mkdir, copyFile, cp, writeFile, readFile, readdir, rm } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
const result = await build({
  entryPoints: ['panel.js'], bundle: true, format: 'esm', platform: 'browser',
  outfile: 'dist/panel.js', metafile: true, minify: false,
});
const worker = await build({
  entryPoints: ['codemode-worker.js'], bundle: true, format: 'esm', platform: 'browser',
  outfile: 'dist/codemode-worker.js', metafile: true,
});
await copyFile('node_modules/quickjs-wasi/quickjs.wasm', 'dist/quickjs.wasm');
await copyFile('node_modules/quickjs-wasi/LICENSE', 'dist/QUICKJS-WASI-LICENSE');
for (const file of ['manifest.json', 'panel.html', 'panel.css', 'background.js']) {
  await copyFile(file, `dist/${file}`);
}
await cp('assets', 'dist/assets', { recursive: true });
await copyFile('node_modules/pdfjs-dist/build/pdf.worker.mjs', 'dist/pdf.worker.mjs');
for (const directory of ['cmaps', 'standard_fonts']) {
  await cp(`node_modules/pdfjs-dist/${directory}`, `dist/${directory}`, { recursive: true });
}
await copyFile('node_modules/pdfjs-dist/LICENSE', 'dist/PDFJS-LICENSE');
await writeFile('dist/bundle-meta.json', JSON.stringify(result.metafile, null, 2));
await rm('dist/third-party', { recursive: true, force: true });
const packages = new Set(Object.keys({ ...result.metafile.inputs, ...worker.metafile.inputs })
  .map(input => input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)(?:\/|$)/)?.[1]).filter(Boolean));
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
