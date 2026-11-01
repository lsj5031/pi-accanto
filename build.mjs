import { build } from 'esbuild';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
const result = await build({
  entryPoints: ['panel.js'], bundle: true, format: 'esm', platform: 'browser',
  outfile: 'dist/panel.js', metafile: true, minify: false,
});
for (const file of ['manifest.json', 'panel.html', 'panel.css', 'background.js']) {
  await copyFile(file, `dist/${file}`);
}
await writeFile('dist/bundle-meta.json', JSON.stringify(result.metafile, null, 2));
console.log('Built extension in dist/');
