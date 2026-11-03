import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { browserOptions, artifactDirectory } from './test/browser.mjs';

const artifacts = artifactDirectory('browser');
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(`${tmpdir()}/pi-tab-test-`);
const extension = resolve(profile, 'extension');
await cp('dist', extension, { recursive: true });
const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
// Automation cannot invoke activeTab's toolbar gesture. Grant only the disposable fixture origin in this test copy.
manifest.host_permissions = ['http://127.0.0.1/*'];
await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
const modelRequests = [];
const server = createServer((req, res) => {
  if (req.url === '/custom/v1/models') {
    modelRequests.push({ path: req.url, authorization: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'fixture-model-719' }] }));
    return;
  }
  if (req.url === '/custom/v1/chat/completions') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      modelRequests.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(body) });
      res.setHeader('Content-Type', 'text/event-stream');
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Configured model fixture response 719.' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
    return;
  }
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><title>Disposable draft</title><h1>Compatibility fixture</h1><p>Invoice NZ-427 totals $183.75.</p><textarea id="draft">Original draft</textarea><input id="secret" type="password" value="unchanged"><script>window.submissions=0;document.addEventListener("submit",()=>window.submissions++);</script>');
});
await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
let browser;
try {
  browser = await chromium.launchPersistentContext(profile, {
    ...browserOptions,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    viewport: { width: 1100, height: 850 },
  });
  const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const fixture = await browser.newPage();
  await fixture.goto(`http://127.0.0.1:${server.address().port}`);
  await fixture.locator('#draft').focus();
  const nextPage = browser.waitForEvent('page');
  await worker.evaluate((url) => chrome.tabs.create({ url, active: false }), `chrome-extension://${id}/panel.html`);
  const panel = await nextPage;
  panel.on('pageerror', (error) => console.error('PANEL ERROR', error));
  panel.on('console', (msg) => { if (msg.type() === 'error') console.error('PANEL CONSOLE', msg.text()); });
  await panel.waitForFunction(() => document.getElementById('status')?.textContent.includes('Connect your model'));
  assert.equal(await panel.locator('#model-endpoint').inputValue(), '');
  assert.equal(await panel.locator('#model-id').inputValue(), '');
  assert.equal(await panel.locator('#send').isDisabled(), true);
  await worker.evaluate(() => chrome.storage.session.set({ apiKey: 'unscoped-fixture-key' }));
  await panel.reload();
  await panel.waitForFunction(() => document.getElementById('status')?.textContent.includes('Connect your model'));
  assert.equal(await panel.locator('#send').isDisabled(), true, 'Unscoped legacy credentials cannot select a server');
  await panel.setViewportSize({ width: 320, height: 640 });
  await panel.screenshot({ path: resolve(artifacts, 'fresh-install.png') });
  assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth), 320);
  await worker.evaluate(async () => { await chrome.storage.session.remove('apiKey'); await chrome.storage.local.set({ mode: 'scripted' }); });
  await panel.reload();
  await panel.setViewportSize({ width: 420, height: 850 });
  await panel.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await panel.waitForFunction(() => document.getElementById('status')?.textContent.includes('Ready'));
  assert.equal(await panel.locator('html').evaluate((element) => getComputedStyle(element).colorScheme), 'light');
  assert.equal(await panel.locator('#prompt').evaluate(element => getComputedStyle(element).fontSize), '16px', 'Chrome extension defaults must not shrink composer text');
  assert.equal(await panel.locator('#tab-switch').isVisible(), false, 'Starting a chat needs no tab-switch decision');
  await panel.getByRole('button', { name: 'Summarize this page' }).evaluate((button) => button.click());
  assert.equal(await panel.locator('#prompt').inputValue(), 'Summarize this page in a few sentences.');
  await panel.screenshot({ path: resolve(artifacts, 'ready.png') });
  await panel.locator('#prompt').evaluate((input) => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true })));
  await panel.waitForFunction(() => document.getElementById('status')?.textContent.includes('Check complete'));
  assert.equal(await panel.locator('#prompt').inputValue(), '');
  assert.equal(await panel.locator('article.assistant .message-body strong').last().innerText(), 'Scripted compatibility check finished.');
  assert.equal(await panel.locator('article.assistant .message-body').last().evaluate(element => getComputedStyle(element).fontSize), '16px');
  await browser.grantPermissions(['clipboard-read', 'clipboard-write']);
  await panel.bringToFront();
  await panel.getByRole('button', { name: 'Copy response', exact: true }).last().click();
  await panel.getByRole('button', { name: 'Response copied', exact: true }).waitFor();
  await panel.waitForFunction(async (expected) => await navigator.clipboard.readText() === expected,
    '**Scripted compatibility check finished.** See the browser result above. No language model was called.');
  await fixture.bringToFront();
  await panel.waitForFunction(() => document.getElementById('tab-switch').hidden);
  await panel.screenshot({ path: resolve(artifacts, 'ux-copy.png') });
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
  await duplicate.goto(panel.url());
  await duplicate.waitForFunction(() => document.getElementById('panel-owner')?.hidden === false);
  assert.equal(await duplicate.locator('#send').isDisabled(), true);
  await duplicate.setViewportSize({ width: 320, height: 640 });
  await duplicate.screenshot({ path: resolve(artifacts, 'panel-continue.png') });
  await duplicate.locator('#continue-here').click();
  await duplicate.waitForFunction(() => document.getElementById('status')?.textContent.includes('Ready'));
  assert.match(await duplicate.locator('#transcript').textContent(), /Revised draft ✓/);
  assert.equal(await panel.locator('#send').isDisabled(), true);
  await fixture.bringToFront();
  await duplicate.locator('#prompt').evaluate((input) => { input.value = 'Inspect after continuing in this panel'; });
  await duplicate.locator('#send').evaluate((button) => button.click());
  await duplicate.waitForFunction(() => document.getElementById('status')?.textContent.includes('Check complete'));
  assert.match(await duplicate.locator('article.toolResult').last().textContent(), /NZ-427/);
  await panel.locator('#continue-here').evaluate((button) => button.click());
  await panel.waitForFunction(() => document.getElementById('status')?.textContent.includes('Ready'));
  assert.match(await panel.locator('#transcript').textContent(), /Inspect after continuing in this panel/);
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
  await panel.waitForFunction(() => !document.getElementById('tab-switch').hidden);
  assert.match(await panel.locator('#current-tab-label').textContent(), /Other task/);
  assert.equal(await panel.locator('#target').textContent(), 'Disposable draft');
  await panel.screenshot({ path: resolve(artifacts, 'ux-different-tab.png') });
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
  // There is no redundant switch action on the already attached tab.
  const count = await panel.locator('article.user').count();
  await other.bringToFront();
  await panel.waitForFunction(() => document.getElementById('tab-switch').hidden);
  assert.equal(await panel.locator('article.user').count(), count);
  await other.close();
  await fixture.bringToFront();
  await send('Type: must not redirect');
  assert.match(await panel.locator('#status').textContent(), /attached tab is unavailable/);
  assert.equal(await fixture.locator('#draft').inputValue(), 'Follow-up on original tab');
  assert.equal(await panel.locator('article.user').count(), count);
  await panel.screenshot({ path: resolve(artifacts, 'attachment-unavailable.png') });
  const internal = await browser.newPage();
  await internal.goto('chrome://version');
  await internal.bringToFront();
  await panel.locator('#new-conversation').evaluate((button) => button.click());
  await panel.waitForFunction(() => document.getElementById('status').textContent.includes('New conversation'));
  assert.equal(await panel.locator('article').count(), 0);
  assert.equal(await panel.locator('#tab-switch').isVisible(), false);
  await panel.reload();
  await panel.waitForFunction(() => document.getElementById('status')?.textContent.includes('Ready'));
  assert.equal(await panel.locator('article').count(), 0, 'A detached new chat survives reload without restoring the old task');
  await internal.close();
  await fixture.bringToFront();
  await panel.waitForFunction(() => document.getElementById('target').textContent === 'Disposable draft');
  await panel.screenshot({ path: resolve(artifacts, 'attachment-new.png') });
  await send('Fresh task after New conversation');
  assert.match(await panel.locator('#transcript').textContent(), /NZ-427/);
  assert.doesNotMatch(await panel.locator('#transcript').textContent(), /YY-880|Revised draft/);
  const conversationUrl = panel.url();
  await browser.close();
  browser = await chromium.launchPersistentContext(profile, {
    ...browserOptions,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    viewport: { width: 420, height: 850 },
  });
  const reopened = await browser.newPage();
  await reopened.goto(conversationUrl);
  await reopened.waitForFunction(() => document.getElementById('status')?.textContent.includes('Ready'));
  assert.match(await reopened.locator('#transcript').textContent(), /Invoice NZ-427 totals \$183.75/);
  assert.doesNotMatch(await reopened.locator('#transcript').textContent(), /YY-880|Revised draft/);
  assert.match(await reopened.locator('#target-hint').textContent(), /Unavailable/);
  await reopened.locator('#send').click();
  await reopened.waitForFunction(() => !document.getElementById('send').disabled);
  assert.match(await reopened.locator('#status').textContent(), /attached tab is unavailable/);
  // Configure a non-default base path/model through the public settings UI.
  const modelEndpoint = `http://127.0.0.1:${server.address().port}/custom/v1`;
  await reopened.locator('#connection > summary').click();
  await reopened.locator('#mode').selectOption('live');
  await reopened.locator('#model-endpoint').fill(`${modelEndpoint}///`);
  await reopened.locator('#model-id').fill('missing-model');
  await reopened.locator('#api-key').fill('fixture-key-719');
  await reopened.locator('#connect').click();
  await reopened.waitForFunction(() => document.getElementById('connection-status').textContent.includes('does not list model missing-model'));
  assert.equal(await reopened.evaluate(async () => (await chrome.storage.local.get('modelConnection')).modelConnection), undefined);
  await reopened.locator('#model-id').fill('fixture-model-719');
  await reopened.locator('#connect').click();
  await reopened.waitForFunction(() => document.getElementById('provider-notice').textContent === 'fixture-model-719');
  assert.deepEqual(await reopened.evaluate(async () => (await chrome.storage.local.get('modelConnection')).modelConnection), { endpoint: modelEndpoint, modelId: 'fixture-model-719' });
  assert.doesNotMatch(JSON.stringify(await reopened.evaluate(() => chrome.storage.local.get(null))), /fixture-key-719/);
  assert.equal(await reopened.locator('#api-key').inputValue(), '');
  await reopened.reload();
  await reopened.waitForFunction(() => document.getElementById('status').textContent.includes('Ready'));
  await reopened.locator('#connection > summary').click();
  assert.equal(await reopened.locator('#model-endpoint').inputValue(), modelEndpoint);
  assert.equal(await reopened.locator('#model-id').inputValue(), 'fixture-model-719');
  const beforeEndpointChange = modelRequests.length;
  await reopened.locator('#model-endpoint').fill(`${modelEndpoint}/other-server`);
  await reopened.locator('#connect').click();
  await reopened.waitForFunction(() => document.getElementById('connection-status').textContent.includes('Saved keys are not reused'));
  assert.equal(modelRequests.length, beforeEndpointChange, 'Do not send the saved key to another endpoint');
  await reopened.locator('#model-endpoint').fill(`http://user:password@127.0.0.1:${server.address().port}/v1`);
  await reopened.locator('#connect').click();
  await reopened.waitForFunction(() => document.getElementById('connection-status').textContent.includes('without credentials'));
  assert.equal(modelRequests.length, beforeEndpointChange);
  await reopened.locator('#model-endpoint').fill(modelEndpoint);
  await reopened.locator('#connection > summary').click();
  const fresh = await browser.newPage();
  await fresh.goto(`http://127.0.0.1:${server.address().port}`);
  await reopened.locator('#new-conversation').evaluate(button => button.click());
  await reopened.waitForFunction(() => !document.getElementById('send').disabled);
  await reopened.locator('#prompt').fill('Reply with the configured model fixture response.');
  await reopened.locator('#send').evaluate(button => button.click());
  await reopened.waitForFunction(() => !document.getElementById('send').disabled);
  assert.match(await reopened.locator('article.assistant').last().textContent(), /Configured model fixture response 719/);
  assert.equal(modelRequests.at(-1).body.model, 'fixture-model-719');
  assert.equal(modelRequests.at(-1).authorization, 'Bearer fixture-key-719');
  await reopened.reload();
  await reopened.waitForFunction(() => document.getElementById('status').textContent.includes('Ready'));
  await reopened.setViewportSize({ width: 320, height: 640 });
  await reopened.locator('#connection').evaluate(element => { element.open = true; });
  const connectBounds = await reopened.locator('#connect').boundingBox();
  const settingsBounds = await reopened.locator('#settings').boundingBox();
  assert.ok(connectBounds.y + connectBounds.height < settingsBounds.y + settingsBounds.height, 'Connect is fully visible without scrolling in the narrow settings view');
  await reopened.screenshot({ path: resolve(artifacts, 'settings-model-narrow.png') });
  await reopened.locator('#all-sites').scrollIntoViewIfNeeded();
  await reopened.screenshot({ path: resolve(artifacts, 'settings-access-narrow.png') });
  assert.equal(await reopened.evaluate(() => document.documentElement.scrollWidth), 320);
  assert.equal(await reopened.evaluate(() => document.documentElement.scrollHeight), 640);
  await browser.close();
  browser = await chromium.launchPersistentContext(profile, {
    ...browserOptions,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    viewport: { width: 420, height: 850 },
  });
  const settingsRestored = await browser.newPage();
  await settingsRestored.goto(conversationUrl);
  await settingsRestored.waitForFunction(() => document.getElementById('status').textContent.includes('Connect your model'));
  assert.equal(await settingsRestored.locator('#model-endpoint').inputValue(), modelEndpoint);
  assert.equal(await settingsRestored.locator('#model-id').inputValue(), 'fixture-model-719');
  assert.equal(await settingsRestored.locator('#send').isDisabled(), true, 'Endpoint/model persist after restart; the session key does not');
  console.log('PASS: browser controls, clipboard, tab/context boundaries, history, configurable endpoint/model request routing, credential isolation, settings persistence and session-key expiry');
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
  await rm(profile, { recursive: true, force: true });
}
