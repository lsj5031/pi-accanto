import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const artifacts = resolve('../.amp/in/artifacts/pi-browser-prototype');
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(`${tmpdir()}/pi-tab-test-`);
const extension = resolve(profile, 'extension');
await cp('dist', extension, { recursive: true });
const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
// Automation cannot invoke activeTab's toolbar gesture. Grant only the disposable fixture origin in this test copy.
manifest.host_permissions = ['http://127.0.0.1/*'];
await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><title>Disposable draft</title><h1>Compatibility fixture</h1><p>Invoice NZ-427 totals $183.75.</p><textarea id="draft">Original draft</textarea><input id="secret" type="password" value="unchanged"><script>window.submissions=0;document.addEventListener("submit",()=>window.submissions++);</script>');
});
await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
let browser;
try {
  browser = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: false,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    viewport: { width: 1100, height: 850 },
  });
  const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker');
  await worker.evaluate(() => chrome.storage.local.set({ mode: 'scripted' }));
  const id = new URL(worker.url()).host;
  const fixture = await browser.newPage();
  await fixture.goto(`http://127.0.0.1:${server.address().port}`);
  await fixture.locator('#draft').focus();
  const nextPage = browser.waitForEvent('page');
  await worker.evaluate((url) => chrome.tabs.create({ url, active: false }), `chrome-extension://${id}/panel.html`);
  const panel = await nextPage;
  panel.on('pageerror', (error) => console.error('PANEL ERROR', error));
  panel.on('console', (msg) => { if (msg.type() === 'error') console.error('PANEL CONSOLE', msg.text()); });
  await panel.setViewportSize({ width: 420, height: 850 });
  await panel.waitForFunction(() => document.getElementById('status')?.textContent.includes('Ready'));
  await panel.screenshot({ path: resolve(artifacts, 'ready.png') });
  await panel.locator('#send').evaluate((button) => button.click());
  await panel.waitForFunction(() => document.getElementById('status')?.textContent.includes('Check complete'));
  assert.match(await panel.locator('#transcript').innerText(), /Invoice NZ-427 totals \$183.75/);
  await panel.screenshot({ path: resolve(artifacts, 'inspected.png') });
  await fixture.locator('#draft').focus();
  await panel.locator('#prompt').evaluate((input) => { input.value = 'Type: Revised draft ✓'; });
  await panel.locator('#send').evaluate((button) => button.click());
  await panel.waitForFunction(() => document.getElementById('status')?.textContent.includes('Check complete'));
  assert.equal(await fixture.locator('#draft').inputValue(), 'Revised draft ✓');
  assert.equal(await fixture.evaluate(() => window.submissions), 0);
  await panel.screenshot({ path: resolve(artifacts, 'typed.png') });
  await panel.reload();
  await panel.waitForFunction(() => document.getElementById('status')?.textContent.includes('Ready'));
  assert.match(await panel.locator('#transcript').innerText(), /Revised draft ✓/);
  await panel.screenshot({ path: resolve(artifacts, 'restored.png') });
  const duplicate = await browser.newPage();
  await duplicate.goto(`chrome-extension://${id}/panel.html`);
  await duplicate.waitForFunction(() => document.getElementById('status')?.textContent.includes('Another Pi Accanto panel'));
  assert.equal(await duplicate.locator('#send').isDisabled(), true);
  await duplicate.close();
  await fixture.bringToFront();
  await fixture.locator('#secret').focus();
  await panel.locator('#prompt').evaluate((input) => { input.value = 'Type: must not replace password'; });
  await panel.locator('#send').evaluate((button) => button.click());
  await panel.waitForFunction(() => document.getElementById('status')?.textContent.includes('Check complete'));
  assert.equal(await fixture.locator('#secret').inputValue(), 'unchanged');
  assert.match(await panel.locator('#transcript').innerText(), /Password and other sensitive field types are excluded/);
  await browser.close();
  browser = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: false,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    viewport: { width: 420, height: 850 },
  });
  const reopened = await browser.newPage();
  await reopened.goto(`chrome-extension://${id}/panel.html`);
  await reopened.waitForFunction(() => document.getElementById('status')?.textContent.includes('Ready'));
  assert.match(await reopened.locator('#transcript').innerText(), /Revised draft ✓/);
  assert.match(await reopened.locator('#transcript').innerText(), /Invoice NZ-427 totals \$183.75/);
  console.log('PASS: MV3 startup, CSP, IndexedDB, Pi tool loop, inspection, typing without submit, password rejection, exclusive ownership, reload and browser-restart persistence');
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
  await rm(profile, { recursive: true, force: true });
}
