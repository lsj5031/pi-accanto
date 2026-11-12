import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { browserOptions, artifactDirectory } from './test/browser.mjs';
import { pdf } from './test/pdf-fixtures.mjs';
const artifacts = artifactDirectory('distribution');
await mkdir(artifacts, { recursive: true });
const scratch = await mkdtemp(resolve(tmpdir(), 'accanto-backup-'));
let browser;
const contexts = [];
try {
  const extension = resolve(scratch, 'extension');
  await cp('dist', extension, { recursive: true });
  await build({ stdin: { contents: `
    import { Harness, createRegistry, defineTool, defineExtension } from '@earendil-works/pi-durable';
    import { Type } from 'typebox';
    import { IndexedDbStorage } from '@earendil-works/pi-durable/storage/indexeddb';
    import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
    import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
    import { createModels } from '@earendil-works/pi-ai/models';
    export async function seed(id, png) {
      const faux = fauxProvider(); faux.setResponses([
        fauxAssistantMessage(fauxToolCall('fixture_read', {}), { stopReason: 'toolUse' }),
        fauxAssistantMessage('Synthetic answer citing evidence.txt [source-1].'),
      ]);
      const models = createModels(); models.setProvider(faux.provider);
      const registry = createRegistry();
      registry.install(defineExtension({name:'fixture',tools:[defineTool({name:'fixture_read',description:'Synthetic evidence only',parameters:Type.Object({}),execute:async()=>({output:[{type:'text',text:'Synthetic tool evidence 721.'}]})})]}));
      const harness = await Harness.open(await IndexedDbStorage.open('pi-tab-prototype-v1-'+id), {models,registry},context);
      const root = await harness.root(context);
      await root.configure({model:{provider:faux.provider.id,modelId:faux.getModel().id}},context);
      const run = await root.submit({type:'input',content:[{type:'text',text:'Synthetic question with image'},{type:'image',mimeType:'image/png',data:png}]},context);
      await run.wait(context); await harness.close(context);
    }
  `, resolveDir: process.cwd() }, bundle: true, define: { process: 'undefined' }, format: 'esm', platform: 'browser', outfile: resolve(extension, 'seed.js') });
  await build({ entryPoints: ['archives.js'], bundle: true, format: 'esm', platform: 'browser', outfile: resolve(extension, 'archive-test.js') });
  await build({ stdin: { contents: `export { validateBackup } from './portable.js'; export { inspectPortableSource } from './backup-ui.js';`, resolveDir: process.cwd() }, bundle: true, define: { process: 'undefined' }, format: 'esm', platform: 'browser', outfile: resolve(extension, 'validate-test.js') });
  const launch = async (name, ext) => {
    const c = await chromium.launchPersistentContext(resolve(scratch, name), { ...browserOptions, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`], viewport: { width: 380, height: 850 } });
    contexts.push(c);
    await c.route(/^https?:/, route => route.abort());
    const worker = c.serviceWorkers()[0] || await c.waitForEvent('serviceworker');
    await worker.evaluate(first => chrome.storage.local.set({ mode: 'scripted', modelConnection: { imageInput: true }, ...(first ? { apiKey: 'STORAGE-KEY-CANARY', braveKey: 'SEARCH-KEY-CANARY' } : {}) }), name === 'first');
    return { c, worker, base: `chrome-extension://${new URL(worker.url()).host}/panel.html` };
  };
  let first = await launch('first', extension);
  browser = first.c;
  const setup = await browser.newPage();
  await setup.goto(`${first.base}?settings=1`);
  await setup.locator('#installed-version').waitFor();
  const png = await setup.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 24; canvas.height = 16;
    canvas.getContext('2d').fillRect(0, 0, 24, 16); return canvas.toDataURL().split(',')[1];
  });
  const id = 'synthetic-live';
  await setup.evaluate(async ({ id, png }) => {
    await chrome.storage.local.set({ conversations: { [id]: { id, title: 'Synthetic evidence chat' } } });
    await (await import('./seed.js')).seed(id, png);
  }, { id, png });
  await setup.close();
  const chat = await browser.newPage();
  await chat.goto(`${first.base}?conversation=${id}&web=1`);
  await chat.waitForFunction(() => document.getElementById('status').textContent.includes('Ready'));
  await chat.locator('#attachment-files').setInputFiles([
    { name: 'evidence.txt', mimeType: 'text/plain', buffer: Buffer.from('Restored evidence 713, source text.') },
    { name: 'evidence.pdf', mimeType: 'application/pdf', buffer: pdf([['Portable PDF evidence 719.']]) },
    { name: 'evidence.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') },
  ]);
  await chat.waitForFunction(() => document.querySelectorAll('#attachment-list [data-state=ready]').length === 3);
  await chat.screenshot({ path: resolve(artifacts, 'compact.png') });
  await chat.locator('#connection > summary').click();
  const downloaded = chat.waitForEvent('download');
  await chat.locator('#export-backup').click();
  const download = await downloaded;
  const backup = JSON.parse(await readFile(await download.path(), 'utf8'));
  assert.doesNotMatch(JSON.stringify(backup), /KEY-CANARY|apiKey|browserSession|lease|endpoint/);
  assert.ok(backup.conversations[0].messages.some(m => m.blocks.some(b => b.type === 'image' && b.data === png)));
  assert.match(backup.conversations[0].transcript, /Synthetic tool evidence 721/);
  assert.equal(backup.conversations[0].sources.length, 3);
  await chat.locator('#backup-status').filter({ hasText: 'Backup download ready' }).waitFor();
  await chat.locator('#backup-status').scrollIntoViewIfNeeded();
  await chat.screenshot({ path: resolve(artifacts, 'backup-success.png') });
  await chat.evaluate(async backup => {
    const { validateBackup, inspectPortableSource } = await import('./validate-test.js');
    const cases = [
      b => { b.conversations[0].sources[2].width = 99999; },
      b => { b.conversations[0].sources[2].data = btoa('not an image'); },
      b => { b.conversations[0].sources[1].data = btoa('%PDF- corrupt'); },
      b => { b.conversations[0].sources[0].data = btoa('binary\0'); },
    ];
    for (const mutate of cases) {
      const invalid = structuredClone(backup); mutate(invalid);
      let rejected = false;
      try { await validateBackup(invalid, inspectPortableSource); } catch { rejected = true; }
      if (!rejected) throw new Error('Invalid binary backup accepted');
    }
  }, backup);
  // Another real owner blocks snapshot/import rather than taking its lease.
  await chat.evaluate(() => chrome.storage.local.set({ conversations: {
    'synthetic-live': { id: 'synthetic-live', title: 'Synthetic evidence chat' },
    'other-chat': { id: 'other-chat', title: 'Other owner' },
  } }));
  const other = await browser.newPage();
  await other.goto(`${first.base}?conversation=other-chat&web=1`);
  await other.waitForFunction(() => document.getElementById('status').textContent.includes('Ready'));
  await chat.locator('#export-backup').click();
  await chat.locator('#backup-status').filter({ hasText: 'Close other Accanto' }).waitFor();
  await other.close();
  await browser.close(); contexts.splice(contexts.indexOf(browser), 1);
  const freshExt = resolve(scratch, 'fresh-extension');
  await cp(extension, freshExt, { recursive: true });
  const manifest = JSON.parse(await readFile(resolve(freshExt, 'manifest.json'), 'utf8')); delete manifest.key;
  await writeFile(resolve(freshExt, 'manifest.json'), JSON.stringify(manifest));
  const fresh = await launch('fresh', freshExt); browser = fresh.c;
  const network = [];
  browser.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
  assert.notEqual(fresh.base, first.base);
  const settings = await browser.newPage();
  await settings.goto(`${fresh.base}?settings=1`);
  await settings.locator('#installed-version').waitFor();
  await browser.tracing.start({ screenshots: true, snapshots: true });
  const file = value => ({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) });
  await settings.locator('#backup-file').setInputFiles(file({ ...backup, version: 999 }));
  await settings.locator('#backup-status').filter({ hasText: 'Could not validate' }).waitFor();
  await settings.locator('#backup-status').scrollIntoViewIfNeeded();
  await settings.screenshot({ path: resolve(artifacts, 'backup-error.png') });
  const original = await settings.evaluate(() => chrome.storage.local.get('conversations'));
  await settings.locator('#backup-file').setInputFiles(file(backup));
  await settings.locator('#import-backup').waitFor();
  await settings.locator('#backup-status').scrollIntoViewIfNeeded();
  await settings.screenshot({ path: resolve(artifacts, 'settings-confirm.png') });
  await settings.evaluate(() => {
    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function(value) {
      IDBObjectStore.prototype.add = add;
      // Attempt cancellation after the user confirmed, while writes are queued.
      document.getElementById('cancel-import').click();
      return add.call(this, value);
    };
  });
  await settings.locator('#import-backup').click();
  await settings.locator('#backup-status').filter({ hasText: 'Imported 1' }).waitFor();
  // Repeated imports are explicitly new copies; existing live catalog untouched.
  await settings.locator('#backup-file').setInputFiles(file(backup));
  await settings.locator('#import-backup').click();
  await settings.locator('#backup-status').filter({ hasText: 'Imported 1' }).waitFor();
  const archives = await settings.evaluate(async () => {
    const api = await import('./archive-test.js');
    return Promise.all((await api.listArchives()).map(header => api.getArchive(header.id)));
  });
  assert.equal(archives.length, 2); assert.notEqual(archives[0].id, archives[1].id);
  assert.deepEqual(await settings.evaluate(() => chrome.storage.local.get('conversations')), original);
  assert.deepEqual(await settings.evaluate(() => chrome.storage.local.get(['apiKey', 'braveKey', 'modelApiKey', 'tinyfishKey'])), {});
  assert.deepEqual(archives[0].sources.map(s => s.data), backup.conversations[0].sources.map(s => s.data));
  // Abort the actual IDB transaction to simulate quota/write failure atomically.
  await settings.evaluate(async backup => {
    const api = await import('./archive-test.js');
    const original = IDBObjectStore.prototype.add;
    let count = 0;
    IDBObjectStore.prototype.add = function(value) {
      const result = original.call(this, value);
      if (++count === 2) this.transaction.abort();
      return result;
    };
    try { await api.importArchives({ conversations: [backup.conversations[0], backup.conversations[0]] }); throw new Error('Expected abort'); }
    catch (e) { if (!e.message.includes('Could not save')) throw e; }
    finally { IDBObjectStore.prototype.add = original; }
  }, backup);
  assert.equal(await settings.evaluate(async () => (await import('./archive-test.js')).listArchives().then(a => a.length)), 2);
  assert.equal(await settings.evaluate(async () => {
    const db = await (await import('./archive-test.js')).archiveStore();
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction('chats').objectStore('chats').count();
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  }), 2, 'Failed writes must not leave orphan content records');
  await settings.evaluate(async backup => {
    const api = await import('./archive-test.js');
    const original = IDBObjectStore.prototype.add;
    let count = 0;
    IDBObjectStore.prototype.add = function(value) {
      if (++count === 3) throw new DOMException('Synthetic quota failure', 'QuotaExceededError');
      return original.call(this, value);
    };
    try { await api.importArchives({ conversations: [backup.conversations[0], backup.conversations[0]] }); throw new Error('Expected quota error'); }
    catch (e) { if (!e.message.includes('Could not save')) throw e; }
    finally { IDBObjectStore.prototype.add = original; }
  }, backup);
  assert.equal(await settings.evaluate(async () => (await import('./archive-test.js')).listArchives().then(a => a.length)), 2);
  await settings.goto(`${fresh.base}?conversation=${archives[0].id}`);
  await settings.locator('#status').filter({ hasText: 'Read-only archive' }).waitFor();
  assert.match(await settings.locator('#transcript').textContent(), /Synthetic answer|Restored evidence 713/);
  assert.match(await settings.locator('#transcript').textContent(), /Synthetic tool evidence 721/);
  assert.equal(await settings.locator('#transcript article img').count(), 1);
  await settings.getByRole('button', { name: 'Read PDF page text' }).click();
  await settings.getByRole('status').filter({ hasText: 'Portable PDF evidence 719' }).waitFor();
  assert.equal(await settings.locator('#composer').isVisible(), false);
  const restored = settings.waitForEvent('download');
  await settings.getByRole('button', { name: 'Save source locally' }).first().click();
  assert.equal(await readFile(await (await restored).path(), 'utf8'), 'Restored evidence 713, source text.');
  assert.equal(await settings.evaluate(async () => (await navigator.locks.query()).held.filter(l => l.name.includes('owner')).length), 0);
  assert.deepEqual(network, [], 'Restoration and source reading must not fetch external resources');
  await settings.screenshot({ path: resolve(artifacts, 'restored-archive.png') });
  await browser.tracing.stop({ path: resolve(artifacts, 'backup-trace.zip') });
  console.log('Portable UI: fresh identity restore, native image, PDF/text/image bytes, duplicates and atomic rollback passed.');
} finally {
  await Promise.all(contexts.map(c => c.close().catch(() => {})));
  await rm(scratch, { recursive: true, force: true });
}
