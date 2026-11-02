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
  await panel.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await panel.waitForFunction(() => document.getElementById('status')?.textContent.includes('Ready'));
  assert.equal(await panel.locator('html').evaluate((element) => getComputedStyle(element).colorScheme), 'light');
  await panel.getByRole('button', { name: 'Summarize this page' }).evaluate((button) => button.click());
  assert.equal(await panel.locator('#prompt').inputValue(), 'Summarize this page in a few sentences.');
  await panel.screenshot({ path: resolve(artifacts, 'ready.png') });
  await panel.locator('#prompt').evaluate((input) => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true })));
  await panel.waitForFunction(() => document.getElementById('status')?.textContent.includes('Check complete'));
  assert.equal(await panel.locator('#prompt').inputValue(), '');
  assert.equal(await panel.locator('article.assistant .message-body strong').last().innerText(), 'Scripted compatibility check finished.');
  const readResult = panel.locator('article.toolResult details').first();
  assert.equal(await readResult.evaluate((details) => details.open), false);
  await readResult.locator('summary').evaluate((summary) => summary.click());
  assert.match(await readResult.innerText(), /Invoice NZ-427 totals \$183.75/);
  await panel.screenshot({ path: resolve(artifacts, 'inspected.png') });
  await fixture.locator('#draft').focus();
  await panel.locator('#prompt').evaluate((input) => { input.value = 'Type: Revised draft ✓'; });
  await panel.locator('#send').evaluate((button) => {
    button.click();
    document.getElementById('prompt').value = 'Next question drafted while the reply runs.';
  });
  await panel.waitForFunction(() => document.getElementById('status')?.textContent.includes('Check complete'));
  assert.equal(await fixture.locator('#draft').inputValue(), 'Revised draft ✓');
  assert.equal(await panel.locator('#prompt').inputValue(), 'Next question drafted while the reply runs.');
  assert.equal(await fixture.evaluate(() => window.submissions), 0);
  assert.equal(await readResult.evaluate((details) => details.open), true, 'An expanded result stays open as new messages arrive');
  await panel.screenshot({ path: resolve(artifacts, 'typed.png') });
  await panel.reload();
  await panel.waitForFunction(() => document.getElementById('status')?.textContent.includes('Ready'));
  assert.match(await panel.locator('#transcript').textContent(), /Revised draft ✓/);
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
  assert.match(await panel.locator('#transcript').textContent(), /Password and other sensitive field types are excluded/);
  async function send(prompt) {
    await panel.locator('#prompt').evaluate((input, value) => { input.value = value; }, prompt);
    await panel.locator('#send').evaluate((button) => button.click());
    await panel.waitForFunction(() => !document.getElementById('send').disabled);
  }
  const other = await browser.newPage();
  await other.goto(`http://127.0.0.1:${server.address().port}/other`);
  await other.evaluate(() => { document.title = 'Other task'; document.querySelector('p').textContent = 'Other invoice YY-880 totals $69.30.'; });
  await other.locator('#draft').fill('Other draft');
  await fixture.locator('#draft').focus();
  await other.bringToFront();
  await send('Inspect the same attached tab again');
  assert.match(await panel.locator('article.toolResult').last().textContent(), /NZ-427/);
  assert.equal(await panel.locator('#target').textContent(), 'Disposable draft');
  await send('Type: Follow-up on original tab');
  assert.equal(await fixture.locator('#draft').inputValue(), 'Follow-up on original tab');
  assert.equal(await other.locator('#draft').inputValue(), 'Other draft');
  await panel.reload();
  await panel.waitForFunction(() => document.getElementById('status')?.textContent.includes('Ready'));
  assert.equal(await panel.locator('#target').textContent(), 'Disposable draft');
  await send('After reload, inspect the attached tab');
  assert.match(await panel.locator('article.toolResult').last().textContent(), /NZ-427/);
  await panel.locator('#use-current-tab').evaluate((button) => button.click());
  await panel.waitForFunction(() => document.getElementById('target').textContent === 'Other task');
  assert.match(await panel.locator('#transcript').textContent(), /NZ-427/);
  assert.match(await panel.locator('.task-boundary').last().textContent(), /Other task/);
  await send('Inspect the explicitly attached other tab');
  assert.match(await panel.locator('article.toolResult').last().textContent(), /YY-880/);
  await panel.screenshot({ path: resolve(artifacts, 'attachment-changed.png') });
  await panel.reload();
  await panel.waitForFunction(() => document.getElementById('status')?.textContent.includes('Ready'));
  assert.match(await panel.locator('#transcript').textContent(), /NZ-427/);
  assert.match(await panel.locator('#transcript').textContent(), /YY-880/);
  // Choosing the already attached tab keeps the current sequence intact.
  const count = await panel.locator('article.user').count();
  await panel.locator('#use-current-tab').evaluate((button) => button.click());
  await panel.waitForFunction(() => !document.getElementById('use-current-tab').disabled);
  assert.equal(await panel.locator('article.user').count(), count);
  await other.close();
  await fixture.bringToFront();
  await send('Type: must not redirect');
  assert.match(await panel.locator('#status').textContent(), /attached tab is unavailable/);
  assert.equal(await fixture.locator('#draft').inputValue(), 'Follow-up on original tab');
  assert.equal(await panel.locator('article.user').count(), count);
  await panel.screenshot({ path: resolve(artifacts, 'attachment-unavailable.png') });
  await panel.locator('#new-conversation').evaluate((button) => button.click());
  await panel.waitForFunction(() => document.getElementById('status').textContent.includes('New conversation'));
  assert.equal(await panel.locator('article').count(), 0);
  assert.equal(await panel.locator('#target').textContent(), 'Disposable draft');
  await panel.screenshot({ path: resolve(artifacts, 'attachment-new.png') });
  await send('Fresh task after New conversation');
  assert.match(await panel.locator('#transcript').textContent(), /NZ-427/);
  assert.doesNotMatch(await panel.locator('#transcript').textContent(), /YY-880|Revised draft/);
  await browser.close();
  browser = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: false,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    viewport: { width: 420, height: 850 },
  });
  const reopened = await browser.newPage();
  await reopened.goto(`chrome-extension://${id}/panel.html`);
  await reopened.waitForFunction(() => document.getElementById('status')?.textContent.includes('Ready'));
  assert.match(await reopened.locator('#transcript').textContent(), /Invoice NZ-427 totals \$183.75/);
  assert.doesNotMatch(await reopened.locator('#transcript').textContent(), /YY-880|Revised draft/);
  assert.match(await reopened.locator('#target-hint').textContent(), /Unavailable/);
  await reopened.locator('#send').click();
  await reopened.waitForFunction(() => !document.getElementById('send').disabled);
  assert.match(await reopened.locator('#status').textContent(), /attached tab is unavailable/);
  console.log('PASS: existing browser controls; stable attachment for read/edit while browsing, reload, explicit change with visible history, same-target continuity, closed-target rejection, New conversation, browser-restart invalidation and persistence');
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
  await rm(profile, { recursive: true, force: true });
}
