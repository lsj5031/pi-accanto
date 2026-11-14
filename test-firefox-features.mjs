import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { launchFirefox } from './test/firefox-browser.mjs';
import { fixtureServer, scripted, ready, idle, send, code, attachFiles, tabId } from './test/firefox-fixtures.mjs';
import { pdf } from './test/pdf-fixtures.mjs';

const fixture = await fixtureServer();
let h;
try {
  h = await launchFirefox('features');
  await scripted(h);
  await h.grantOrigins([`${fixture.origin}/*`]);
  await h.newTab(`${fixture.origin}/main`);
  const other = await h.newTab(`${fixture.origin}/other`);
  await h.newTab(`${h.base}panel.html?settings=1`);
  const id = await tabId(h, `${fixture.origin}/main`);
  await h.open(`panel.html?tab=${id}`);
  await ready(h);
  const panel = await h.driver.getWindowHandle();
  assert.match(await code(h, 'text(6 * 7);'), /42/, 'Shipped worker must compile and run real QuickJS Wasm');
  assert.match(await code(h, 'while (true) {}'), /interrupt|budget|exceeded/i, 'Infinite computation must hit the sandbox budget');
  assert.match(await code(h, 'text(await tools.type_in_focused_field({text:"forbidden"}));'), /not.*function|not.*available|undefined|unknown|not.*tool/i, 'Code Mode must not acquire the model-only editing tool');

  const pdfBytes = pdf([['PDF-ONLY budget 283.'], ['Physical page two PINE-64.']]);
  const pdfPath = resolve(h.scratch, 'selected.pdf');
  const textPath = resolve(h.scratch, 'selected.txt');
  await writeFile(pdfPath, pdfBytes);
  await writeFile(textPath, 'TEXT-ONLY delivery 96.');
  await attachFiles(h, [pdfPath, textPath]);
  await h.wait(() => document.querySelectorAll('#attachment-list [data-state=ready]').length === 2, 'Selected PDF and text ready');
  const sourceId = name => h.evaluate(name => [...document.querySelectorAll('#attachment-list li')].find(li => li.textContent.includes(name))?.dataset.sourceId, name);
  const pdfId = await sourceId('selected.pdf');
  const read = id => code(h, `text(JSON.parse(await tools.read_source({source_id:${JSON.stringify(id)}})));`);
  const pdfResult = await read(pdfId);
  assert.match(pdfResult, /PDF-ONLY.*283/);
  assert.match(pdfResult, /PINE-64/);
  assert.match(await read(await sourceId('selected.txt')), /TEXT-ONLY.*96/);
  await h.evaluate(() => {
    const result = [...document.querySelectorAll('article.toolResult')].find(article => article.textContent.includes('PINE-64'));
    for (let element = result; element; element = element.parentElement) if (element.tagName === 'DETAILS') element.open = true;
    for (const details of result.querySelectorAll('details')) details.open = true;
    result.scrollIntoView({ block: 'center' });
  });
  await h.screenshot('selected-pdf-read');
  // Explicit picker binds a real document, then a same-URL reload invalidates it.
  await h.click('#attachment-menu > summary');
  await h.click('#choose-tab');
  await h.wait(() => !!document.querySelector('#tab-choices button'), 'Source picker ready');
  await h.driver.findElement({ xpath: '//*[@id="tab-choices"]/button[contains(., "Additional evidence")]' }).click();
  await h.wait(() => !document.getElementById('tab-picker').open, 'Explicit tab selected');
  const otherId = await sourceId('Additional evidence');
  assert.match(await read(otherId), /TAB-ONLY.*284/);
  assert.doesNotMatch(await read(otherId), /PRIVATE-FIELD/);
  await h.driver.switchTo().window(other);
  await h.driver.navigate().refresh();
  await h.driver.switchTo().window(panel);
  assert.match(await read(otherId), /select.*again|navigated|document.*changed/i);
  await h.wait(() => !!document.querySelector('#attachment-list [data-state=unavailable]'), 'Reload requires reselection');

  // Suspend a page-read response only AFTER the real Wasm worker starts.
  // This is a test-only stalled tool boundary, not a native browser failure.
  // The worker, sandbox budgets, Stop and 30-second timer remain unmodified.
  const holdRead = () => h.evaluate(() => {
    const NativeWorker = window.Worker;
    const execute = chrome.scripting.executeScript.bind(chrome.scripting);
    window.fixtureStarted = false;
    window.fixtureHeld = false;
    window.fixtureTerminated = 0;
    window.Worker = class extends NativeWorker {
      postMessage(message, ...rest) { if (message.type === 'start') window.fixtureStarted = true; return super.postMessage(message, ...rest); }
      terminate() { window.fixtureTerminated++; return super.terminate(); }
    };
    chrome.scripting.executeScript = async options => {
      const result = await execute(options);
      if (window.fixtureStarted) {
        window.fixtureHeld = true;
        await new Promise(resolve => { window.fixtureRelease = resolve; });
      }
      return result;
    };
    window.fixtureRestore = () => {
      window.Worker = NativeWorker;
      chrome.scripting.executeScript = execute;
      window.fixtureRelease?.();
    };
  });
  await holdRead();
  await send(h, 'Code: text(await tools.inspect_tab({}));');
  await h.wait(() => window.fixtureHeld, 'Real sandbox worker waits on held page read');
  await h.click('#stop');
  await h.wait(() => window.fixtureTerminated > 0, 'Stop terminates the actual worker');
  await h.evaluate(() => window.fixtureRestore());
  await idle(h);
  assert.match(await h.text('#status'), /Stopped/i);
  assert.match(await code(h, 'text(8 * 9);'), /72/, 'Fresh worker succeeds after Stop');
  await holdRead();
  const started = performance.now();
  await send(h, 'Code: text(await tools.inspect_tab({}));');
  await h.wait(() => window.fixtureHeld && window.fixtureTerminated > 0, 'Wall timeout terminates the actual worker', 36000);
  const seconds = (performance.now() - started) / 1000;
  assert.ok(seconds >= 29.5 && seconds < 36, `Actual wall timeout: ${seconds.toFixed(2)} seconds`);
  await h.evaluate(() => window.fixtureRestore());
  await idle(h);
  const timeoutResult = await h.evaluate(() => [...document.querySelectorAll('article.toolResult')].at(-1).textContent);
  assert.match(timeoutResult, /exceeded 30 seconds/i);
  assert.match(await code(h, 'text(9 * 9);'), /81/, 'Fresh worker succeeds after timeout');
  await h.evaluate(() => {
    for (const result of [...document.querySelectorAll('article.toolResult')].slice(-2)) {
      for (let element = result; element; element = element.parentElement) if (element.tagName === 'DETAILS') element.open = true;
      for (const details of result.querySelectorAll('details')) details.open = true;
    }
    document.querySelector('#transcript').scrollTop = document.querySelector('#transcript').scrollHeight;
  });
  await h.screenshot('code-mode-recovered');

  // Actual download, selected-file import and archive rendering. Synthetic
  // credential canaries must never enter the portable domain.
  await h.evaluate(() => chrome.storage.local.set({ braveKey: 'FIREFOX-SECRET-CANARY' }));
  await h.click('#connection > summary');
  await h.click('#export-backup');
  await h.wait(() => document.getElementById('backup-status')?.textContent.includes('Backup download ready'), 'Backup created');
  let backup;
  await h.driver.wait(async () => {
    try { backup = JSON.parse(await readFile(resolve(h.downloads, 'accanto-conversation.json'), 'utf8')); return true; }
    catch { return false; }
  }, 10000, 'Real backup download saved', 100);
  const encoded = JSON.stringify(backup);
  assert.doesNotMatch(encoded, /FIREFOX-SECRET-CANARY|browserSession|documentId|apiKey|endpoint|"lease"|"submission"|"task"/);
  const selected = backup.conversations[0].sources.find(source => source.name === 'selected.pdf');
  assert.equal(selected.data, pdfBytes.toString('base64'), 'Export retains the actual selected PDF bytes');
  const beforeCatalog = await h.evaluate(async () => (await chrome.storage.local.get('conversations')).conversations);
  const importPath = resolve(h.scratch, 'import.json');
  await writeFile(importPath, encoded);
  await h.driver.findElement({ css: '#backup-file' }).sendKeys(importPath);
  await h.wait(() => !document.getElementById('confirm-import').hidden, 'Backup validates');
  await h.click('#import-backup');
  await h.wait(() => document.getElementById('backup-status')?.textContent.includes('Imported 1 read-only'), 'Backup imported inertly');
  assert.deepEqual(await h.evaluate(async () => (await chrome.storage.local.get('conversations')).conversations), beforeCatalog, 'Import does not create live tasks/conversations');
  const archived = await h.evaluate(() => [...document.querySelectorAll('#conversation-list button, #conversation-list a')].map(element => ({ text: element.textContent, href: element.href })));
  // Ask the real broker for the archive catalog, not an injected archive module.
  const catalog = await h.evaluate(() => chrome.runtime.sendMessage({ type: 'conversation' }));
  const archive = catalog.conversations.find(chat => chat.title.includes('Archive'));
  assert.ok(archive, `Imported archive absent from broker catalog (${archived.length} history controls)`);
  await h.open(`panel.html?conversation=${archive.id}&web=1`);
  await h.wait(() => document.querySelector('#transcript')?.classList.contains('archived'), 'Read-only archive rendered');
  assert.equal(await h.evaluate(() => document.getElementById('send').disabled), true);
  assert.match(await h.text('#transcript'), /PINE-64/);
  await h.screenshot('read-only-import');
  await writeFile(resolve(h.artifacts, 'report.json'), JSON.stringify({ fixtureOnly: true, timeoutSeconds: seconds, selectedPdfBytes: pdfBytes.length, nativeFileInput: true, nativeDownload: true }, null, 2));
  console.log(`PASS Firefox features: Wasm, budgets, Stop, ${seconds.toFixed(2)}s timeout, selected PDF, pinned tab reload, secret-free inert backup`);
} catch (error) {
  await h?.failure(error);
  process.exitCode = 1;
} finally {
  await h?.close();
  await fixture.close();
}
