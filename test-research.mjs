import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, cp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { browserOptions, artifactDirectory, liveModelSettings } from './test/browser.mjs';

const live = process.argv.includes('--live');
const model = live ? liveModelSettings() : null;
const artifacts = artifactDirectory(live ? 'research-live' : 'research');
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(`${tmpdir()}/accanto-research-`);
const extension = resolve(profile, 'extension');
await cp('dist', extension, { recursive: true });
const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
// Only the disposable fixture and provider are pregranted; production requests
// optional host access from explicit user gestures.
manifest.host_permissions.push('http://127.0.0.1/*', 'https://developer.mozilla.org/*', 'https://api.search.tinyfish.ai/*', 'https://api.search.brave.com/*');
if (model) manifest.host_permissions.push(`${new URL(model.endpoint).origin}/*`);
await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
let sourceReads = 0;
const invoiceDemo = await readFile('docs/examples/code-mode-invoice.html', 'utf8');
const server = createServer((req, res) => {
  if (req.url === '/code-mode-invoice.html') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(invoiceDemo); return; }
  if (req.url === '/broken') { res.writeHead(503); res.end('Unavailable'); return; }
  if (req.url === '/slow') { setTimeout(() => { res.end('Slow source'); }, 15000); return; }
  if (req.url === '/source') sourceReads++;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><title>Research fixture</title><p>Line items: 3 at 27.50; delivery 8.25.</p><p>${'ordinary introduction '.repeat(300)}</p><p>Clause 19: the cancellation fee is $47.20.</p><textarea>private-field-value</textarea><input type="password" value="never-read"><p hidden>hidden-clause</p>`);
});
await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser, panel;
const report = { provider: live ? 'Live provider outcomes and synthetic protocol fixtures are recorded separately.' : 'Fixture-only checks: no external providers, model credentials or personal config files.', checks: [], modelRequests: [], modelResponses: [] };
const unexpectedRequests = [];
try {
  browser = await chromium.launchPersistentContext(profile, { ...browserOptions, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--apps-gallery-install-auto-confirm-for-tests=accept'], viewport: { width: 380, height: 850 }, deviceScaleFactor: 2 });
  if (!live) await browser.route(/^https?:\/\/(?!127\.0\.0\.1(?=[:/]))/, route => {
    if (new URL(route.request().url()).hostname === 'localhost') return route.continue();
    unexpectedRequests.push(new URL(route.request().url()).origin);
    return route.abort('blockedbyclient');
  });
  const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker');
  await worker.evaluate(() => chrome.storage.local.set({ mode: 'scripted' }));
  const fixture = await browser.newPage();
  await fixture.goto(origin);
  const next = browser.waitForEvent('page');
  await worker.evaluate((url) => chrome.tabs.create({ url, active: false }), `chrome-extension://${new URL(worker.url()).host}/panel.html`);
  panel = await next;
  const errors = [];
  panel.on('pageerror', (error) => errors.push(error.message));
  await panel.waitForFunction(() => document.getElementById('status').textContent.includes('Ready'));
  const send = async (prompt) => {
    await panel.locator('#prompt').fill(prompt);
    await panel.locator('#send').evaluate((button) => button.click());
    await panel.waitForFunction(() => !document.getElementById('send').disabled, null, { timeout: 45000 });
    return panel.locator('article.toolResult').last().textContent();
  };
  await panel.screenshot({ path: resolve(artifacts, 'ready.png') });
  await send('Find: cancellation fee');
  let result = JSON.parse(await panel.locator('article.toolResult pre').last().textContent());
  assert.ok(result.matches[0].offset > 4000);
  assert.match(result.matches[0].text, /\$47\.20/);
  assert.doesNotMatch(JSON.stringify(result), /never-read|private-field-value|hidden-clause/);
  assert.match(await send('Find: nonexistent-evidence'), /"matches":\[\]/);
  const calculation = String.raw`const page = JSON.parse(await tools.inspect_tab({})); const values = page.text.match(/(\d+) at (\d+\.\d{2}); delivery (\d+\.\d{2})/); text({quantity: Number(values[1]), unitPrice: Number(values[2]), delivery: Number(values[3]), total: Number(values[1]) * Number(values[2]) + Number(values[3]), url: page.url});`;
  assert.match(await send(`Code: ${calculation}`), /90\.75/);
  await panel.locator('article.toolResult details').last().evaluate((element) => { element.open = true; });
  assert.match(await panel.locator('article.toolResult .nested-activity').last().textContent(), /Read this pageComplete/);
  assert.equal(await panel.locator('article.toolCall').count(), 0, 'Completed actions must not leave duplicate call rows');
  assert.equal(await panel.locator('article.toolResult .tool-state').last().textContent(), 'Complete');
  assert.match(await panel.locator('article.toolResult .tool-preview').last().textContent(), /total: 90\.75/);
  assert.match(await panel.locator('article.toolResult .tool-input').last().textContent(), /tools\.inspect_tab/);
  await panel.locator('.turn-activity').last().evaluate(element => { element.open = true; });
  await panel.screenshot({ path: resolve(artifacts, 'calculation.png') });
  await fixture.goto(`${origin}/code-mode-invoice.html`);
  assert.match(await send(`Code: ${calculation}`), /90\.75/);
  await fixture.locator('#change-invoice').click();
  assert.match(await send(`Code: ${calculation}`), /84\.55/);
  assert.ok((await panel.locator('article.toolResult').last().textContent()).includes('/code-mode-invoice.html'));
  await fixture.screenshot({ path: resolve(artifacts, 'code-mode-demo.png') });
  await fixture.goto(origin);
  assert.match(await send('Code: await tools.type_in_focused_field({text:"forbidden"});'), /does not exist/i);
  assert.equal(await fixture.locator('textarea').inputValue(), 'private-field-value');
  assert.match(await send('Code: text([typeof fetch, typeof chrome, typeof document]);'), /undefined/);
  assert.match(await send('Code: while(true) {}'), /timeout|interrupt|exceeded/i);
  assert.match(await send('Code: const a=[]; while(true) a.push(new Array(100000).fill(1));'), /memory|allocation/i);
  assert.match(await send('Code: text(17*23);'), /391/);
  await send('Code: store("oldTask", "private old task"); text("stored");');
  assert.match(await send('Code: text(load("oldTask"));'), /private old task/);
  report.checks.push('Page search beyond 4,000 characters; exclusions; empty match; worker calculation 90.75; unapproved editing rejected; no direct APIs; infinite loop and allocation bounded; recovery 391');
  await panel.locator('#web-conversation').evaluate((button) => button.click());
  await panel.waitForFunction(() => !document.getElementById('send').disabled);
  assert.match(await panel.locator('#composer-target').textContent(), /No tab attached/);
  assert.match(await send('Code: text(load("oldTask") ?? "fresh task");'), /fresh task/);
  assert.match(await send('Code: await tools.inspect_tab({});'), /No tab attached/);
  assert.equal(await panel.locator('#search-provider').inputValue(), 'exa');
  assert.equal(await worker.evaluate(async () => (await chrome.storage.session.get('braveKey')).braveKey), undefined);
  assert.equal(await worker.evaluate(async () => (await chrome.storage.session.get('tinyfishKey')).tinyfishKey), undefined);
  if (live) {
  const exaResponses = [];
  const captureExa = (response) => { if (response.url().startsWith('https://mcp.exa.ai/')) exaResponses.push(response); };
  panel.on('response', captureExa);
  report.liveExa = { origin: await panel.evaluate(() => location.origin), query: 'MDN Array map JavaScript reference', result: await send('Search: MDN Array map JavaScript reference') };
  panel.off('response', captureExa);
  assert.equal(exaResponses.length, 1);
  report.liveExa.http = { status: exaResponses[0].status(), request: exaResponses[0].request().postDataJSON(), body: await exaResponses[0].text() };
  if (report.liveExa.result.includes('shared search limit reached')) {
    assert.equal(report.liveExa.http.status, 200);
    assert.match(report.liveExa.http.body, /ai.exa\/rateLimited/);
    assert.equal(await panel.locator('#search-fallback').isVisible(), true);
    await panel.screenshot({ path: resolve(artifacts, 'exa-live-limit.png') });
    report.liveExa.outcome = 'Live shared limit; no live search success in this run. The following protocol fixture is synthetic and does not prove live availability.';
    // Keep the suite self-contained; do not depend on local diagnostic captures.
    const fixtureResponse = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'Title: MDN Array.prototype.map()\nURL: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map\nPublished: N/A\nHighlights:\nProtocol fixture excerpt about the map callback.' }] } };
    await panel.route('https://mcp.exa.ai/mcp?tools=web_search_exa', (route) => route.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: message\ndata: ${JSON.stringify(fixtureResponse)}\n\n` }), { times: 1 });
    report.exaProtocolFixture = await send('Search: MDN Array map JavaScript reference');
  } else report.liveExa.outcome = 'Live extension search returned parsed Exa results.';
  const liveSearch = JSON.parse(await panel.locator('article.toolResult pre').last().textContent());
  assert.equal(liveSearch.provider, 'Exa');
  const mdn = liveSearch.results.find((item) => item.url === 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map');
  assert.ok(mdn, 'Exa live response or explicitly synthetic protocol fixture must parse the MDN map reference URL');
  assert.match(mdn.snippet, /map|callback/i);
  report.liveMdnRead = await send(`Read source: ${mdn.url}`);
  assert.match(report.liveMdnRead, /Fetched public source text/);
  assert.match(report.liveMdnRead, /Array\.prototype\.map|map\(\)/);
  await panel.screenshot({ path: resolve(artifacts, 'exa-sources.png') });
  await panel.locator('#new-conversation').evaluate((element) => element.click());
  await panel.waitForFunction(() => !document.getElementById('send').disabled);
  await panel.locator('#web-conversation').evaluate((element) => element.click());
  await panel.waitForFunction(() => !document.getElementById('send').disabled);
  }
  const exaQueries = [];
  await panel.route('https://mcp.exa.ai/mcp?tools=web_search_exa', async (route) => {
    const request = route.request().postDataJSON();
    assert.equal(request.method, 'tools/call');
    assert.equal(request.params.name, 'web_search_exa');
    assert.equal(request.params.arguments.numResults, 6);
    assert.equal(route.request().headers()['x-exa-source'], undefined);
    assert.equal(route.request().headers()['x-api-key'], undefined);
    const query = request.params.arguments.query;
    exaQueries.push(query);
    const text = query === 'empty' ? 'No results found.' : ['source', 'broken', 'slow'].map((path, i) => `Title: ${['Fee evidence', 'Unavailable source', 'Slow source'][i]}\nURL: ${origin}/${path}\nPublished: ${i ? 'N/A' : '2026-10-30'}\n${i ? 'Text' : 'Highlights'}: Snippet only, not full text.`).join('\n\n---\n\n');
    const result = query === 'limited' ? { _meta: { 'ai.exa/rateLimited': true }, content: [{ type: 'text', text: 'Do not treat this as empty results.' }] }
      : query === 'tool-error' ? { isError: true, content: [{ type: 'text', text: 'Fixture tool failure' }] }
      : { content: [{ type: 'text', text: query === 'changed' ? 'Unknown response format' : text }] };
    const message = query === 'rpc-error' ? { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'Fixture RPC failure' } } : { jsonrpc: '2.0', id: 1, result };
    await route.fulfill({ status: 200, contentType: query === 'json' ? 'application/json' : 'text/event-stream', body: query === 'json' ? JSON.stringify(message) : `: keepalive\r\n\r\nevent: message\r\ndata: ${JSON.stringify(message)}\r\n\r\n` });
  });
  assert.match(await send('Search: empty'), /"results":\[\]/);
  assert.match(await send('Search: rpc-error'), /Fixture RPC failure/);
  assert.match(await send('Search: tool-error'), /Fixture tool failure/);
  assert.match(await send('Search: changed'), /unrecognized search content/);
  assert.match(await send('Search: limited'), /shared search limit reached/);
  assert.equal(await panel.locator('#search-fallback').isVisible(), true);
  assert.equal(await panel.locator('#open-search').getAttribute('href'), 'https://duckduckgo.com/?q=limited');
  // Check the new-tab action without treating a navigation fixture as a live
  // DuckDuckGo search or giving the model access to that tab.
  await browser.route('https://duckduckgo.com/?q=limited', (route) => route.fulfill({ contentType: 'text/html', body: '<title>Search navigation fixture</title>' }));
  const openedSearch = browser.waitForEvent('page');
  await panel.locator('#open-search').click();
  const searchTab = await openedSearch;
  await searchTab.waitForURL('https://duckduckgo.com/?q=limited');
  assert.match(await panel.locator('#composer-target').textContent(), /No tab attached/);
  await searchTab.close();
  await browser.unroute('https://duckduckgo.com/?q=limited');
  await panel.screenshot({ path: resolve(artifacts, 'exa-fallback.png') });
  await panel.setViewportSize({ width: 320, height: 640 });
  report.narrowViewport = await panel.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, elements: [...document.body.children].filter((element) => element.getBoundingClientRect().height).map((element) => ({ id: element.id || element.tagName, top: element.getBoundingClientRect().top, bottom: element.getBoundingClientRect().bottom, height: element.getBoundingClientRect().height, maxHeight: getComputedStyle(element).maxHeight })) }));
  assert.equal(await panel.evaluate(() => document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth), false, 'Task actions and fallback must leave the composer within the narrow viewport');
  await panel.screenshot({ path: resolve(artifacts, 'exa-fallback-narrow.png') });
  await panel.setViewportSize({ width: 380, height: 850 });
  const jsonResult = await send('Search: json');
  assert.match(jsonResult, /Search snippets only/);
  assert.match(jsonResult, /2026-10-30/);
  assert.doesNotMatch(jsonResult, /"date":"N\/A"/);
  assert.equal(await panel.locator('#search-fallback').isVisible(), false);
  assert.equal(await panel.locator('#source-list .source-card').count(), 3);
  assert.equal(sourceReads, 0);
  assert.deepEqual(exaQueries, ['empty', 'rpc-error', 'tool-error', 'changed', 'limited', 'json']);
  report.checks.push('Exa SSE/JSON fixtures with Highlights/Text, dates, empty results, HTTP200 rate limit, RPC/tool errors and unknown content; no key or identity header; explicit browser fallback');
  await panel.locator('#research-settings').evaluate((element) => { element.closest('#connection').open = element.open = true; });
  await panel.screenshot({ path: resolve(artifacts, 'exa-settings.png') });
  await panel.locator('#search-provider').selectOption('tinyfish');
  await worker.evaluate(() => chrome.storage.session.set({ searchProvider: 'tinyfish' }));
  assert.match(await send('Search: no key'), /TinyFish is not configured/);
  await panel.locator('#tinyfish-key').fill('invalid-tinyfish-key');
  await panel.locator('#save-search').evaluate((element) => element.click());
  await panel.waitForFunction(() => document.getElementById('search-state').textContent.includes('TinyFish'));
  assert.equal(await panel.locator('#tinyfish-key').inputValue(), '');
  assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('tinyfishKey')).tinyfishKey), 'invalid-tinyfish-key');
  const assertSettingsLayout = async () => {
    await panel.locator('#research-settings > summary').scrollIntoViewIfNeeded();
    assert.equal(await panel.evaluate(() => {
      const settings = document.getElementById('settings-drawer').getBoundingClientRect();
      const summary = document.querySelector('#research-settings > summary').getBoundingClientRect();
      const footer = document.querySelector('footer').getBoundingClientRect();
      const model = document.getElementById('settings').getBoundingClientRect();
      const search = document.getElementById('search-settings-slot').getBoundingClientRect();
      return model.bottom <= search.top && summary.left >= settings.left && summary.right <= settings.right && !document.getElementById('sources').open && summary.top >= settings.top && summary.bottom <= settings.bottom && settings.top >= 0 && settings.bottom <= innerHeight && footer.bottom <= innerHeight + 1 && document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight;
    }), true, 'Settings scroll inside the viewport without changing the composer layout or overflowing the page');
  };
  await assertSettingsLayout();
  await panel.screenshot({ path: resolve(artifacts, 'tinyfish-settings.png') });
  await panel.setViewportSize({ width: 320, height: 640 });
  await assertSettingsLayout();
  await panel.screenshot({ path: resolve(artifacts, 'tinyfish-settings-narrow.png') });
  await panel.locator('#save-search').scrollIntoViewIfNeeded();
  await panel.screenshot({ path: resolve(artifacts, 'tinyfish-key-controls-narrow.png') });
  await panel.setViewportSize({ width: 380, height: 850 });
  if (live) {
    report.tinyfishInvalidKey = await send('Search: Pi Accanto integration test');
    assert.match(report.tinyfishInvalidKey, /TinyFish returned HTTP|Failed to fetch/);
  }
  let tinyfishStatus = 200;
  await panel.route('https://api.search.tinyfish.ai/**', async (route) => {
    assert.equal(route.request().headers()['x-api-key'], 'invalid-tinyfish-key');
    assert.equal(new URL(route.request().url()).searchParams.get('query'), 'TinyFish fixture');
    await route.fulfill({ status: tinyfishStatus, contentType: 'application/json', body: JSON.stringify({ results: [
      { url: 'javascript:alert(1)' }, { url: 'https://user:secret@example.org/' }, { url: 'not a URL' },
      { title: 'Fee evidence'.repeat(40), url: `${origin}/source`, snippet: 'TinyFish fixture snippet'.repeat(100), date: '2026-10-30' },
      { title: 'Duplicate', url: `${origin}/source`, snippet: 'Must not duplicate the source' },
    ] }) });
  });
  assert.match(await send('Search: TinyFish fixture'), /TinyFish fixture snippet/);
  const normalized = JSON.parse(await panel.locator('article.toolResult pre').last().textContent());
  assert.deepEqual(normalized.results.map((item) => item.url), [`${origin}/source`]);
  assert.equal(normalized.results[0].title.length, 300);
  assert.equal(normalized.results[0].snippet.length, 1600);
  tinyfishStatus = 429;
  assert.match(await send('Search: TinyFish fixture'), /HTTP 429/);
  assert.deepEqual(exaQueries, ['empty', 'rpc-error', 'tool-error', 'changed', 'limited', 'json']);
  await panel.locator('#remember-search-key').uncheck();
  await panel.locator('#save-search').evaluate(element => element.click());
  await panel.waitForFunction(() => document.getElementById('search-status').textContent.includes('session only'));
  assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('tinyfishKey')).tinyfishKey), undefined);
  tinyfishStatus = 200;
  assert.match(await send('Search: TinyFish fixture'), /TinyFish fixture snippet/);
  await panel.locator('#disable-search').evaluate((element) => element.click());
  await panel.waitForFunction(() => document.getElementById('search-provider').value === 'exa');
  assert.equal(await worker.evaluate(async () => (await chrome.storage.session.get('tinyfishKey')).tinyfishKey), undefined);
  assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('tinyfishKey')).tinyfishKey), undefined);
  report.checks.push('TinyFish remembered key: fixture success and429; no silent Exa fallback; key cleared from input and forgotten from local and session storage');
  await panel.locator('#search-provider').selectOption('brave');
  await worker.evaluate(() => chrome.storage.session.set({ searchProvider: 'brave' }));
  assert.match(await send('Search: public research query'), /not configured/);
  await panel.locator('#brave-key').fill('invalid-test-key');
  await panel.locator('#brave-storage').check();
  await panel.locator('#save-search').evaluate((element) => element.click());
  await panel.waitForFunction(() => document.getElementById('search-state').textContent.includes('Key available'));
  assert.equal(await panel.locator('#brave-key').inputValue(), '');
  await assertSettingsLayout();
  await panel.screenshot({ path: resolve(artifacts, 'search-settings.png') });
  await panel.locator('#research-settings').evaluate((element) => { element.closest('#connection').open = element.open = false; });
  if (live) {
    const providerFailure = await send('Search: Pi Accanto API integration test');
    assert.match(providerFailure, /Brave Search returned HTTP|Failed to fetch/);
    report.providerFailure = providerFailure;
  }
  const queries = [];
  let providerStatus = 200;
  await panel.route('https://api.search.brave.com/res/v1/web/search?**', async (route) => {
    const url = new URL(route.request().url());
    queries.push(url.searchParams.get('q'));
    assert.equal(route.request().headers()['x-subscription-token'], 'invalid-test-key');
    await route.fulfill({ status: providerStatus, contentType: 'application/json', body: JSON.stringify({ type: 'search', web: { results: url.searchParams.get('q') === 'empty' ? [] : [
      { title: 'Fee evidence', url: `${origin}/source`, description: 'Snippet only, not full text.', page_age: '2026-10-30' },
      { title: 'Unavailable source', url: `${origin}/broken`, description: 'May fail.' },
      { title: 'Slow source', url: `${origin}/slow`, description: 'Cancellation fixture.' },
      { title: 'Another website', url: `http://localhost:${server.address().port}/source`, description: 'Requires a separate Chrome website grant.' },
    ] } }) });
  });
  assert.match(await send('Search: empty'), /"results":\[\]/);
  providerStatus = 429;
  assert.match(await send('Search: limited'), /HTTP 429/);
  providerStatus = 200;
  assert.match(await send('Search: deliberate public query'), /Search snippets only/);
  assert.equal(queries.at(-1), 'deliberate public query');
  assert.equal(sourceReads, 0);
  assert.match(await send(`Read source: ${origin}/not-a-search-result`), /not in this task’s search results/);
  assert.equal(await panel.locator('article.toolResult').last().locator('.source-access').count(), 0, 'An arbitrary URL must not offer website access');
  const read = await send(`Read source: ${origin}/source`);
  assert.match(read, /Clause 19/);
  assert.match(read, /Fetched public source text/);
  assert.doesNotMatch(read, /never-read|private-field-value/);
  assert.equal(sourceReads, 1, 'Existing Chrome access must allow reading without per-result approval');
  assert.equal(await panel.locator('article.toolResult').last().locator('.source-access').count(), 0);
  await panel.locator('.turn-activity').last().evaluate(element => { element.open = true; });
  await panel.locator('article.toolResult').last().scrollIntoViewIfNeeded();
  await panel.screenshot({ path: resolve(artifacts, 'source-read.png') });
  const missingOrigin = `http://localhost:${server.address().port}`;
  assert.match(await send(`Code: await tools.read_web_source({url:${JSON.stringify(`${missingOrigin}/source`)}});`), /Website access is needed/);
  assert.equal(await panel.locator('article.toolResult').last().locator('.source-access a').getAttribute('href'), `${missingOrigin}/source`, 'Code Mode must identify the exact source needing website access');
  assert.match(await send(`Read source: ${missingOrigin}/source`), /Website access is needed/);
  assert.equal(sourceReads, 1, 'Missing Chrome permission must block the fetch');
  const blockedRead = panel.locator('article.toolResult').last();
  assert.equal(await blockedRead.locator('.source-access').isVisible(), true, 'Website access must be available beside the blocked read without expanding technical details');
  assert.equal(await blockedRead.locator('.tool-state').textContent(), 'Access needed');
  assert.equal(await blockedRead.locator('.source-access a').getAttribute('href'), `${missingOrigin}/source`);
  assert.equal(await panel.locator('#sources').evaluate(element => element.open), false, 'Inline approval must not require opening Web sources');
  await blockedRead.locator('.source-access').scrollIntoViewIfNeeded();
  await panel.screenshot({ path: resolve(artifacts, 'source-access.png') });
  await panel.setViewportSize({ width: 320, height: 640 });
  await blockedRead.locator('.source-access').scrollIntoViewIfNeeded();
  assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Inline approval must fit narrow layouts');
  await panel.screenshot({ path: resolve(artifacts, 'source-access-narrow.png') });
  await panel.setViewportSize({ width: 380, height: 850 });
  // Exercise denial once, then preapprove the host through Chrome's settings
  // and exercise the real optional-permission request from the retry click.
  await panel.evaluate(() => {
    let decline = true;
    const request = chrome.permissions.request.bind(chrome.permissions);
    chrome.permissions.request = options => { if (decline) { decline = false; return Promise.resolve(false); } return request(options); };
  });
  await blockedRead.getByRole('button', { name: 'Allow website', exact: true }).click();
  await blockedRead.getByRole('button', { name: /Access failed: Host access was declined/ }).waitFor();
  assert.equal(sourceReads, 1);
  const permissions = await browser.newPage();
  try {
    await permissions.goto('chrome://extensions/');
    await permissions.evaluate(({ id, host }) => chrome.developerPrivate.addHostPermission(id, host), { id: new URL(worker.url()).host, host: 'http://localhost/*' });
  } finally { await permissions.close(); }
  await panel.bringToFront();
  await blockedRead.getByRole('button', { name: /Try again/ }).click();
  await panel.bringToFront();
  await blockedRead.getByRole('button', { name: 'Website access allowed' }).waitFor();
  assert.equal(await worker.evaluate(host => chrome.permissions.contains({ origins: [host] }), `${missingOrigin}/*`), true, 'Chrome must record the optional website grant');
  assert.equal(await blockedRead.locator('.tool-state').textContent(), 'Access allowed');
  assert.match(await blockedRead.locator('.source-access').textContent(), /Send a follow-up to retry/);
  assert.equal(sourceReads, 1, 'Granting access must not silently retry a read');
  await panel.screenshot({ path: resolve(artifacts, 'website-access-granted.png') });
  await panel.locator('#sources').evaluate((element) => { element.open = true; });
  await panel.waitForFunction(() => !document.querySelector('#source-list button'));
  await panel.screenshot({ path: resolve(artifacts, 'sources.png') });
  assert.match(await send(`Read source: ${missingOrigin}/source`), /Fetched public source text/);
  assert.equal(sourceReads, 2);
  const partial = await send(`Code: const results = await Promise.allSettled([tools.read_web_source({url:${JSON.stringify(`${origin}/source`)}}), tools.read_web_source({url:${JSON.stringify(`${origin}/broken`)}})]); text(results.map(r => r.status === 'fulfilled' ? {status:r.status, url:JSON.parse(r.value).url} : {status:r.status, error:String(r.reason)}));`);
  assert.match(partial, /fulfilled/);
  assert.match(partial, /rejected/);
  assert.match(partial, /HTTP 503/);
  assert.equal(await panel.locator('article.toolResult > details > summary .tool-state').last().textContent(), 'Completed with issues');
  await panel.locator('#sources').evaluate((element) => { element.open = false; });
  await panel.locator('.turn-activity').last().evaluate(element => { element.open = true; });
  await panel.locator('article.toolResult details').last().evaluate((element) => { element.open = true; });
  await panel.locator('article.toolResult').last().evaluate((element) => { document.getElementById('transcript').scrollTop += element.getBoundingClientRect().top - document.getElementById('transcript').getBoundingClientRect().top - 12; });
  await panel.screenshot({ path: resolve(artifacts, 'partial-failure.png') });
  await panel.locator('#prompt').fill(`Code: await tools.read_web_source({url:${JSON.stringify(`${origin}/slow`)}});`);
  await panel.locator('#send').evaluate((element) => element.click());
  await panel.waitForFunction(() => [...document.querySelectorAll('.nested-activity')].some((element) => element.textContent.includes('Running')));
  assert.equal(await panel.locator('article.toolCall .tool-state').last().textContent(), 'Running');
  await panel.locator('#stop').evaluate((element) => element.click());
  await panel.waitForFunction(() => !document.getElementById('send').disabled);
  assert.match(await send('Code: text(19*7);'), /133/);
  await panel.locator('#prompt').fill(`Code: await tools.read_web_source({url:${JSON.stringify(`${origin}/slow`)}});`);
  await panel.locator('#send').evaluate((element) => element.click());
  await panel.waitForFunction(() => [...document.querySelectorAll('.nested-activity')].some((element) => element.textContent.includes('Running')));
  const nextPanel = await browser.newPage();
  await nextPanel.goto(panel.url());
  await nextPanel.locator('#panel-owner').waitFor({ state: 'visible' });
  await nextPanel.locator('#continue-here').click();
  await nextPanel.waitForFunction(() => document.getElementById('status').textContent.includes('Ready'));
  assert.equal(await panel.locator('#send').isDisabled(), true, 'The old owner cannot submit after its pending read is stopped');
  assert.equal(await nextPanel.locator('#sources').isVisible(), false, 'Handoff requires fresh search evidence');
  await nextPanel.close();
  await panel.locator('#continue-here').evaluate((element) => element.click());
  await panel.waitForFunction(() => document.getElementById('status').textContent.includes('Ready'));
  assert.equal(await panel.locator('#sources').isVisible(), false);
  assert.match(await send(`Read source: ${origin}/source`), /not in this task’s search results/);
  assert.match(await send('Search: deliberate public query'), /Search snippets only/);
  assert.match(await send(`Read source: ${missingOrigin}/source`), /Fetched public source text/);
  const readsBeforeRevocation = sourceReads;
  await worker.evaluate(() => chrome.permissions.remove({ origins: ['http://localhost/*'] }));
  assert.match(await send(`Read source: ${missingOrigin}/source`), /Website access is needed/);
  assert.equal(sourceReads, readsBeforeRevocation, 'Revoking Chrome access must block further reads');
  const allSites = await browser.newPage();
  try {
    await allSites.goto('chrome://extensions/');
    await allSites.evaluate(async id => {
      for (const host of ['http://*/*', 'https://*/*']) await chrome.developerPrivate.addHostPermission(id, host);
    }, new URL(worker.url()).host);
  } finally { await allSites.close(); }
  assert.equal(await panel.evaluate(() => chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] })), true);
  assert.match(await send(`Read source: ${missingOrigin}/source`), /Fetched public source text/);
  assert.equal(sourceReads, readsBeforeRevocation + 1, 'All-website access must cover source reads without per-result approval');
  report.checks.push('Existing, persistent and all-website Chrome access; revocation; missing-host inline action; permission denial/retry; exact search-result isolation; bounded source extraction; partial failure; Stop/recovery; fresh search after handoff');
  if (live) {
  // Real model chooses tools and writes its own script. This checks the local
  // model integration without claiming a live Brave search succeeded.
  // This disposable extension's ID is not on the local model server's Origin
  // allowlist. Relay only this test's model requests through Node; the real
  // model still chooses tools and generates the scripts. Native browser tests
  // use the canonical extension ID and exercise direct transport separately.
  await panel.route(`${model.endpoint}/chat/completions`, async (route) => {
    report.modelRequests.push(route.request().postDataJSON());
    const response = await fetch(route.request().url(), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${model.apiKey}` }, body: route.request().postData(), redirect: 'error', signal: AbortSignal.timeout(120000) });
    const body = Buffer.from(await response.arrayBuffer());
    report.modelResponses.push({ status: response.status, body: body.toString('utf8') });
    await writeFile(resolve(artifacts, 'report.json'), JSON.stringify(report, null, 2));
    await route.fulfill({ status: response.status, contentType: response.headers.get('content-type'), body });
  });
  await worker.evaluate(async ({ endpoint, modelId, apiKey }) => {
    await chrome.storage.session.set({ apiKey, apiKeyEndpoint: endpoint });
    await chrome.storage.local.set({ mode: 'live', modelConnection: { endpoint, modelId } });
  }, model);
  await panel.reload();
  await panel.waitForFunction(() => document.getElementById('status').textContent.includes('Ready'));
  await fixture.bringToFront();
  await panel.locator('#new-conversation').evaluate((element) => element.click());
  await panel.waitForFunction(() => !document.getElementById('send').disabled);
  const implicitQuestion = async (prompt, expected) => {
    const before = report.modelRequests.length;
    await panel.locator('#prompt').fill(prompt);
    await panel.locator('#send').evaluate((element) => element.click());
    await panel.waitForFunction(() => !document.getElementById('send').disabled, null, { timeout: 150000 });
    const request = report.modelRequests[before];
    assert.ok(request, 'The question must reach the model');
    const input = request.messages.findLast((message) => message.role === 'user');
    const sent = JSON.stringify(input.content);
    assert.match(sent, /Attached page context captured/);
    assert.ok(sent.includes(origin));
    assert.ok(sent.includes(expected));
    assert.doesNotMatch(sent, /private-field-value|never-read|hidden-clause/);
    assert.match(await panel.locator('article.assistant .message-body').last().textContent(), new RegExp(expected.replace('.', '\\.')));
    assert.equal(await panel.locator('article.user pre').last().textContent(), prompt, 'The transcript shows the question without a raw context dump');
  };
  await implicitQuestion('What is the unit price?', '27.50');
  await fixture.locator('p').first().evaluate((element) => { element.textContent = 'Line items: 3 at 31.40; delivery 8.25.'; });
  await implicitQuestion('What is the unit price now?', '31.40');
  await panel.screenshot({ path: resolve(artifacts, 'implicit-page-context.png') });
  await fixture.locator('p').first().evaluate((element) => { element.textContent = 'Line items: 3 at 27.50; delivery 8.25.'; });
  await panel.locator('#new-conversation').evaluate((element) => element.click());
  await panel.waitForFunction(() => !document.getElementById('send').disabled);
  await panel.locator('#prompt').fill('Use search_page to find the cancellation fee beyond the introduction. Then use codemode to call inspect_tab and calculate 3 items times their unit price plus delivery from its text. Cite the page URL and fee clause. Use the tools, not mental arithmetic.');
  await panel.locator('#send').evaluate((element) => element.click());
  await panel.waitForFunction(() => !document.getElementById('send').disabled, null, { timeout: 150000 });
  const live = await panel.locator('#transcript').textContent();
  assert.match(live, /Search this page/);
  assert.match(live, /Code Mode/);
  assert.match(await panel.locator('article.assistant .message-body').last().textContent(), /90\.75/);
  assert.match(live, /47\.20/);
  report.liveModel = live;
  report.liveTransport = 'Actual local model via test-only Node relay because the disposable extension ID is outside its Origin allowlist.';
  await panel.screenshot({ path: resolve(artifacts, 'live-model.png') });
  await fixture.goto(`${origin}/code-mode-invoice.html`);
  await fixture.locator('#change-invoice').click();
  await panel.locator('#new-conversation').evaluate((element) => element.click());
  await panel.waitForFunction(() => !document.getElementById('send').disabled);
  await panel.locator('#prompt').fill('Use Code Mode to read the invoice\'s actual quantity, unit price and delivery, calculate the total, and cite the page URL. Show the inputs and your working.');
  await panel.locator('#send').evaluate((element) => element.click());
  await panel.waitForFunction(() => !document.getElementById('send').disabled, null, { timeout: 150000 });
  assert.match(await panel.locator('article.toolResult').last().textContent(), /84\.55/);
  assert.match(await panel.locator('article.assistant .message-body').last().textContent(), /84\.55/);
  assert.ok((await panel.locator('article.assistant .message-body').last().textContent()).includes('/code-mode-invoice.html'));
  report.invoiceDemoAnswer = await panel.locator('#transcript').textContent();
  await panel.screenshot({ path: resolve(artifacts, 'code-mode-demo-answer.png') });
  await panel.locator('#new-conversation').evaluate((element) => element.click());
  await panel.waitForFunction(() => !document.getElementById('send').disabled);
  await panel.locator('#web-conversation').evaluate((element) => element.click());
  await panel.waitForFunction(() => !document.getElementById('send').disabled);
  await panel.locator('#research-settings').evaluate((element) => { element.closest('#connection').open = element.open = true; });
  await panel.locator('#search-provider').selectOption('exa');
  await panel.locator('#save-search').evaluate((element) => element.click());
  await panel.waitForFunction(() => document.getElementById('search-state').textContent.includes('Exa'));
  await panel.locator('#research-settings').evaluate((element) => { element.closest('#connection').open = element.open = false; });
  await panel.screenshot({ path: resolve(artifacts, 'web-ready.png') });
  const askModel = async (prompt) => {
    await panel.locator('#prompt').fill(prompt);
    await panel.locator('#send').evaluate((element) => element.click());
    await panel.waitForFunction(() => !document.getElementById('send').disabled, null, { timeout: 150000 });
    return panel.locator('article.assistant .message-body').last().textContent();
  };
  const queriesBeforeWebTask = exaQueries.length;
  report.webSearchAnswer = await askModel('Search the web for "Research Fixture cancellation fee policy". Cite the result URLs and say whether you have read the full sources.');
  report.webSearchQueries = exaQueries.slice(queriesBeforeWebTask);
  report.webSearchTranscript = await panel.locator('#transcript').textContent();
  const webInput = JSON.stringify(report.modelRequests.findLast((request) => request.messages.some((message) => message.role === 'user' && JSON.stringify(message.content).includes('Research Fixture cancellation fee policy'))).messages);
  assert.doesNotMatch(webInput, /Attached page context captured|Line items:|31\.40/, 'Web research must not include the previously attached page');
  assert.ok(exaQueries.length > queriesBeforeWebTask, 'Real model must invoke the search tool in this task');
  assert.equal(await panel.locator('#source-list .source-card').count(), 3);
  const sourcedAnswer = await askModel(`Use read_web_source to read ${origin}/source and tell me the actual clause and amount. Cite its URL. Do not search again.`);
  assert.match(sourcedAnswer, /47\.20/);
  assert.ok(sourcedAnswer.includes(`${origin}/source`));
  report.liveWebFixture = sourcedAnswer;
  await panel.screenshot({ path: resolve(artifacts, 'live-sourced-answer.png') });
  }
  if (!live) {
    await panel.locator('#connection').evaluate(element => { element.open = true; });
    await panel.locator('#research-settings').evaluate(element => { element.open = true; });
    await panel.locator('#search-provider').selectOption('tinyfish');
    await panel.locator('#tinyfish-key').fill('restart-tinyfish-fixture-key');
    assert.equal(await panel.locator('#remember-search-key').isChecked(), true);
    await panel.locator('#save-search').evaluate(element => element.click());
    await panel.waitForFunction(() => document.getElementById('search-state').textContent.includes('TinyFish'));
    const restartResearch = async () => {
      const url = panel.url();
      await browser.close();
      browser = await chromium.launchPersistentContext(profile, { ...browserOptions, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`], viewport: { width: 380, height: 850 }, deviceScaleFactor: 2 });
      await browser.route(/^https?:\/\/(?!127\.0\.0\.1(?=[:/]))/, route => {
        unexpectedRequests.push(new URL(route.request().url()).origin);
        return route.abort('blockedbyclient');
      });
      panel = await browser.newPage();
      panel.on('pageerror', error => errors.push(error.message));
      await panel.goto(url);
      await panel.waitForFunction(() => document.getElementById('status').textContent.includes('Ready'));
    };
    await restartResearch();
    assert.equal(await panel.locator('#search-provider').inputValue(), 'tinyfish');
    assert.equal(await panel.locator('#tinyfish-key').inputValue(), '');
    assert.equal(await panel.locator('#remember-search-key').isChecked(), true);
    await panel.route('https://api.search.tinyfish.ai/**', async route => {
      assert.equal(route.request().headers()['x-api-key'], 'restart-tinyfish-fixture-key');
      await route.fulfill({ json: { results: [{ title: 'Remembered TinyFish', url: `${origin}/source`, snippet: 'TinyFish works after restart.' }] } });
    });
    assert.match(await send('Search: restart'), /TinyFish works after restart/);
    await panel.locator('#connection').evaluate(element => { element.open = true; });
    await panel.locator('#research-settings').evaluate(element => { element.open = true; });
    await panel.locator('#remember-search-key').uncheck();
    await panel.locator('#save-search').evaluate(element => element.click());
    await panel.waitForFunction(() => document.getElementById('search-status').textContent.includes('session only'));
    await panel.locator('#search-provider').selectOption('brave');
    assert.equal(await panel.locator('#brave-storage').isChecked(), true, 'Brave storage-rights consent survives with the remembered key');
    await panel.locator('#save-search').evaluate(element => element.click());
    await panel.waitForFunction(() => document.getElementById('search-state').textContent.includes('Brave'));
    await panel.route('https://api.search.brave.com/**', async route => {
      assert.equal(route.request().headers()['x-subscription-token'], 'invalid-test-key');
      await route.fulfill({ json: { web: { results: [{ title: 'Remembered Brave', url: `${origin}/source`, description: 'Brave works after restart.' }] } } });
    });
    assert.match(await send('Search: restart'), /Brave works after restart/);
    await panel.locator('#remember-search-key').uncheck();
    await panel.locator('#save-search').evaluate(element => element.click());
    await panel.waitForFunction(() => document.getElementById('search-status').textContent.includes('session only'));
    assert.deepEqual(await panel.evaluate(() => chrome.storage.local.get(['tinyfishKey', 'braveKey', 'braveStorage'])), {}, 'Switching to session-only removes persisted keys and consent');
    await restartResearch();
    assert.equal(await panel.locator('#search-provider').inputValue(), 'brave', 'Provider choice persists even when a session key expires');
    assert.deepEqual(await panel.evaluate(() => chrome.storage.session.get(['tinyfishKey', 'braveKey', 'braveStorage'])), {});
    assert.match(await send('Search: expired'), /not configured/);
    report.checks.push('Real browser restarts: remembered TinyFish and Brave authenticate searches; Brave consent persists; changing to session-only deletes saved copies and expires both keys on restart');
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpectedRequests, [], 'Fixture checks must not fall through to real external services');
  assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await writeFile(resolve(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  console.log('Research checks passed. Evidence:', artifacts);
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  if (panel && !panel.isClosed()) {
    report.failureTranscript = await panel.locator('#transcript').textContent().catch(() => null);
    report.failureStatus = await panel.locator('#status').textContent().catch(() => null);
    await panel.screenshot({ path: resolve(artifacts, 'failure.png') }).catch(() => undefined);
  }
  throw error;
} finally {
  await writeFile(resolve(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  await browser?.close();
  await new Promise((done) => server.close(done));
  await rm(profile, { recursive: true, force: true });
}
