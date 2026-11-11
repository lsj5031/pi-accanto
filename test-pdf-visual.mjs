import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { pdf } from './test/pdf-fixtures.mjs';
import { browserOptions, artifactDirectory } from './test/browser.mjs';

const artifacts = artifactDirectory('pdf-visual');
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(`${tmpdir()}/accanto-pdf-visual-`);
const extension = resolve(profile, 'extension');
await cp('dist', extension, { recursive: true });
const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions.push('http://127.0.0.1/*');
await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
await build({ entryPoints: ['pdf-reader.js', 'attachments.js'], bundle: true, format: 'esm', platform: 'browser', outdir: resolve(extension, 'visual-test') });
let mixed;
let entropy;
let toolCall;
let responsePhase = 0;
const requests = [];
const server = createServer(async (req, res) => {
  if (req.url === '/mixed.pdf') { res.setHeader('Content-Type', 'application/pdf'); res.end(mixed); return; }
  if (req.url === '/entropy.pdf') { res.setHeader('Content-Type', 'application/pdf'); res.end(entropy); return; }
  if (req.url === '/v1/chat/completions') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    requests.push(request);
    const done = ++responsePhase > 1;
    const delta = done ? { content: 'Fixture transport checked, no model interpretation performed.' }
      : { tool_calls: [{ index: 0, id: `read-${requests.length}`, type: 'function', function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) } }] };
    res.setHeader('Content-Type', 'text/event-stream');
    res.end(`data: ${JSON.stringify({ id: 'visual-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'visual-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: done ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
    return;
  }
  res.end('<title>Visual PDF fixture</title>');
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launchPersistentContext(profile, { ...browserOptions, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`], viewport: { width: 380, height: 850 } });
  await browser.route(/^https?:\/\/(?!127\.0\.0\.1(?=[:/]))/, route => route.abort('blockedbyclient'));
  const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker');
  const base = `chrome-extension://${new URL(worker.url()).host}`;
  const generator = await browser.newPage();
  await generator.goto(`${base}/panel.html`);
  // A real raster scan, not vector text pretending to be a scanned page.
  const rgb = await generator.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 612; canvas.height = 792;
    const c = canvas.getContext('2d');
    c.fillStyle = 'white'; c.fillRect(0, 0, 612, 792);
    c.fillStyle = '#1249c7'; c.fillRect(40, 120, 170, 90);
    c.fillStyle = '#d52a18'; c.fillRect(380, 610, 180, 110);
    c.fillStyle = 'black'; c.font = 'bold 36px sans-serif'; c.fillText('SCAN 27, NORTH', 45, 300);
    c.font = '24px sans-serif'; c.fillText('7 crates, 13.40 each', 45, 350);
    c.beginPath(); c.moveTo(230, 440); c.lineTo(480, 520); c.lineTo(440, 465); c.stroke();
    const pixels = c.getImageData(0, 0, 612, 792).data;
    const bytes = new Uint8Array(612 * 792 * 3);
    for (let i = 0, j = 0; i < pixels.length; i += 4) { bytes[j++] = pixels[i]; bytes[j++] = pixels[i + 1]; bytes[j++] = pixels[i + 2]; }
    let value = '';
    for (let i = 0; i < bytes.length; i += 8192) value += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(value);
  });
  const raster = { width: 612, height: 792, rgb: Buffer.from(rgb, 'base64') };
  mixed = pdf([['TEXT COVER: 15 physical pages.'], ...Array.from({ length: 12 }, () => raster), { ...raster, lines: ['Partial native caption, diagram below.'] }, []]);
  const scan = pdf([raster]);
  const noise = Buffer.alloc(1600 * 1600 * 3);
  let seed = 731;
  for (let i = 0; i < noise.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; noise[i] = seed >>> 24; }
  entropy = pdf([{ width: 1600, height: 1600, rgb: noise, box: '0 0 10000 10000' }]);
  await generator.close();
  await worker.evaluate(endpoint => chrome.storage.local.set({ mode: 'live', modelConnection: { endpoint, modelId: 'unknown-fixture-vision', api: 'openai-completions', imageInput: true }, apiKey: 'fixture-not-secret', apiKeyEndpoint: endpoint, apiKeyApi: 'openai-completions' }), `${origin}/v1`);
  const main = await browser.newPage(); await main.goto(`${origin}/mixed.pdf`); await main.waitForLoadState('networkidle');
  const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, `${origin}/mixed.pdf`);
  const panel = await browser.newPage(); await panel.goto(`${base}/panel.html?tab=${tabId}`);
  const ready = () => panel.waitForFunction(() => document.getElementById('status').textContent.includes('Ready'));
  await ready();
  const errors = [];
  panel.on('pageerror', error => errors.push(error.message));
  async function read(start = 1, options = {}) {
    return panel.evaluate(async ({ start, options, origin }) => {
      try { return await (await import('./visual-test/pdf-reader.js')).readPdf(`${origin}/mixed.pdf`, start, undefined, options); }
      catch (error) { return { error: error.message }; }
    }, { start, options, origin });
  }
  const start = performance.now();
  const native = await read();
  assert.deepEqual(native.noTextPages, [2, 3, 4, 5, 6, 7, 8]);
  assert.match(native.pages[0].text, /TEXT COVER/);
  assert.equal(native.nextPage, 9);
  assert.equal(native.images, undefined);
  assert.match(native.note, /Request visual:true/);
  const later = await read(9);
  assert.deepEqual(later.noTextPages, [9, 10, 11, 12, 13, 15]);
  assert.match(later.pages.find(page => page.page === 14).text, /Partial native caption/);
  const visual = { visual: true, vision: true, page_count: 2 };
  const first = await read(1, visual);
  assert.equal(first.error, undefined);
  assert.deepEqual(first.images.map(image => image.page), [1, 2]);
  const inspected = [1, 2];
  for (let page = 3; page <= 15; page += 2) {
    const result = await read(page, visual);
    inspected.push(...result.images.map(image => image.page));
    assert.equal(result.nextPage, page === 15 ? null : page + 2);
    assert.ok(result.images.length <= 2);
    assert.ok(result.images.reduce((sum, image) => sum + image.data.length, 0) <= 3000000);
    for (const entry of result.pages) {
      assert.ok(entry.image.width <= 1600 && entry.image.height <= 1600);
      assert.ok(entry.image.width * entry.image.height <= 2000000);
      assert.equal(entry.image.encodedBytes, result.images[entry.image.index - 1].data.length);
    }
  }
  assert.deepEqual(inspected, Array.from({ length: 15 }, (_, i) => i + 1));
  const rendered = Buffer.from(first.images[1].data, 'base64');
  await writeFile(resolve(artifacts, 'physical-page-2.jpg'), rendered);
  // Independently check asymmetric raster pixels, and actual native cover glyphs.
  const sampleImages = images => panel.evaluate(async images => {
    const samples = [];
    for (const image of images) {
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(image.data), c => c.charCodeAt(0))], { type: 'image/jpeg' }));
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const c = canvas.getContext('2d'); c.drawImage(bitmap, 0, 0); bitmap.close();
      const sample = (x, y) => [...c.getImageData(Math.floor(x * canvas.width / 612), Math.floor(y * canvas.height / 792), 1, 1).data];
      const area = c.getImageData(40 * 2, 35 * 2, 500 * 2, 25 * 2).data;
      let dark = 0;
      for (let i = 0; i < area.length; i += 4) if (area[i] < 100 && area[i + 1] < 100 && area[i + 2] < 100) dark++;
      samples.push({ blue: sample(100, 150), red: sample(450, 650), white: sample(550, 100), dark });
    }
    return samples;
  }, images);
  const pixels = await sampleImages(first.images);
  assert.ok(pixels[0].dark > 100, 'Bundled standard font renders real cover glyphs');
  assert.ok(pixels[1].blue[2] > 150 && pixels[1].blue[0] < 50);
  assert.ok(pixels[1].red[0] > 150 && pixels[1].red[2] < 60);
  assert.ok(pixels[1].white.slice(0, 3).every(value => value > 245));
  const bounded = await panel.evaluate(async origin => {
    const started = performance.now();
    const result = await (await import('./visual-test/pdf-reader.js')).readPdf(`${origin}/entropy.pdf`, 1, undefined, { visual: true, vision: true, page_count: 1 });
    return { seconds: (performance.now() - started) / 1000, ...result.pages[0].image };
  }, origin);
  assert.ok(bounded.width <= 1414 && bounded.height <= 1414, 'Huge square page respects 2-megapixel bound');
  assert.ok(bounded.encodedBytes <= 1500000);
  assert.ok(bounded.seconds < 25, 'High-entropy first read has headroom below timeout');
  for (const [page, options, expected] of [[0, {}, /starting at 1/], [16, {}, /15 pages/], [1, { visual: true, page_count: 3 }, /1–2/], [1, { page_count: 9 }, /1–8/], [1, { page_count: 0 }, /1–8/]]) assert.match((await read(page, options)).error, expected);
  const textOnly = await read(1, { visual: true });
  assert.equal(textOnly.images, undefined);
  assert.match(textOnly.pages[0].text, /TEXT COVER/);
  assert.match(textOnly.note, /Switch to a vision/);
  const exhausted = await panel.evaluate(async bytes => {
    return (await import('./visual-test/pdf-reader.js')).readPdf(Uint8Array.from(atob(bytes), c => c.charCodeAt(0)), 1, undefined, { visual: true, vision: true, page_count: 2 });
  }, pdf([Array.from({ length: 400 }, (_, i) => `Line ${i}: ${'abcdefghij '.repeat(8)}`), ['Still has native text after the budget.']], 1).toString('base64'));
  assert.deepEqual(exhausted.noTextPages, [], 'Character budget exhaustion must not mislabel text-bearing pages as no-text');
  assert.equal(exhausted.pages[1].textStatus, 'character_limit');
  assert.equal(exhausted.images.length, 2);
  const finalChunk = await panel.evaluate(async bytes => {
    const { readPdf } = await import('./visual-test/pdf-reader.js');
    const results = [];
    for (const visual of [false, true]) {
      const result = await readPdf(Uint8Array.from(atob(bytes), c => c.charCodeAt(0)), 1, undefined, { visual, vision: true, page_count: 1 });
      results.push({ characters: result.pages[0].text.length, truncated: result.pages[0].truncated, images: result.images?.length || 0 });
    }
    return results;
  }, pdf([['T'.repeat(17000)]], 0.01).toString('base64'));
  assert.deepEqual(finalChunk, [{ characters: 16000, truncated: true, images: 0 }, { characters: 16000, truncated: true, images: 1 }]);
  async function run(name, args) {
    toolCall = { name, args };
    responsePhase = 0;
    await panel.locator('#prompt').fill('Read selected physical PDF pages, fixture transport only.');
    await panel.locator('#send').click();
    await panel.waitForFunction(() => !document.getElementById('send').disabled);
    return requests.at(-1);
  }
  const imageBlocks = request => request.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === 'image_url');
  const mainRequest = await run('inspect_tab', { visual: true, start_page: 1, page_count: 2 });
  assert.equal(imageBlocks(mainRequest).length, 2);
  assert.equal(imageBlocks(mainRequest)[1].image_url.url, `data:image/jpeg;base64,${first.images[1].data}`);
  assert.match(JSON.stringify(mainRequest), /physical page 2/);
  assert.match(JSON.stringify(mainRequest), /TEXT COVER/);
  await panel.locator('#attachment-files').setInputFiles([
    { name: 'mixed.pdf', mimeType: 'application/pdf', buffer: mixed },
    { name: 'pure-scan.pdf', mimeType: 'application/pdf', buffer: scan },
  ]);
  await panel.waitForFunction(() => !document.querySelector('#attachment-list [data-state=loading]'));
  const sourceId = await panel.locator('#attachment-list li').filter({ hasText: 'mixed.pdf' }).getAttribute('data-source-id');
  assert.equal(await panel.locator('#attachment-list li').filter({ hasText: 'pure-scan.pdf' }).getAttribute('data-state'), 'ready');
  const attachedRequest = await run('read_source', { source_id: sourceId, visual: true, start_page: 14, page_count: 2 });
  assert.equal(imageBlocks(attachedRequest).length, 4); // Earlier main read persists too.
  assert.match(JSON.stringify(attachedRequest), /physical page 14/);
  assert.match(JSON.stringify(attachedRequest), /physical page 15/);
  assert.match(JSON.stringify(attachedRequest), /Partial native caption/);
  const attachedPixels = await sampleImages(imageBlocks(attachedRequest).slice(-2).map(block => ({ data: block.image_url.url.split(',')[1] })));
  assert.ok(attachedPixels[0].red[0] > 150 && attachedPixels[0].red[2] < 60, 'Physical page 14 carries the raster diagram');
  assert.ok(attachedPixels[1].red.slice(0, 3).every(value => value > 245), 'Physical page 15 is independently checked as white');
  assert.equal(attachedPixels[1].dark, 0);
  const codeRequest = await run('codemode', { code: `text(await tools.read_source({source_id:${JSON.stringify(sourceId)},visual:true,start_page:2,page_count:1}));` });
  assert.equal(imageBlocks(codeRequest).length, 4);
  assert.match(JSON.stringify(codeRequest), /Code Mode cannot carry images/);
  const mainCodeRequest = await run('codemode', { code: 'text(await tools.inspect_tab({visual:true,start_page:2,page_count:1}));' });
  assert.equal(imageBlocks(mainCodeRequest).length, 4);
  assert.match(JSON.stringify(mainCodeRequest), /Code Mode cannot carry images/);
  const retryRequest = await run('read_source', { source_id: sourceId, visual: true, start_page: 2, page_count: 1 });
  assert.equal(imageBlocks(retryRequest).length, 5);
  assert.equal(imageBlocks(retryRequest).at(-1).image_url.url, `data:image/jpeg;base64,${first.images[1].data}`);
  const scanId = await panel.locator('#attachment-list li').filter({ hasText: 'pure-scan.pdf' }).getAttribute('data-source-id');
  const scanRequest = await run('read_source', { source_id: scanId, visual: true, page_count: 1 });
  assert.equal(imageBlocks(scanRequest).length, 6);
  assert.equal(imageBlocks(scanRequest).at(-1).image_url.url, `data:image/jpeg;base64,${first.images[1].data}`);
  assert.match(JSON.stringify(scanRequest), /pure-scan.pdf; physical page 1/);
  await panel.screenshot({ path: resolve(artifacts, 'compact-visual-result.png') });
  await worker.evaluate(async () => {
    const { modelConnection } = await chrome.storage.local.get('modelConnection');
    await chrome.storage.local.set({ modelConnection: { ...modelConnection, imageInput: false } });
  });
  await ready();
  for (const [name, args] of [['inspect_tab', { visual: true }], ['read_source', { source_id: sourceId, visual: true }]]) {
    const request = await run(name, args);
    assert.equal(imageBlocks(request).length, 0, 'Text-only adapter must not send old or new images');
    assert.match(JSON.stringify(request), /Switch to a vision/);
    assert.match(JSON.stringify(request), /TEXT COVER/);
  }
  await panel.reload(); await ready();
  assert.equal(await panel.locator('#attachment-list li').filter({ hasText: 'pure-scan.pdf' }).getAttribute('data-state'), 'ready');
  // Cancel precisely after canvas allocation, while PDF.js rendering is pending.
  const races = await panel.evaluate(async bytes => {
    const { openAttachments } = await import('./visual-test/attachments.js');
    let owns = true;
    const collection = await openAttachments({ database: 'visual-races', session: 'test', owns: () => owns, vision: () => true, changed() {} });
    const results = [];
    for (const mode of ['stop', 'remove', 'ownership', 'signal']) {
      await collection.addFiles([new File([Uint8Array.from(atob(bytes), c => c.charCodeAt(0))], 'raster.pdf')]);
      const id = collection.list().at(-1).id;
      const abort = new AbortController();
      const create = document.createElement.bind(document);
      const canvases = [];
      let triggered = false;
      document.createElement = function(tag, ...args) {
        const node = create(tag, ...args);
        if (tag === 'canvas') {
          canvases.push(node);
          if (!triggered) {
            triggered = true;
            queueMicrotask(() => {
              if (mode === 'stop') collection.cancel();
              if (mode === 'remove') void collection.remove(id);
              if (mode === 'ownership') owns = false;
              if (mode === 'signal') abort.abort();
            });
          }
        }
        return node;
      };
      let error;
      try { await collection.tools.find(tool => tool.name === 'read_source').execute({ source_id: id, visual: true, page_count: 1 }, {}, { abortSignal: abort.signal }); }
      catch (caught) { error = caught.message; }
      finally { document.createElement = create; owns = true; }
      await new Promise(resolve => setTimeout(resolve, 100));
      results.push({ mode, triggered, error, released: canvases.every(canvas => canvas.width === 0 && canvas.height === 0) });
      await collection.clear();
    }
    return results;
  }, scan.toString('base64'));
  for (const race of races) {
    assert.equal(race.triggered, true);
    assert.ok(race.error, `${race.mode} must discard render output`);
    assert.equal(race.released, true);
  }
  const timeout = await panel.evaluate(async origin => {
    const raf = window.requestAnimationFrame;
    let stalled = false;
    window.requestAnimationFrame = () => { stalled = true; return 0; };
    const started = performance.now();
    let error;
    try { await (await import('./visual-test/pdf-reader.js')).readPdf(`${origin}/mixed.pdf`, 2, undefined, { visual: true, vision: true, page_count: 1 }); }
    catch (caught) { error = caught.message; }
    finally { window.requestAnimationFrame = raf; }
    return { stalled, error, seconds: (performance.now() - started) / 1000 };
  }, origin);
  assert.equal(timeout.stalled, true);
  assert.match(timeout.error, /timed out after 30 seconds/);
  assert.ok(timeout.seconds >= 29.5 && timeout.seconds < 33);
  await worker.evaluate(async () => {
    const { modelConnection } = await chrome.storage.local.get('modelConnection');
    await chrome.storage.local.set({ modelConnection: { ...modelConnection, imageInput: true } });
  });
  await ready();
  toolCall = { name: 'inspect_tab', args: { visual: true, start_page: 2, page_count: 1 } };
  responsePhase = 0;
  await panel.evaluate(() => {
    window.savedRaf = window.requestAnimationFrame;
    window.renderStalled = false;
    window.requestAnimationFrame = () => { window.renderStalled = true; return 0; };
  });
  const beforeStop = requests.length;
  await panel.locator('#prompt').fill('Stop a real main PDF render.');
  await panel.locator('#send').evaluate(button => button.click());
  await panel.waitForFunction(() => window.renderStalled);
  await panel.locator('#stop').evaluate(button => button.click());
  await panel.waitForFunction(() => !document.getElementById('send').disabled);
  await panel.evaluate(() => { window.requestAnimationFrame = window.savedRaf; delete window.savedRaf; });
  assert.equal(requests.length, beforeStop + 1, 'Stop must not send a rendered result to the adapter');
  responsePhase = 0;
  await panel.evaluate(() => {
    window.savedRaf = window.requestAnimationFrame;
    window.renderStalled = false;
    window.heldFrames = [];
    window.requestAnimationFrame = callback => { window.renderStalled = true; window.heldFrames.push(callback); return 0; };
  });
  await panel.locator('#prompt').fill('Navigate while rendering the main PDF.');
  await panel.locator('#send').evaluate(button => button.click());
  await panel.waitForFunction(() => window.renderStalled);
  await main.goto(`${origin}/changed`);
  await panel.evaluate(() => {
    window.requestAnimationFrame = window.savedRaf;
    for (const callback of window.heldFrames) window.requestAnimationFrame(callback);
    delete window.savedRaf; delete window.heldFrames;
  });
  await panel.waitForFunction(() => !document.getElementById('send').disabled);
  assert.match(await panel.locator('article.toolResult').last().textContent(), /changed while reading/);
  assert.deepEqual(errors, []);
  const elapsedSeconds = (performance.now() - start) / 1000;
  await writeFile(resolve(artifacts, 'report.json'), JSON.stringify({ fixtureOnly: true, elapsedSeconds, pixels, races, bounded, timeout, outboundRequests: requests.length, bounds: first.pages.map(page => page.image), inspected }, null, 2));
  console.log(`PASS: mixed/scanned PDF rendering, 15-page pagination, labeled adapter images (main/file), Code Mode direct-call guidance, text-only, cancellation/removal/ownership, 30s timeout, cleanup (${elapsedSeconds.toFixed(2)}s).`);
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(done => server.close(done));
  await rm(profile, { recursive: true, force: true });
}
