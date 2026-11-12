import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function prepareRelease({ root = process.cwd(), tag, verify = false } = {}) {
  const json = async file => JSON.parse(await readFile(resolve(root, file), 'utf8'));
  const pkg = await json('package.json'), lock = await json('package-lock.json'), manifest = await json('manifest.json');
  if (!/^v\d+\.\d+\.\d+$/.test(tag || '') || tag !== `v${pkg.version}` || lock.version !== pkg.version || lock.packages[''].version !== pkg.version || manifest.version !== pkg.version) throw new Error('Tag, package, lock and manifest versions must agree.');
  const name = `pi-accanto-${pkg.version}.zip`;
  const archive = resolve(root, 'artifacts', name);
  // Inspect the actual ZIP, not a staging directory. Reject paths, duplicates,
  // private/config/test files and unexpected top-level content before extraction.
  const names = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).trim().split('\n');
  const privatePath = /(?:^|\/)(?:\.|test(?:s|-results)?(?:\/|\.|-)|credentials(?:\/|\.|-)|secrets?(?:\/|\.|-))|\.(?:pem|key|env|log|zip)$/i;
  if (names.some(n => privatePath.test(n) ||
    n.startsWith('assets/') && !/^assets\/(?:icon-(?:16|32|48|128)\.png|companion\.svg)$/.test(n) ||
    n.startsWith('cmaps/') && !/^cmaps\/(?:[a-zA-Z0-9_.-]+\.bcmap|LICENSE)$/.test(n) ||
    n.startsWith('standard_fonts/') && !/^standard_fonts\/(?:[a-zA-Z0-9_-]+\.(?:ttf|pfb)|LICENSE_[A-Z]+)$/.test(n) ||
    n.startsWith('licenses/') && !/^licenses\/[A-Z-]+LICENSE$/.test(n) ||
    n.startsWith('third-party/') && !/^third-party\/(?:index\.json|[@a-zA-Z0-9_-]+\/(?:licen[cs]e|notice|copying)(?:[._-][a-zA-Z0-9_-]+)?)$/i.test(n))) throw new Error('Private or unexpected archive file.');
  if (new Set(names).size !== names.length || names.some(n => n.includes('..') || n.includes('\\') || n.startsWith('/') || !/^(?:assets\/|cmaps\/|standard_fonts\/|licenses\/|third-party\/|(?:manifest\.json|panel\.(?:js|html|css)|companion(?:-bridge|-host)?\.(?:js|html)|background\.js|codemode-worker\.js|quickjs\.wasm|basecoat\.css|pdf\.worker\.mjs|bundle-meta\.json|LICENSE|THIRD_PARTY_NOTICES\.md|[A-Z-]+-LICENSE)$)/.test(n))) throw new Error('Unsafe archive structure.');
  for (const n of ['manifest.json', 'panel.js', 'panel.html', 'background.js', 'quickjs.wasm']) if (!names.includes(n)) throw new Error(`Missing archive asset: ${n}`);
  execFileSync('unzip', ['-tq', archive], { stdio: 'pipe' });
  const built = JSON.parse(execFileSync('unzip', ['-p', archive, 'manifest.json'], { encoding: 'utf8' }));
  const expected = structuredClone(manifest); delete expected.action.default_popup;
  if (JSON.stringify(built) !== JSON.stringify(expected)) throw new Error('Archive manifest differs from release manifest.');
  const hash = createHash('sha256').update(await readFile(archive)).digest('hex');
  const sums = `${hash}  ${name}\n`;
  const sumPath = resolve(root, 'artifacts/SHA256SUMS');
  const changelog = await readFile(resolve(root, 'CHANGELOG.md'), 'utf8');
  const section = changelog.split(`## ${pkg.version}\n`)[1]?.split('\n## ')[0]?.trim();
  if (!section) throw new Error('Missing maintained release notes.');
  const notes = `${section}\n\nDownload **${name}** and **SHA256SUMS** below. This is a directly installable extension ZIP, not the CI artifact wrapper. Follow the README installation/update steps. No Chrome Web Store account is needed.\n`;
  const notesPath = resolve(root, 'artifacts/RELEASE_NOTES.md');
  if (verify) {
    if (await readFile(sumPath, 'utf8') !== sums) throw new Error('Checksum verification failed.');
    if (await readFile(notesPath, 'utf8') !== notes) throw new Error('Release notes verification failed.');
  } else {
    await writeFile(sumPath, sums);
    await writeFile(notesPath, notes);
  }
  return { name, hash };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await prepareRelease({ tag: process.argv.find(v => /^v\d/.test(v)) || process.env.GITHUB_REF_NAME, verify: process.argv.includes('--verify') });
  console.log('Release assets verified.');
}
