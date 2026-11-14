import { build } from 'esbuild';
import { mkdir, copyFile, cp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { boundedPdfWorker } from './pdf-worker-build.mjs';

const target = process.argv.slice(2);
if (target.length > 1 || (target.length && !['--browser=chrome', '--browser=firefox'].includes(target[0]))) throw new Error('Usage: node build.mjs [--browser=chrome|--browser=firefox]');
const firefox = target[0] === '--browser=firefox';
const dist = firefox ? 'dist-firefox' : 'dist';
await mkdir(dist, { recursive: true });
const result = await build({
  entryPoints: ['panel.js'], bundle: true, format: 'esm', platform: 'browser',
  // Extension pages have no Node/Bun process. Drop upstream Node-only fallbacks.
  define: { process: 'undefined' },
  outfile: `${dist}/panel.js`, metafile: true, minify: false, minifySyntax: true,
});
const worker = await build({
  entryPoints: ['codemode-worker.js'], bundle: true, format: 'esm', platform: 'browser',
  outfile: `${dist}/codemode-worker.js`, metafile: true,
});
await copyFile('node_modules/quickjs-wasi/quickjs.wasm', `${dist}/quickjs.wasm`);
await copyFile('node_modules/quickjs-wasi/LICENSE', `${dist}/QUICKJS-WASI-LICENSE`);
await copyFile('node_modules/basecoat-css/dist/basecoat.cdn.min.css', `${dist}/basecoat.css`);
await build({ entryPoints: ['background.js'], bundle: true, format: 'esm', platform: 'browser', outfile: `${dist}/background.js` });
for (const file of ['panel.html', 'panel.css', 'companion-host.js', 'companion-bridge.js']) {
  await copyFile(file, `${dist}/${file}`);
}
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
// Only the source checkout shows build instructions; the bundle uses onClicked.
delete manifest.action.default_popup;
if (firefox) {
  delete manifest.key;
  manifest.background = { scripts: ['background.js'], type: 'module' };
  manifest.incognito = 'not_allowed';
  manifest.browser_specific_settings = { gecko: {
    id: 'pi-accanto@lsj5031.github.io',
    strict_min_version: '153.0',
    // Declare potential user-directed transmissions, not a project backend.
    // Final Mozilla category/consent review remains a distribution gate.
    data_collection_permissions: { required: ['websiteContent', 'browsingActivity', 'searchTerms', 'personalCommunications', 'authenticationInfo'] },
  } };
}
await writeFile(`${dist}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(`${dist}/companion.html`, (await readFile('panel.html', 'utf8')).replace('src="panel.js"', 'src="companion-bridge.js"'));
await rm(`${dist}/assets`, { recursive: true, force: true });
await cp('assets', `${dist}/assets`, { recursive: true });
await writeFile(`${dist}/pdf.worker.mjs`, boundedPdfWorker(await readFile('node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', 'utf8')));
// PDF.js 6 decodes CCITT through its shipped JBIG2 decoder, even without Wasm.
// Keep execution local and retain the JS fallback and its attribution.
await mkdir(`${dist}/wasm`, { recursive: true });
for (const file of ['jbig2_nowasm_fallback.js', 'openjpeg_nowasm_fallback.js', 'LICENSE_JBIG2', 'LICENSE_PDFJS_JBIG2', 'LICENSE_OPENJPEG', 'LICENSE_PDFJS_OPENJPEG']) {
  await copyFile(`node_modules/pdfjs-dist/wasm/${file}`, `${dist}/wasm/${file}`);
}
for (const directory of ['cmaps', 'standard_fonts']) {
  await cp(`node_modules/pdfjs-dist/${directory}`, `${dist}/${directory}`, { recursive: true });
}
await copyFile('node_modules/pdfjs-dist/LICENSE', `${dist}/PDFJS-LICENSE`);
await writeFile(`${dist}/bundle-meta.json`, JSON.stringify({
  inputs: { ...result.metafile.inputs, ...worker.metafile.inputs },
  outputs: { ...result.metafile.outputs, ...worker.metafile.outputs },
}, null, 2));
await rm(`${dist}/third-party`, { recursive: true, force: true });
const packages = new Set(Object.keys({ ...result.metafile.inputs, ...worker.metafile.inputs })
  .map(input => input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)(?:\/|$)/)?.[1]).filter(Boolean));
packages.add('node_modules/basecoat-css');
packages.add('node_modules/tailwindcss');
const notices = [];
for (const directory of [...packages].sort()) {
  const metadata = JSON.parse(await readFile(`${directory}/package.json`, 'utf8'));
  const destination = `${dist}/third-party/${metadata.name.replaceAll('/', '__')}`;
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
  notices.push({ name: metadata.name, version: metadata.version, license: metadata.license, files: files.map(file => `${destination.slice(dist.length + 1)}/${file}`) });
}
await cp('licenses', `${dist}/licenses`, { recursive: true });
await writeFile(`${dist}/third-party/index.json`, JSON.stringify(notices, null, 2));
for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await copyFile(file, `${dist}/${file}`);
console.log(`Built extension in ${dist}/`);
