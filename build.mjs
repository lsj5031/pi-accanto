import { build } from 'esbuild';
import { mkdir, copyFile, cp, writeFile } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
const result = await build({
  entryPoints: ['panel.js'], bundle: true, format: 'esm', platform: 'browser',
  outfile: 'dist/panel.js', metafile: true, minify: false,
});
await build({
  entryPoints: ['codemode-worker.js'], bundle: true, format: 'esm', platform: 'browser',
  outfile: 'dist/codemode-worker.js',
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
console.log('Built extension in dist/');
