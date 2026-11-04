import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { artifactDirectory, browserOptions } from './test/browser.mjs';

const artifacts = artifactDirectory('companion');
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(`${tmpdir()}/accanto-companion-`);
const extension = resolve(profile, 'extension');
await cp('dist', extension, { recursive: true });
const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
assert.equal(manifest.permissions.includes('sidePanel'), false, 'Accanto must not request Chrome sidebar access');
assert.equal('side_panel' in manifest, false, 'Accanto must not register a sidebar');
manifest.host_permissions.push('http://127.0.0.1/*');
await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
const invoice = await readFile('docs/examples/code-mode-invoice.html', 'utf8');
const calculation = String.raw`const page = JSON.parse(await tools.inspect_tab({})); const m = page.text.match(/(\d+) at (\d+\.\d{2}); delivery (\d+\.\d{2})/); text(Number(m[1]) * Number(m[2]) + Number(m[3]));`;
let modelOffline = false;
let dropModelStream;
const modelRequests = [];
const server = createServer((request, response) => {
  if (request.url.startsWith('/v1/')) modelRequests.push({ method: request.method, path: request.url });
  if (request.method === 'OPTIONS') { response.writeHead(403); response.end(); return; }
  if (request.url === '/v1/models') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'companion-fixture' }] })); return; }
  if (request.url === '/v1/chat/completions') {
    if (modelOffline === 'partial') {
      response.setHeader('Content-Type', 'text/event-stream');
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Checking the invoice…' }, finish_reason: null }] })}\n\n`);
      dropModelStream = () => response.destroy();
      return;
    }
    if (modelOffline) { request.socket.destroy(); return; }
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const messages = JSON.parse(body).messages;
      const done = messages.at(-1).role === 'tool';
      const delta = done ? { role: 'assistant', content: '### $90.75\n3 × $27.50 + $8.25 delivery.\n\nThe invoice adds up.' }
        : { role: 'assistant', tool_calls: [{ index: 0, id: 'companion-calculation', type: 'function', function: { name: 'codemode', arguments: JSON.stringify({ code: calculation }) } }] };
      response.setHeader('Content-Type', 'text/event-stream');
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: done ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
    });
    return;
  }
  if (request.url === '/plain') { response.setHeader('Content-Type', 'text/plain'); response.end('Plain document fixture'); return; }
  if (request.url === '/blocked') response.setHeader('Content-Security-Policy', "frame-src 'none'");
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(invoice);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const modelOrigin = `http://localhost:${server.address().port}`;
const pending = new Map();
const errors = [];
let browser;
let worker;
const fitWindow = async page => {
  // Emulated viewports can extend below the native content surface, where
  // Chromium routes OOPIF clicks to the iframe element instead of its content.
  const tab = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url), page.url());
  const viewport = page.viewportSize();
  const cdp = await browser.newCDPSession(page);
  try {
    const { windowId, bounds } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: {
      width: bounds.width + Math.max(0, viewport.width - tab.width),
      height: bounds.height + Math.max(0, viewport.height - tab.height),
    } });
  } finally { await cdp.detach(); }
};
const ready = frame => frame.waitForFunction(() => document.getElementById('status')?.textContent.includes('Ready'));
// requestAnimationFrame pauses in clipped frames, although the agent keeps
// running. Observe completion with timer polling while it is minimized.
const idle = frame => frame.waitForFunction(() => !document.getElementById('send').disabled, null, { polling: 100 });
const open = async page => {
  await page.bringToFront();
  await fitWindow(page);
  const host = page.locator('[data-accanto-companion]');
  await host.waitFor();
  const box = await host.boundingBox();
  const loaded = page.frames().find(item => item.url().includes('/companion.html')) || page.waitForEvent('framenavigated', { predicate: frame => frame.url().includes('/companion.html') });
  await page.mouse.click(box.x + 26, box.y + 26);
  const frame = await loaded;
  await frame.waitForFunction(() => document.body.dataset.embedded === 'true');
  return frame;
};
const send = async (frame, prompt) => {
  await (typeof frame.page === 'function' ? frame.page() : frame).bringToFront();
  await frame.locator('#prompt').fill(prompt);
  await frame.locator('#send').click();
};
try {
  browser = await chromium.launchPersistentContext(profile, { ...browserOptions, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`], viewport: { width: 1280, height: 840 } });
  await browser.route(/^https?:\/\/(?!(?:127\.0\.0\.1|localhost)(?=[:/]))/, route => route.abort('blockedbyclient'));
  worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker');
  const base = `chrome-extension://${new URL(worker.url()).host}`;
  // Headless Chrome cannot accept its native optional-permission prompt.
  // Change the real grant through Chrome's extension settings instead.
  const grantModelAccess = async () => {
    const permissions = await browser.newPage();
    try {
      await permissions.goto('chrome://extensions/');
      await permissions.evaluate(({ id, host }) => chrome.developerPrivate.addHostPermission(id, host), { id: new URL(base).host, host: `${modelOrigin}/*` });
    } finally { await permissions.close(); }
  };
  await grantModelAccess();
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/invoice`);
  await page.bringToFront();
  await fitWindow(page);
  await page.locator('[data-accanto-companion]').waitFor();
  assert.equal(page.frames().length, 1, 'The idle launcher must not load an agent or conversation');
  await page.screenshot({ path: resolve(artifacts, 'collapsed.png') });
  const launcherClip = { x: 1180, y: 740, width: 100, height: 100 };
  await page.screenshot({ path: resolve(artifacts, 'launcher-idle.png'), clip: launcherClip });
  await page.mouse.move(1230, 790);
  await page.waitForTimeout(180);
  await page.screenshot({ path: resolve(artifacts, 'launcher-hover.png'), clip: launcherClip });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.screenshot({ path: resolve(artifacts, 'launcher-reduced-motion.png'), clip: launcherClip });
  await page.mouse.move(0, 0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  let a = await open(page);
  await a.locator('#connect-model').waitFor();
  await page.screenshot({ path: resolve(artifacts, 'first-use.png') });
  const [, settings] = await Promise.all([
    a.locator('#connect-model').click(),
    browser.waitForEvent('page'),
  ]);
  await settings.waitForFunction(() => document.body.dataset.settings === 'true');
  assert.ok(settings.url().startsWith(`${base}/panel.html?settings=1`));
  assert.equal(await a.locator('#panel-owner').isVisible(), false, 'Settings must not take conversation ownership');
  await settings.setViewportSize({ width: 320, height: 1000 });
  for (const api of ['openai-responses', 'anthropic-messages', 'google-generative-ai', 'openai-completions']) {
    await settings.locator('#model-api').selectOption(api);
    assert.equal(await settings.locator('#model-api').evaluate(element => {
      const style = getComputedStyle(element);
      return style.backgroundImage !== 'none' && element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) >= parseFloat(style.lineHeight);
    }), true, 'Native selects must show an arrow and fit their text without clipping');
  }
  await settings.screenshot({ path: resolve(artifacts, 'settings-narrow.png') });
  await settings.setViewportSize({ width: 960, height: 1000 });
  await settings.reload();
  await settings.waitForFunction(() => document.getElementById('connection-status')?.dataset.state === 'disconnected');
  await settings.screenshot({ path: resolve(artifacts, 'settings-disconnected.png') });
  await settings.locator('#model-endpoint').fill(`${modelOrigin}/v1`);
  await settings.locator('#model-id').fill('missing-model');
  await settings.locator('#api-key').fill('companion-fixture-key');
  await settings.locator('#connect').click();
  await settings.waitForFunction(() => document.getElementById('connection-status').dataset.state === 'error');
  assert.equal(await settings.locator('#connect').textContent(), 'Retry connection');
  await settings.screenshot({ path: resolve(artifacts, 'settings-error.png') });
  await settings.locator('#model-id').fill('companion-fixture');
  assert.equal(await settings.locator('#connection-status').getAttribute('data-state'), 'draft');
  assert.equal(await settings.locator('#connect').textContent(), 'Connect');
  await settings.locator('#connect').click();
  await settings.waitForFunction(() => document.getElementById('connection-status').textContent.includes('Credential available'));
  assert.equal(await settings.locator('#connection-status').getAttribute('data-state'), 'connected');
  assert.match(await settings.locator('#connection-status').textContent(), /Connected to companion-fixture/);
  assert.equal(await settings.locator('#connect').textContent(), 'Reconnect');
  await ready(a);
  assert.equal(await worker.evaluate(origin => chrome.permissions.contains({ origins: [`${origin}/*`] }), modelOrigin), true);
  await settings.screenshot({ path: resolve(artifacts, 'settings.png') });
  await settings.locator('#model-id').fill('edited-model');
  assert.equal(await settings.locator('#connection-status').getAttribute('data-state'), 'draft');
  await settings.screenshot({ path: resolve(artifacts, 'settings-unsaved.png') });
  await settings.reload();
  await settings.waitForFunction(() => document.getElementById('connection-status')?.dataset.state === 'connected');
  await settings.locator('#research-settings > summary').click();
  await settings.locator('#search-provider').selectOption('tinyfish');
  assert.equal(await settings.locator('#tinyfish-key').inputValue(), '');
  await settings.locator('#research-settings').screenshot({ path: resolve(artifacts, 'search-settings.png') });
  await settings.locator('#search-provider').selectOption('exa');
  await settings.locator('#research-settings > summary').click();
  await settings.setViewportSize({ width: 1280, height: 840 });
  await page.bringToFront();
  await fitWindow(page);
  await page.screenshot({ path: resolve(artifacts, 'ready.png') });
  await a.locator('#context-menu').screenshot({ path: resolve(artifacts, 'context-chip.png') });
  await a.locator('#context-menu > summary').click();
  assert.equal(await a.locator('#context-menu').evaluate(element => element.open), true, 'The context chip must open its menu');
  await page.screenshot({ path: resolve(artifacts, 'context-open.png') });
  await a.locator('#context-menu > summary').click();
  assert.equal(await a.locator('#context-menu').evaluate(element => element.open), false);
  await worker.evaluate(origin => chrome.permissions.remove({ origins: [`${origin}/*`] }), modelOrigin);
  assert.equal(await worker.evaluate(origin => chrome.permissions.contains({ origins: [`${origin}/*`] }), modelOrigin), false);
  const beforeMissingAccess = modelRequests.length;
  await send(a, 'What is the invoice total?');
  await idle(a);
  await writeFile(resolve(artifacts, 'model-access.json'), JSON.stringify({
    granted: await worker.evaluate(origin => chrome.permissions.contains({ origins: [`${origin}/*`] }), modelOrigin),
    requests: modelRequests.slice(beforeMissingAccess),
    status: await a.locator('#status').textContent(),
    connection: await a.locator('#connection-status').textContent(),
  }, null, 2));
  await page.screenshot({ path: resolve(artifacts, 'model-access-missing.png') });
  assert.match(await a.locator('#status').textContent(), /Model server access is missing/);
  assert.equal(modelRequests.length, beforeMissingAccess, 'Missing model permission must be caught before any HTTP request');
  assert.equal(await a.locator('#prompt').inputValue(), 'What is the invoice total?');
  await settings.reload();
  await settings.waitForFunction(() => document.getElementById('connection-status').dataset.state === 'permission');
  await settings.screenshot({ path: resolve(artifacts, 'settings-model-access-missing.png') });
  await page.bringToFront();
  await fitWindow(page);
  let approveModelAccess = false;
  await browser.exposeBinding('chooseModelAccess', async (_source, options) => {
    assert.deepEqual(options, { origins: [`${modelOrigin}/*`] }, 'Recovery may request only the saved model host');
    if (!approveModelAccess) return false;
    await grantModelAccess();
    await page.bringToFront();
    await fitWindow(page);
    return true;
  });
  // Automate Chrome's chooser decision, then run the real permissions request.
  // The native permission dialog itself is not tested.
  await a.evaluate(() => {
    const request = chrome.permissions.request.bind(chrome.permissions);
    chrome.permissions.request = async options => await window.chooseModelAccess(options) ? request(options) : false;
  });
  await a.locator('#allow-model-access').click();
  await a.waitForFunction(() => document.getElementById('status').textContent.includes('Model access declined'));
  assert.equal(await worker.evaluate(origin => chrome.permissions.contains({ origins: [`${origin}/*`] }), modelOrigin), false);
  assert.equal(modelRequests.length, beforeMissingAccess);
  await page.screenshot({ path: resolve(artifacts, 'model-access-declined.png') });
  approveModelAccess = true;
  await a.locator('#allow-model-access').click();
  await ready(a);
  assert.equal(await worker.evaluate(origin => chrome.permissions.contains({ origins: [`${origin}/*`] }), modelOrigin), true);
  assert.equal(await a.locator('#allow-model-access').isVisible(), false);
  modelOffline = true;
  await send(a, 'What is the invoice total?');
  await idle(a);
  assert.match(await a.locator('.model-error').last().textContent(), /Could not reach your model/);
  assert.match(await a.locator('.model-error-help').last().textContent(), /API server.*browser requests/);
  assert.equal(await a.locator('#prompt').inputValue(), 'What is the invoice total?');
  assert.match(await a.locator('#status').textContent(), /draft is ready to resend/);
  await page.screenshot({ path: resolve(artifacts, 'model-offline.png') });
  await a.locator('.model-error-details > summary').last().click();
  assert.match(await a.locator('.model-error-details .message-body').last().textContent(), /Connection error/i);
  await page.screenshot({ path: resolve(artifacts, 'model-offline-details.png') });
  const [recoverySettings] = await Promise.all([
    browser.waitForEvent('page'),
    a.locator('.model-error > button').last().click(),
  ]);
  await recoverySettings.waitForFunction(() => document.body.dataset.settings === 'true');
  await recoverySettings.close();
  await page.bringToFront();
  await fitWindow(page);
  modelOffline = 'partial';
  await send(a, 'Check the invoice again.');
  await a.locator('article.assistant').last().getByText('Checking the invoice…', { exact: true }).waitFor();
  dropModelStream();
  await idle(a);
  assert.match(await a.locator('.model-error').last().textContent(), /Checking the invoice…/);
  const streamError = await a.locator('.model-error-details .message-body').last().textContent();
  assert.ok(streamError && !streamError.includes('Checking the invoice'), 'A partial reply must not hide the actual stream error');
  await a.locator('.model-error-details > summary').last().click();
  await a.locator('.model-error').last().evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
  await page.screenshot({ path: resolve(artifacts, 'model-stream-interrupted.png') });
  assert.equal(await a.locator('.model-error-details').last().evaluate(element => element.open), true);
  modelOffline = false;
  const collapsedHeight = await a.locator('#prompt').evaluate(element => element.clientHeight);
  await a.locator('#prompt').fill('Compare the quantities and delivery charge.\nExplain the total and cite each value.');
  assert.equal(await a.locator('#prompt').evaluate((element, height) => element.clientHeight > height && element.scrollHeight <= element.clientHeight + 1, collapsedHeight), true, 'A multiline draft must grow before scrolling');
  await page.screenshot({ path: resolve(artifacts, 'composer-expanded.png') });
  await a.locator('#prompt').fill('Compare the quantities and delivery charge, and explain each calculation. '.repeat(40));
  assert.equal(await a.locator('#prompt').evaluate(element => element.clientHeight <= innerHeight * .32 + 1 && element.scrollHeight > element.clientHeight), true, 'A very long draft must remain bounded with internal scrolling');
  await page.screenshot({ path: resolve(artifacts, 'composer-long.png') });
  await a.locator('#prompt').fill('');
  assert.equal(await a.locator('#prompt').evaluate(element => element.clientHeight), collapsedHeight, 'Clearing a draft must collapse the composer');
  await send(a, 'What is the invoice total?');
  await idle(a);
  assert.match(await a.locator('article.toolResult').last().textContent(), /90\.75/);
  assert.match(await a.locator('article.assistant .message-body').last().textContent(), /90\.75/);
  assert.equal(await a.locator('.turn-activity').count(), 1);
  assert.equal(await a.locator('.turn-activity').evaluate(element => element.open), false);
  await page.screenshot({ path: resolve(artifacts, 'answer.png') });
  await a.locator('.turn-activity > summary').click();
  assert.equal(await a.locator('article.activity').count(), 1, 'One action must contain its call and result together');
  await a.locator('article.toolResult summary').click();
  assert.match(await a.locator('article.toolResult .tool-input').textContent(), /tools\.inspect_tab/);
  await a.locator('article.toolResult .tool-input').evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
  const scriptBounds = await a.locator('article.toolResult .tool-input').evaluate(element => {
    const box = element.getBoundingClientRect();
    const transcript = document.getElementById('transcript').getBoundingClientRect();
    return { script: box.toJSON(), transcript: transcript.toJSON() };
  });
  // Chromium rounds scroll offsets while text layout retains fractional pixels.
  assert.ok(scriptBounds.script.height > 0 && scriptBounds.script.top >= scriptBounds.transcript.top - 1 && scriptBounds.script.bottom <= scriptBounds.transcript.bottom + 1, `Expanded scripts must scroll fully into the transcript above the composer: ${JSON.stringify(scriptBounds)}`);
  await page.screenshot({ path: resolve(artifacts, 'script.png') });
  await a.locator('article.toolResult pre').scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(artifacts, 'activity.png') });
  // A hostile page may embed the public URL but cannot initialize an agent,
  // select another tab, request history, or control the legitimate frame.
  const rogueLoaded = page.waitForEvent('framenavigated', { predicate: frame => frame !== a && frame.url().startsWith(base) });
  await page.evaluate(url => { const frame = document.createElement('iframe'); frame.id = 'rogue'; frame.src = url; document.body.append(frame); }, `${base}/companion.html?tab=9999&conversation=legacy`);
  const rogue = await rogueLoaded;
  await rogue.waitForFunction(() => document.body.textContent.includes('Open Accanto using its companion button'));
  assert.equal(await rogue.locator('#prompt').count(), 0);
  assert.match((await rogue.evaluate(() => chrome.runtime.sendMessage({ type: 'conversation', tabId: 9999 }))).error, /not an authorized/);
  assert.equal(await page.evaluate(() => { try { return document.getElementById('rogue').contentWindow.document.body.textContent; } catch (error) { return error.name; } }), 'SecurityError');
  await page.evaluate(() => { window.postMessage({ type: 'accanto-minimize' }, '*'); document.getElementById('rogue').remove(); });
  assert.equal(await a.locator('#prompt').isVisible(), true);
  // Drag and keyboard movement use the isolated host's own handle.
  let box = await page.locator('[data-accanto-companion]').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 6);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 - 130, box.y - 74, { steps: 5 }); await page.mouse.up();
  const moved = await page.locator('[data-accanto-companion]').boundingBox();
  assert.equal(moved.x, box.x - 130);
  assert.equal(moved.y, box.y - 80);
  await page.keyboard.press('ArrowLeft');
  assert.ok((await page.locator('[data-accanto-companion]').boundingBox()).x < moved.x);
  box = await page.locator('[data-accanto-companion]').boundingBox();
  await page.mouse.move(box.x + box.width - 3, box.y + box.height - 3);
  await page.mouse.down(); await page.mouse.move(box.x + box.width + 47, box.y + box.height + 37, { steps: 5 }); await page.mouse.up();
  const resized = await page.locator('[data-accanto-companion]').boundingBox();
  assert.equal(resized.x, box.x, 'Resizing must keep the left edge fixed');
  assert.equal(resized.y, box.y, 'Resizing must keep the top edge fixed');
  assert.equal(resized.width, box.width + 50);
  assert.equal(resized.height, box.height + 40);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowUp');
  const keyboardResized = await page.locator('[data-accanto-companion]').boundingBox();
  assert.deepEqual(keyboardResized, { ...resized, width: resized.width - 16, height: resized.height - 16 });
  await a.waitForFunction(({ width, height }) => innerWidth === width - 2 && innerHeight === height - 2, keyboardResized);
  await a.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: resolve(artifacts, 'resized.png') });
  await a.locator('#minimize').click();
  await page.screenshot({ path: resolve(artifacts, 'moved-collapsed.png') });
  a = await open(page);
  assert.deepEqual(await page.locator('[data-accanto-companion]').boundingBox(), keyboardResized, 'Reopening must preserve position and size');
  assert.match(await a.locator('#transcript').textContent(), /90\.75/);
  await page.setViewportSize({ width: 390, height: 640 });
  await page.screenshot({ path: resolve(artifacts, 'narrow.png') });
  assert.equal(await a.evaluate(() => document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight), false);
  box = await page.locator('[data-accanto-companion]').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 640);
  await page.setViewportSize({ width: 320, height: 640 });
  await a.locator('#history-menu > summary').click();
  assert.equal(await a.locator('#conversation-bar').evaluate(element => {
    const box = element.getBoundingClientRect();
    return box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight;
  }), true, 'History must stay inside a narrow companion');
  await page.screenshot({ path: resolve(artifacts, 'history-narrow.png') });
  await a.locator('#conversation button[aria-current=true]').press('Escape');
  await a.locator('#prompt').fill('Please compare the quantities and delivery charge. '.repeat(30));
  assert.equal(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.getElementById('send').getBoundingClientRect().bottom <= innerHeight), true, 'A narrow long draft must keep Send visible without horizontal overflow');
  await page.screenshot({ path: resolve(artifacts, 'composer-narrow.png') });
  await a.locator('#prompt').fill('');
  await page.setViewportSize({ width: 1280, height: 840 });
  await fitWindow(page);
  await worker.evaluate(() => chrome.storage.local.set({ mode: 'scripted' }));
  await ready(a);
  const other = await browser.newPage();
  await other.goto(`${origin}/second`);
  const b = await open(other); await ready(b);
  const idA = new URL(a.url()).searchParams.get('conversation');
  assert.notEqual(idA, new URL(b.url()).searchParams.get('conversation'));
  await page.bringToFront();
  await a.locator('#history-menu > summary').click();
  assert.equal(await a.locator('#conversation button').count(), 2);
  assert.equal(await a.locator('#conversation button[aria-current=true]').count(), 1);
  await page.screenshot({ path: resolve(artifacts, 'history.png') });
  const savedCatalog = await worker.evaluate(async () => (await chrome.storage.local.get('conversations')).conversations);
  await worker.evaluate(async () => {
    const { conversations } = await chrome.storage.local.get('conversations');
    for (let i = 1; i <= 24; i++) {
      const id = crypto.randomUUID();
      conversations[id] = { id, title: `Research ${i}: Compare delivery costs and cancellation policies` };
    }
    await chrome.storage.local.set({ conversations });
  });
  await a.waitForFunction(() => document.querySelectorAll('#conversation button').length === 26);
  await page.screenshot({ path: resolve(artifacts, 'history-many.png') });
  assert.ok((await a.locator('#conversation-bar').boundingBox()).height <= 288, 'A long history must stay compact instead of covering the companion');
  await page.locator('[data-accanto-companion]').screenshot({ path: resolve(artifacts, 'history-many-detail.png') });
  const footerBeforeScroll = await a.locator('#open-conversation').boundingBox();
  await a.locator('#conversation button').last().scrollIntoViewIfNeeded();
  const lastChat = await a.locator('#conversation button').last().boundingBox();
  const footerAfterScroll = await a.locator('#open-conversation').boundingBox();
  assert.ok(lastChat.y + lastChat.height <= footerAfterScroll.y, 'The last chat must scroll above the footer');
  assert.equal(footerAfterScroll.y, footerBeforeScroll.y, 'Scrolling chats must not move the footer');
  assert.equal(await a.locator('#open-conversation').evaluate(button => {
    const box = button.getBoundingClientRect();
    return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  }), true, 'No chat row may cover the footer action');
  await page.screenshot({ path: resolve(artifacts, 'history-many-scrolled.png') });
  await page.setViewportSize({ width: 320, height: 640 });
  await a.locator('#conversation button').last().scrollIntoViewIfNeeded();
  assert.equal(await a.evaluate(() => {
    const menu = document.getElementById('conversation-bar').getBoundingClientRect();
    const footer = document.getElementById('open-conversation').getBoundingClientRect();
    const last = document.querySelector('#conversation button:last-child').getBoundingClientRect();
    return menu.left >= 0 && menu.right <= innerWidth && menu.bottom <= innerHeight && last.bottom <= footer.top;
  }), true, 'A long history must scroll above its footer at 320px');
  await page.screenshot({ path: resolve(artifacts, 'history-many-narrow.png') });
  await page.setViewportSize({ width: 1280, height: 840 });
  await worker.evaluate(conversations => chrome.storage.local.set({ conversations }), savedCatalog);
  await a.waitForFunction(() => document.querySelectorAll('#conversation button').length === 2);
  await a.locator('#conversation button[aria-current=true]').press('Escape');
  assert.equal(await a.locator('#history-menu').evaluate(element => element.open), false);
  await browser.route('https://mcp.exa.ai/**', async route => {
    const query = route.request().postDataJSON().params.arguments.query;
    await new Promise(done => pending.set(query, done));
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: `Title: Evidence\nURL: ${origin}/source\nText: Public source` }] } }) }).catch(() => {});
  });
  // Submit independently of cross-tab keyboard focus. Both real agents still
  // have to reach the provider before either response is released.
  await Promise.all([[a, 'a'], [b, 'b']].map(([frame, marker]) => frame.evaluate(marker => {
    document.getElementById('prompt').value = `Code: store("marker", "ONLY-${marker.toUpperCase()}"); await tools.web_search({query:"hold-${marker}"}); text(load("marker"));`;
    document.getElementById('composer').requestSubmit();
  }, marker)));
  const deadline = Date.now() + 10000;
  while (pending.size < 2) { assert.ok(Date.now() < deadline, 'Both agents must reach the provider concurrently'); await new Promise(done => setTimeout(done, 20)); }
  await page.bringToFront();
  await a.locator('#minimize').click();
  box = await page.locator('[data-accanto-companion]').boundingBox();
  await page.mouse.click(box.x + 26, box.y + 26, { button: 'right' });
  const accessibility = await browser.newCDPSession(page);
  const { nodes } = await accessibility.send('Accessibility.getFullAXTree');
  const moveAction = nodes.find(node => node.role?.value === 'button' && node.name?.value === 'Open in a tab');
  assert.equal(moveAction?.properties.find(property => property.name === 'disabled')?.value.value, true, 'Moving a conversation must wait for its running reply');
  await accessibility.detach();
  await page.screenshot({ path: resolve(artifacts, 'companion-menu-busy.png') });
  await page.keyboard.press('Escape');
  pending.get('hold-a')();
  await idle(a);
  assert.equal(await b.locator('#stop').isEnabled(), true, 'Minimizing/completing A must leave B running');
  a = await open(page);
  assert.match(await a.locator('article.toolResult').last().textContent(), /ONLY-A/);
  pending.get('hold-b')(); await idle(b);
  assert.match(await b.locator('article.toolResult').last().textContent(), /ONLY-B/);
  assert.doesNotMatch(await b.locator('#transcript').textContent(), /ONLY-A/);
  await other.bringToFront();
  await b.locator('#sources > summary').click();
  assert.equal(await b.evaluate(() => {
    const panel = document.getElementById('sources').getBoundingClientRect();
    const button = document.querySelector('#source-list button').getBoundingClientRect();
    return button.top >= panel.top && button.bottom <= panel.bottom;
  }), true, 'The first source approval must be visible without scrolling');
  await other.screenshot({ path: resolve(artifacts, 'sources.png') });
  await b.locator('#source-list button').first().click();
  await b.waitForFunction(() => document.querySelector('#source-list button').disabled);
  await b.locator('#sources > summary').click();
  await page.bringToFront();
  await a.locator('#minimize').click();
  box = await page.locator('[data-accanto-companion]').boundingBox();
  await page.mouse.click(box.x + 26, box.y + 26, { button: 'right' });
  await page.screenshot({ path: resolve(artifacts, 'companion-menu.png') });
  const agentOpened = browser.waitForEvent('page');
  await page.keyboard.press('Enter');
  const agent = await agentOpened; await ready(agent);
  assert.ok(agent.url().startsWith(`${base}/panel.html`));
  assert.equal(new URL(agent.url()).searchParams.get('conversation'), idA);
  assert.match(await agent.locator('#transcript').textContent(), /ONLY-A/);
  assert.equal(await a.locator('#send').isDisabled(), true, 'Open in a tab must release the floating conversation');
  await page.goto(`${origin}/after-navigation`);
  await send(agent, 'Code: text(load("marker"));'); await idle(agent);
  assert.match(await agent.locator('article.toolResult').last().textContent(), /ONLY-A/);
  a = await open(page);
  await a.locator('#continue-here').click(); await ready(a);
  assert.equal(new URL(a.url()).searchParams.get('conversation'), idA);
  assert.match(await a.locator('#transcript').textContent(), /ONLY-A/);
  await a.locator('#minimize').click();
  box = await page.locator('[data-accanto-companion]').boundingBox();
  await page.mouse.click(box.x + 26, box.y + 26, { button: 'right' });
  await page.keyboard.press('ArrowDown');
  // The host menu focuses its first action; Tab reaches Hide on this site.
  await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
  await page.locator('[data-accanto-companion]').waitFor({ state: 'detached' });
  await page.reload();
  assert.equal(await page.locator('[data-accanto-companion]').count(), 0);
  // Exercise the toolbar's production route, including a previously hidden host.
  await worker.evaluate(async url => {
    const [tab] = (await chrome.tabs.query({})).filter(tab => tab.url === url);
    await openCompanion(tab);
  }, page.url());
  await page.waitForFunction(() => document.querySelector('[data-accanto-companion]')?.getBoundingClientRect().width > 300);
  a = page.frames().find(frame => frame.url().includes('/companion.html'));
  await ready(a);
  assert.match(await a.locator('#transcript').textContent(), /ONLY-A/);
  await page.screenshot({ path: resolve(artifacts, 'toolbar-companion.png') });
  await a.locator('#minimize').click();
  box = await page.locator('[data-accanto-companion]').boundingBox();
  await page.mouse.click(box.x + 26, box.y + 26, { button: 'right' });
  await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
  await page.locator('[data-accanto-companion]').waitFor({ state: 'detached' });
  await settings.locator('#restore-companions').click();
  await page.locator('[data-accanto-companion]').waitFor();
  await page.goto(`${origin}/blocked`);
  const strictCspFrame = await open(page);
  await ready(strictCspFrame);
  await page.screenshot({ path: resolve(artifacts, 'strict-csp.png') });
  const ungranted = await browser.newPage();
  await browser.route('http://ungranted.test/**', route => route.fulfill({ contentType: 'text/html', body: '<title>Ungranted website</title>' }));
  await ungranted.goto('http://ungranted.test/');
  assert.equal(await ungranted.locator('[data-accanto-companion]').count(), 0);
  const plain = await browser.newPage();
  await plain.goto(`${origin}/plain`);
  const fallbackOpened = browser.waitForEvent('page');
  const sourceId = await worker.evaluate(async url => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url === url);
    await openCompanion(tab);
    return tab.id;
  }, plain.url());
  const fallback = await fallbackOpened;
  await ready(fallback);
  assert.equal(new URL(fallback.url()).searchParams.get('tab'), String(sourceId));
  assert.equal(await fallback.locator('#target').getAttribute('title'), plain.url());
  await fallback.screenshot({ path: resolve(artifacts, 'tab-fallback.png') });
  assert.deepEqual(errors, []);
  await writeFile(resolve(artifacts, 'report.json'), JSON.stringify({ model: 'Synthetic streaming API fixture, not live model inference', firstUse: true, separateSettings: true, codeMode: 90.75, rejectedRogueFrame: true, drag: true, resize: true, narrow: true, concurrentAgents: true, minimizedRunCompleted: true, navigationAndHandoff: true, hideAndRestore: true, strictCspWorked: true, ungrantedSiteUntouched: true }, null, 2));
  console.log('PASS: real companion injection, setup, Code Mode, security, drag/resize, narrow layout, concurrent minimized agents, navigation/handoff, hide/restore, strict CSP and ungranted-site isolation.');
} catch (error) {
  if (browser) await writeFile(resolve(artifacts, 'failure.json'), JSON.stringify({ error: String(error), pending: [...pending.keys()], frames: await Promise.all(browser.pages().flatMap(page => page.frames()).map(async frame => ({ url: frame.url(), state: await frame.evaluate(() => ({ status: document.getElementById('status')?.textContent, text: document.getElementById('transcript')?.textContent, prompt: document.getElementById('prompt')?.value, busy: document.body.dataset.busy })).catch(() => null) }))) }, null, 2));
  if (browser) for (const [index, page] of browser.pages().entries()) await page.screenshot({ path: resolve(artifacts, `failure-${index}.png`) }).catch(() => {});
  throw error;
} finally {
  for (const done of pending.values()) done();
  await browser?.close();
  server.closeAllConnections(); await new Promise(done => server.close(done));
  await rm(profile, { recursive: true, force: true });
}
