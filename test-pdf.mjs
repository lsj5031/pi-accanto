import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { pdf, reportPdf } from './test/pdf-fixtures.mjs';
import { browserOptions, artifactDirectory } from './test/browser.mjs';

const artifacts = artifactDirectory('pdf');
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(`${tmpdir()}/pi-pdf-test-`);
const extension = resolve(profile, 'extension');
await cp('dist', extension, { recursive: true });
const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
// This suite tests reading and UI. test:native separately proves real activeTab permission.
manifest.host_permissions.push('http://127.0.0.1/*');
await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
await build({ entryPoints: ['pdf-reader.js'], bundle: true, format: 'esm', platform: 'browser', outfile: resolve(extension, 'reader-test.js') });
const documents = {
  '/report': reportPdf,
  '/scan.pdf': pdf([null]),
  '/empty.pdf': pdf([[]]),
  '/many.pdf': pdf(Array.from({ length: 11 }, (_, i) => [`Physical page ${i + 1}: code ${100 + i * 17}.`])),
  '/dense.pdf': pdf([Array.from({ length: 400 }, (_, i) => `Line ${i}: ${'abcdefghij '.repeat(8)}`), ['Later page survives.']], 1),
  '/broken.pdf': Buffer.from('%PDF-1.7\nbroken'),
};
let responseMode;
const server = createServer((req, res) => {
  if (req.headers['sec-fetch-dest'] === 'empty' && responseMode) {
    if (responseMode === 'denied') { res.writeHead(403); res.end('denied'); return; }
    if (responseMode === 'login') { res.end('<html>Sign in</html>'); return; }
    if (responseMode === 'redirect') { res.writeHead(302, { Location: '/never-fetch' }); res.end(); return; }
    if (responseMode === 'large') { res.writeHead(200, { 'Content-Length': 33554433 }); res.flushHeaders(); return; }
    if (responseMode === 'slow') { setTimeout(() => { res.setHeader('Content-Type', 'application/pdf'); res.end(reportPdf); }, 1500); return; }
  }
  if (documents[req.url]) { res.setHeader('Content-Type', 'application/pdf'); res.end(documents[req.url]); }
  else { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Other HTML tab</title><p>Unrelated invoice $999.01</p><textarea>Draft</textarea><embed type="application/pdf" src="/report">'); }
});
await new Promise((ready, reject) => { server.once('error', reject); server.listen(39000 + Math.floor(Math.random() * 1000), '127.0.0.1', ready); });
let browser;
try {
  browser = await chromium.launchPersistentContext(profile, {
    ...browserOptions,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    viewport: { width: 420, height: 850 },
  });
  let worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker');
  await worker.evaluate(() => chrome.storage.local.set({ mode: 'scripted' }));
  const id = new URL(worker.url()).host;
  const base = `http://127.0.0.1:${server.address().port}`;
  const fixture = await browser.newPage();
  await fixture.goto(`${base}/report`);
  const next = browser.waitForEvent('page');
  await worker.evaluate(url => chrome.tabs.create({ url, active: false }), `chrome-extension://${id}/panel.html`);
  let panel = await next;
  await panel.waitForFunction(() => document.getElementById('status').textContent.includes('Ready'));
  const conversationUrl = panel.url();
  const errors = [];
  panel.on('pageerror', error => errors.push(error.message));
  async function send(prompt = 'Inspect this PDF') {
    await panel.locator('#prompt').evaluate((input, value) => { input.value = value; }, prompt);
    await panel.locator('#send').evaluate(button => button.click());
    await panel.waitForFunction(() => !document.getElementById('send').disabled);
    console.log('PDF check:', prompt, await panel.locator('#status').textContent());
  }
  async function attach() {
    await fixture.bringToFront();
    await fixture.waitForLoadState('networkidle');
    await panel.waitForFunction(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.status === 'complete');
    await panel.locator('#new-conversation').evaluate(button => button.click());
    await panel.waitForFunction(() => !document.getElementById('new-conversation').disabled);
    assert.match(await panel.locator('#status').textContent(), /Chat reset/);
  }
  const result = () => panel.locator('article.toolResult').last().textContent();
  await fixture.bringToFront();
  await fixture.waitForLoadState('networkidle');
  await panel.waitForFunction(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.status === 'complete');
  await send();
  const parsed = JSON.parse(await panel.locator('article.toolResult pre').last().textContent());
  assert.equal(parsed.totalPages, 3);
  assert.deepEqual(parsed.pages.map(page => page.page), [1, 2, 3]);
  assert.match(parsed.pages[0].text, /7 crates at \$13\.40/);
  assert.match(parsed.pages[1].text, /3 crates at \$21\.15/);
  assert.match(parsed.pages[2].text, /KOWHAI-92/);
  assert.equal(parsed.truncated, false);
  await panel.locator('article.toolResult summary').last().evaluate(summary => summary.click());
  await panel.screenshot({ path: resolve(artifacts, 'pdf-text-result.png') });
  const other = await browser.newPage();
  await other.goto(`${base}/other`);
  await send('Follow-up: inspect the attached PDF');
  assert.match(await result(), /KOWHAI-92/);
  assert.doesNotMatch(await result(), /999\.01/);
  await panel.reload();
  await panel.waitForFunction(() => document.getElementById('status').textContent.includes('Ready'));
  await send('Read the PDF after reload');
  assert.match(await result(), /H-731/);
  await send('Type: cannot edit this PDF');
  assert.match(await result(), /PDFs are read-only/);

  // Exercise the exported reader's bounds and explicit page selection in the real extension origin.
  async function read(path, start = 1) {
    return panel.evaluate(async ({ url, start }) => {
      try { return await (await import('./reader-test.js')).readPdf(url, start); }
      catch (error) { return { error: error.message }; }
    }, { url: `${base}${path}`, start });
  }
  const many = await read('/many.pdf');
  assert.equal(many.pages.length, 8);
  assert.equal(many.nextPage, 9);
  assert.equal(many.truncated, true);
  const later = await read('/many.pdf', 9);
  assert.deepEqual(later.pages.map(page => page.page), [9, 10, 11]);
  assert.match(later.pages[0].text, /code 236/);
  assert.equal(later.truncated, false);
  assert.match((await read('/many.pdf', 12)).error, /11 pages/);
  const dense = await read('/dense.pdf');
  assert.ok(dense.pages.reduce((n, page) => n + page.text.length, 0) <= 16000);
  assert.equal(dense.pages[0].truncated, true);
  assert.equal(dense.nextPage, 2);
  assert.match((await read('/dense.pdf', 2)).pages[0].text, /Later page survives/);
  assert.match((await read('/broken.pdf')).error, /could not be parsed/);
  for (const path of ['/scan.pdf', '/empty.pdf']) {
    await fixture.goto(`${base}${path}`);
    await attach();
    await send();
    assert.match(await result(), /No extractable text/);
    assert.match(await result(), /OCR and vision are not available/);
  }
  await panel.locator('article.toolResult summary').last().evaluate(summary => summary.click());
  await panel.screenshot({ path: resolve(artifacts, 'pdf-no-text.png') });
  await fixture.goto(`${base}/report`);
  await attach();
  for (const [mode, expected] of [['denied', /HTTP 403/], ['login', /did not return PDF data/], ['redirect', /Could not fetch/], ['large', /32 MiB/]]) {
    responseMode = mode;
    await send();
    assert.match(await result(), expected);
  }
  await panel.locator('article.toolResult summary').last().evaluate(summary => summary.click());
  await panel.screenshot({ path: resolve(artifacts, 'pdf-fetch-error.png') });
  responseMode = 'slow';
  await panel.locator('#prompt').fill('Read a PDF while fetching');
  await panel.locator('#send').evaluate(button => button.click());
  await panel.waitForFunction(() => document.getElementById('status').textContent.includes('Reading PDF'));
  await panel.screenshot({ path: resolve(artifacts, 'pdf-loading.png') });
  await panel.locator('#stop').evaluate(button => button.click());
  await panel.waitForFunction(() => !document.getElementById('send').disabled);
  responseMode = undefined;
  await send('Recover after Stop');
  assert.match(await result(), /KOWHAI-92/);
  // Navigation during extraction discards the old PDF result, including same-origin navigation.
  responseMode = 'slow';
  await panel.locator('#prompt').fill('Read while navigating');
  await panel.locator('#send').evaluate(button => button.click());
  await panel.waitForFunction(() => document.getElementById('status').textContent.includes('Reading PDF'));
  await fixture.goto(`${base}/empty.pdf`);
  await panel.waitForFunction(() => !document.getElementById('send').disabled);
  assert.match(await result(), /changed while reading/);
  responseMode = undefined;
  const localPath = resolve(profile, 'local report.pdf');
  await writeFile(localPath, reportPdf);
  await fixture.goto(pathToFileURL(localPath).href);
  assert.equal(await worker.evaluate(() => chrome.extension.isAllowedFileSchemeAccess()), true);
  await attach();
  await send();
  assert.match(await result(), /KOWHAI-92/);
  await panel.locator('article.toolResult summary').last().evaluate(summary => summary.click());
  await panel.screenshot({ path: resolve(artifacts, 'pdf-local-file.png') });
  const otherLocal = resolve(profile, 'different.pdf');
  await writeFile(otherLocal, pdf([['Must not leak across local files.']]));
  await fixture.goto(pathToFileURL(otherLocal).href);
  await fixture.waitForLoadState('networkidle');
  await send();
  assert.match(await panel.locator('#status').textContent(), /another site or local file/);
  const manager = await browser.newPage();
  await manager.goto(`chrome://extensions/?id=${id}`);
  // Unpacked extensions must stay in Developer mode when Chrome reloads them.
  const developerMode = manager.locator('extensions-toolbar #devMode');
  if (!await developerMode.evaluate(toggle => toggle.checked)) await developerMode.click();
  const fileToggle = manager.locator('#allow-on-file-urls cr-toggle');
  await fileToggle.click();
  // Chrome reloads the extension after changing this setting; reopen its UI.
  if (panel.isClosed()) panel = await browser.newPage();
  await panel.goto(conversationUrl);
  await panel.waitForFunction(() => document.getElementById('status').textContent.includes('Ready'));
  assert.equal(await panel.evaluate(() => chrome.extension.isAllowedFileSchemeAccess()), false);
  await fixture.bringToFront();
  await panel.locator('#use-current-tab').evaluate(button => button.click());
  await panel.waitForFunction(() => !document.getElementById('use-current-tab').disabled);
  assert.match(await panel.locator('#status').textContent(), /Allow access to file URLs/);
  await panel.screenshot({ path: resolve(artifacts, 'pdf-file-access-required.png') });
  await fileToggle.click();
  if (panel.isClosed()) panel = await browser.newPage();
  await panel.goto(conversationUrl);
  await panel.waitForFunction(() => document.getElementById('status').textContent.includes('Ready'));
  assert.equal(await panel.evaluate(() => chrome.extension.isAllowedFileSchemeAccess()), true);
  await manager.close();
  await fixture.goto(`${base}/wrapper`);
  await attach();
  await send();
  assert.match(await result(), /Embedded PDF viewer text is not included/);
  assert.match(await result(), /Unrelated invoice/);
  await fixture.goto('chrome://version');
  await fixture.bringToFront();
  await panel.locator('#use-current-tab').evaluate(button => button.click());
  await panel.waitForFunction(() => !document.getElementById('use-current-tab').disabled);
  assert.match(await panel.locator('#status').textContent(), /unsupported|toolbar action/);
  assert.deepEqual(errors, []);
  await writeFile(resolve(artifacts, 'pdf-report.json'), JSON.stringify({ chrome: browser.browser().version(), multipage: parsed, limits: { pageCount: many.pages.length, nextPage: many.nextPage, denseCharacters: dense.pages[0].text.length }, passed: ['extensionless PDF', 'page order', 'local file', 'local file navigation guard', 'stable attachment and reload', 'read-only PDFs', 'page and character limits', 'later pages', 'raster-only and empty', '403', 'login HTML', 'redirect rejection', 'size cap', 'Stop and recovery', 'navigation during fetch', 'embedded viewer notice', 'unsupported URL'] }, null, 2));
  console.log('PASS: Chromium PDF extraction, page selection/bounds, local files, attachment guards, no-text honesty, fetch errors, Stop/recovery and HTML controls.');
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(done => server.close(done));
  await rm(profile, { recursive: true, force: true });
}
