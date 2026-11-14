import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

// The shared Firefox harness is integrated separately. An explicit path lets
// isolated worktree writers qualify the same unmodified shipping artifact.
const harness = process.env.ACCANTO_FIREFOX_HARNESS
  ? pathToFileURL(process.env.ACCANTO_FIREFOX_HARNESS).href
  : new URL('./test/firefox-browser.mjs', import.meta.url).href;
const { launchFirefox, By } = await import(harness);
const { fixtureServer, scripted, ready, code, tabId } = await import(new URL('./firefox-fixtures.mjs', harness));
const fixture = await fixtureServer();
let h;
try {
  h = await launchFirefox('fallback');
  await scripted(h);
  const controller = await h.driver.getWindowHandle();
  const catalogBefore = await h.evaluate(async () => (await chrome.storage.local.get('conversations')).conversations);
  const databasesBefore = await h.evaluate(async () => (await indexedDB.databases()).map(db => db.name).sort());
  await h.grantOrigins([`${fixture.origin}/*`]);
  const hostTab = await h.newTab(`${fixture.origin}/main`);
  await h.wait(() => !!document.querySelector('[data-accanto-companion]'), 'Website launcher');
  const shadow = await h.driver.findElement(By.css('[data-accanto-companion]')).getShadowRoot();
  await (await shadow.findElement(By.css('.launcher'))).click();
  await h.driver.switchTo().frame(await shadow.findElement(By.css('iframe')));
  await h.wait(() => document.body.dataset.companionFallback === 'true', 'Authenticated Firefox fallback');
  assert.equal(await h.evaluate(() => !!document.getElementById('prompt')), false);
  assert.equal(await h.evaluate(() => performance.getEntriesByType('resource').some(entry => /\/panel\.js(?:$|\?)/.test(entry.name))), false, 'No agent imports in the isolated iframe');
  const embeddedStorage = await h.evaluate(async () => ({
    databases: await indexedDB.databases(), locks: await navigator.locks.query(),
  }));
  // Firefox may expose the archive catalog already opened by the background or
  // Settings. Its existence is not an embedded runtime; no new DB may appear.
  assert.deepEqual(embeddedStorage.databases.map(db => db.name).sort(), databasesBefore, 'Launcher creates no conversation database');
  assert.deepEqual(embeddedStorage.locks.held, [], 'Launcher owns no embedded conversation lock');
  assert.deepEqual(embeddedStorage.locks.pending, []);
  await h.driver.switchTo().defaultContent();
  await h.screenshot('authenticated-fallback');
  await h.driver.switchTo().window(controller);
  assert.deepEqual(await h.evaluate(async () => (await chrome.storage.local.get('conversations')).conversations), catalogBefore, 'Authentication alone starts no conversation');
  await h.driver.switchTo().window(hostTab);
  await h.driver.switchTo().frame(await shadow.findElement(By.css('iframe')));
  await h.click('button:nth-of-type(2)');
  await h.driver.switchTo().defaultContent();
  await h.driver.wait(async () => (await shadow.findElement(By.css('.launcher'))).isDisplayed(), 10000, 'Fallback close restores launcher');
  await (await shadow.findElement(By.css('.launcher'))).click();
  await h.driver.switchTo().frame(await shadow.findElement(By.css('iframe')));
  const handles = await h.driver.getAllWindowHandles();
  await h.click('button');
  await h.driver.wait(async () => (await h.driver.getAllWindowHandles()).length > handles.length, 10000);
  const panel = (await h.driver.getAllWindowHandles()).find(handle => !handles.includes(handle));
  await h.driver.switchTo().defaultContent();
  await h.screenshot('authenticated-open-tab');
  await h.driver.switchTo().window(panel);
  await ready(h);
  const id = await tabId(h, `${fixture.origin}/main`);
  assert.equal(Number(await h.evaluate(() => new URL(location.href).searchParams.get('tab'))), id);
  assert.match(await code(h, 'text(JSON.parse(await tools.inspect_tab({})).title);'), /Firefox invoice/, 'Opened panel reads only its real source tab');
  const conversationUrl = await h.driver.getCurrentUrl();
  const duplicate = await h.newTab(conversationUrl);
  await h.wait(() => document.getElementById('panel-owner')?.hidden === false, 'Duplicate standalone cannot silently acquire ownership');
  assert.equal(await h.evaluate(() => document.getElementById('send').disabled), true);
  await h.click('#continue-here');
  await ready(h);
  assert.match(await h.text('#transcript'), /Firefox invoice/, 'Ownership transfer preserves the standalone transcript');
  await h.driver.switchTo().window(panel);
  await h.wait(() => document.getElementById('send')?.disabled, 'Original standalone relinquishes ownership');
  await h.driver.switchTo().window(duplicate);
  await h.screenshot('fallback-ownership-transfer');
  let authorized = await h.evaluate(async () => (await chrome.storage.session.get('companionDocuments')).companionDocuments);
  assert.ok(Object.keys(authorized).length);
  await h.screenshot('standalone-ready');
  await h.driver.switchTo().window(hostTab);
  await h.evaluate(() => { location.hash = 'new-section'; });
  await h.driver.switchTo().window(panel);
  await h.evaluate(keys => { window.oldDocuments = keys; }, Object.keys(authorized));
  await h.wait(async () => {
    const { companionDocuments = {} } = await chrome.storage.session.get('companionDocuments');
    return window.oldDocuments.every(id => companionDocuments[id] === undefined);
  }, 'Same-document navigation revokes fallback authorization');
  await h.driver.switchTo().window(hostTab);
  await h.wait(() => !!document.querySelector('[data-accanto-companion]'), 'Fresh launcher after same-document navigation');
  const restored = await h.driver.findElement(By.css('[data-accanto-companion]')).getShadowRoot();
  await (await restored.findElement(By.css('.launcher'))).click();
  await h.driver.switchTo().frame(await restored.findElement(By.css('iframe')));
  await h.wait(() => document.body.dataset.companionFallback === 'true', 'Fresh fallback document authorizes');
  await h.driver.switchTo().defaultContent();
  await h.driver.switchTo().window(panel);
  authorized = await h.evaluate(async () => (await chrome.storage.session.get('companionDocuments')).companionDocuments);
  assert.ok(Object.keys(authorized).length);
  // Rogue public frames cannot open a privileged panel or start an agent.
  await h.driver.switchTo().window(hostTab);
  await h.evaluate(base => {
    const frame = document.createElement('iframe');
    frame.id = 'rogue';
    frame.src = `${base}companion.html?tab=999999#continue`;
    document.body.append(frame);
  }, h.base);
  await h.driver.switchTo().frame(await h.driver.findElement(By.css('#rogue')));
  await h.wait(() => /Open Accanto using/.test(document.body.textContent) && !document.querySelector('button'), 'Rogue iframe rejection', 12000);
  assert.match((await h.evaluate(() => chrome.runtime.sendMessage({ type: 'companion-open-panel' }))).error, /not an authorized/);
  await h.driver.switchTo().defaultContent();
  await h.screenshot('rogue-rejected');
  await h.driver.navigate().refresh();
  await h.driver.switchTo().window(panel);
  await h.evaluate(keys => { window.oldDocuments = keys; }, Object.keys(authorized));
  await h.wait(async () => {
    const { companionDocuments = {} } = await chrome.storage.session.get('companionDocuments');
    return window.oldDocuments.every(id => companionDocuments[id] === undefined);
  }, 'Reload revokes fallback authorization');
  await h.newTab(`${fixture.origin}/document.pdf`);
  await h.newTab(`${h.base}panel.html?settings=1`);
  const pdfTab = await tabId(h, `${fixture.origin}/document.pdf`);
  await h.open(`panel.html?tab=${pdfTab}`);
  await ready(h);
  await h.evaluate(() => { document.getElementById('prompt').value = 'Inspect this tab'; document.getElementById('send').click(); });
  await h.wait(() => document.getElementById('status')?.textContent.includes('native PDF viewer'), 'Native PDF honest fallback');
  assert.match(await h.text('#status'), /attach the PDF file instead/);
  await h.screenshot('native-pdf-file-fallback');
  console.log('PASS Firefox fallback: exact iframe authorization, no embedded agent/storage, source-bound panel, rogue rejection, same-document/reload revocation, native PDF guidance');
} catch (error) {
  await h?.failure(error);
  process.exitCode = 1;
} finally {
  await h?.close();
  await fixture.close();
}
