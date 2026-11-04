import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { browserOptions, artifactDirectory } from './test/browser.mjs';

const artifacts = artifactDirectory('conversations');
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(`${tmpdir()}/accanto-conversations-`);
const extension = resolve(profile, 'extension');
await cp('dist', extension, { recursive: true });
const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions.push('http://127.0.0.1/*');
await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(req.url === '/a'
    ? '<title>Invoice A</title><h1>Invoice ALPHA: 3 at 27.50; delivery 8.25.</h1>'
    : req.url === '/b' ? '<title>Invoice B</title><h1>Invoice BETA: 4 at 19.60; delivery 6.15.</h1>'
      : '<title>Public source</title><p>Shared evidence reference 713.</p>');
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const pending = new Map();
const errors = [];
let browser;
const ready = panel => panel.waitForFunction(() => document.getElementById('status').textContent.includes('Ready'));
const idle = panel => panel.waitForFunction(() => !document.getElementById('send').disabled);
async function start(panel, prompt) {
  await panel.locator('#prompt').fill(prompt);
  await panel.locator('#send').evaluate(button => button.click());
}
async function send(panel, prompt) {
  await start(panel, prompt);
  await idle(panel);
  return panel.locator('article.toolResult').last().textContent();
}
try {
  browser = await chromium.launchPersistentContext(profile, {
    ...browserOptions,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    viewport: { width: 380, height: 850 },
  });
  const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker');
  await worker.evaluate(() => chrome.storage.local.set({ mode: 'scripted' }));
  await browser.route('https://mcp.exa.ai/**', async route => {
    const query = route.request().postDataJSON().params.arguments.query;
    if (query.startsWith('hold-')) await new Promise(done => pending.set(query, done));
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: `Title: Shared source\nURL: ${origin}/${query === 'source evidence' ? 'fresh-source' : 'source'}\nText: Public evidence excerpt.` }] } }) }).catch(() => {});
  });
  const fixtureA = await browser.newPage();
  const fixtureB = await browser.newPage();
  await Promise.all([fixtureA.goto(`${origin}/a`), fixtureB.goto(`${origin}/b`)]);
  const tabs = await worker.evaluate(() => chrome.tabs.query({}));
  const tabA = tabs.find(tab => tab.url === `${origin}/a`).id;
  const tabB = tabs.find(tab => tab.url === `${origin}/b`).id;
  const base = `chrome-extension://${new URL(worker.url()).host}/panel.html`;
  const a = await browser.newPage();
  const b = await browser.newPage();
  for (const panel of [a, b]) panel.on('pageerror', error => errors.push(error.message));
  await Promise.all([a.goto(`${base}?tab=${tabA}`), b.goto(`${base}?tab=${tabB}`)]);
  await Promise.all([ready(a), ready(b)]);
  const idA = new URL(a.url()).searchParams.get('conversation');
  const idB = new URL(b.url()).searchParams.get('conversation');
  assert.notEqual(idA, idB);
  const [readA, readB] = await Promise.all([send(a, 'Inspect invoice ALPHA'), send(b, 'Inspect invoice BETA')]);
  assert.match(readA, /ALPHA/); assert.doesNotMatch(readA, /BETA/);
  assert.match(readB, /BETA/); assert.doesNotMatch(readB, /ALPHA/);
  await Promise.all([send(a, 'Code: store("marker", "ONLY-A"); text("stored A");'), send(b, 'Code: store("marker", "ONLY-B"); text("stored B");')]);
  // Wait on observable in-flight requests; both workers must reach the provider
  // before either is released, which a globally locked implementation cannot do.
  const waitPending = async (...keys) => {
    const deadline = Date.now() + 10000;
    while (!keys.every(key => pending.has(key))) {
      assert.ok(Date.now() < deadline, `Both agents must run concurrently: ${keys}`);
      await new Promise(done => setTimeout(done, 20));
    }
  };
  await Promise.all([
    start(a, 'Code: await tools.web_search({query:"hold-a-stop"}); text(load("marker"));'),
    start(b, 'Code: await tools.web_search({query:"hold-b-stop"}); text(load("marker"));'),
  ]);
  await waitPending('hold-a-stop', 'hold-b-stop');
  assert.equal(await a.locator('#stop').isEnabled(), true);
  assert.equal(await b.locator('#stop').isEnabled(), true);
  await Promise.all([a.screenshot({ path: resolve(artifacts, 'agent-a-running.png') }), b.screenshot({ path: resolve(artifacts, 'agent-b-running.png') })]);
  await a.locator('#stop').evaluate(button => button.click());
  await idle(a);
  assert.equal(await b.locator('#send').isDisabled(), true, 'Stopping A must leave B running');
  pending.get('hold-a-stop')(); pending.get('hold-b-stop')();
  await idle(b);
  assert.match(await b.locator('article.toolResult').last().textContent(), /ONLY-B/);
  assert.match(await send(a, 'Code: text(load("marker"));'), /ONLY-A/);
  await Promise.all([
    start(a, 'Code: await tools.web_search({query:"hold-a-handoff"}); text(load("marker"));'),
    start(b, 'Code: await tools.web_search({query:"hold-b-handoff"}); text(load("marker"));'),
  ]);
  await waitPending('hold-a-handoff', 'hold-b-handoff');
  const duplicate = await browser.newPage();
  await duplicate.goto(a.url());
  await duplicate.locator('#panel-owner').waitFor();
  await duplicate.locator('#continue-here').click();
  await ready(duplicate);
  assert.equal(await a.locator('#send').isDisabled(), true);
  assert.equal(await b.locator('#send').isDisabled(), true, 'Handoff of A must not stop B');
  pending.get('hold-a-handoff')(); pending.get('hold-b-handoff')();
  await idle(b);
  assert.match(await b.locator('article.toolResult').last().textContent(), /ONLY-B/);
  assert.doesNotMatch(await b.locator('#transcript').textContent(), /ONLY-A|ALPHA/);
  await duplicate.locator('#history-menu > summary').click();
  await duplicate.locator('#new-conversation').click();
  await idle(duplicate);
  assert.match(await send(duplicate, 'Code: text(load("marker") ?? "EMPTY-A");'), /EMPTY-A/);
  assert.match(await send(b, 'Code: text(load("marker"));'), /ONLY-B/);
  await send(duplicate, 'Search: source evidence');
  assert.match(await send(b, `Read source: ${origin}/fresh-source`), /not in this task’s search results/);
  await send(b, 'Search: source evidence');
  assert.match(await send(b, `Read source: ${origin}/fresh-source`), /713/);
  assert.match(await send(duplicate, `Read source: ${origin}/fresh-source`), /713/);
  await duplicate.locator('#history-menu > summary').click();
  assert.equal(await duplicate.locator(`#conversation button[value="${idA}"]`).getAttribute('aria-current'), 'true');
  await duplicate.locator(`#conversation button[value="${idB}"]`).click();
  await duplicate.locator('#panel-owner').waitFor();
  assert.equal(await b.locator('#send').isEnabled(), true, 'Selecting an owned conversation must not steal it');
  await duplicate.locator('#history-menu > summary').click();
  await duplicate.locator(`#conversation button[value="${idA}"]`).click();
  await ready(duplicate);
  assert.doesNotMatch(await duplicate.locator('#transcript').textContent(), /ONLY-B|BETA/);
  const opened = browser.waitForEvent('page');
  await b.locator('#history-menu > summary').click();
  await b.locator('#open-conversation').click();
  const agentTab = await opened;
  await ready(agentTab);
  assert.equal(new URL(agentTab.url()).searchParams.get('conversation'), idB);
  assert.equal(await b.locator('#send').isDisabled(), true);
  assert.equal(await duplicate.locator('#send').isEnabled(), true);
  assert.match(await send(agentTab, 'Inspect from the agent tab'), /BETA/);
  await agentTab.reload(); await ready(agentTab);
  assert.match(await agentTab.locator('#transcript').textContent(), /ONLY-B/);
  assert.doesNotMatch(await agentTab.locator('#transcript').textContent(), /ONLY-A|ALPHA/);
  await duplicate.setViewportSize({ width: 320, height: 640 });
  await duplicate.screenshot({ path: resolve(artifacts, 'conversation-narrow.png') });
  assert.equal(await duplicate.evaluate(() => document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight), false);
  await agentTab.screenshot({ path: resolve(artifacts, 'agent-b-restored.png') });
  assert.deepEqual(errors, []);
  await writeFile(resolve(artifacts, 'report.json'), JSON.stringify({ idA, idB, concurrentWorkers: true, stopIsolation: true, handoffIsolation: true, sandboxIsolation: true, searchResultIsolation: true, savedConversationPicker: true, openInTab: true, reload: true }, null, 2));
  console.log('PASS: per-tab conversations, overlapping Code Mode workers, Stop/handoff isolation, separate memory and search results, picker, Open in tab and reload.');
} finally {
  for (const done of pending.values()) done();
  await browser?.close();
  await new Promise(done => server.close(done));
  await rm(profile, { recursive: true, force: true });
}
