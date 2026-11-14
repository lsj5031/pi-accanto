import assert from 'node:assert/strict';
import { launchFirefox, By } from './test/firefox-browser.mjs';
import { fixtureServer, scripted, tabId } from './test/firefox-fixtures.mjs';

const fixture = await fixtureServer();
let h;
try {
  h = await launchFirefox('security');
  await scripted(h);
  const page = await h.newTab(`${fixture.origin}/main`);
  const controller = await h.newTab(`${h.base}panel.html?settings=1`);
  const id = await tabId(h, `${fixture.origin}/main`);
  const denied = await h.evaluate(async tabId => {
    try {
      const results = await chrome.scripting.executeScript({ target: { tabId }, func: () => document.title });
      return results.map(result => ({ error: String(result.error || ''), result: result.result }));
    } catch (error) { return { error: String(error) }; }
  }, id);
  assert.match(JSON.stringify(denied), /permission|access|host|Missing/i, 'No grant must prevent injection');
  await h.grantOrigins([`${fixture.origin}/*`]);
  await h.wait(async () => (await chrome.scripting.getRegisteredContentScripts()).some(script => script.id === 'accanto-companion' && script.matches.includes('http://127.0.0.1/*')), 'Background registers granted origin');
  // Firefox must supply non-empty exact document identity, not just tab/frame.
  const identities = await h.evaluate(tabId => chrome.scripting.executeScript({ target: { tabId }, func: () => document.title }), id);
  assert.equal(typeof identities[0].documentId, 'string');
  assert.ok(identities[0].documentId.length);
  await h.driver.switchTo().window(page);
  await h.driver.navigate().refresh();
  await h.wait(() => !!document.querySelector('[data-accanto-companion]'), 'Granted companion launcher');
  const shadow = await h.driver.findElement(By.css('[data-accanto-companion]')).getShadowRoot();
  await (await shadow.findElement(By.css('.launcher'))).click();
  await h.driver.switchTo().frame(await shadow.findElement(By.css('iframe')));
  // Embedded Firefox chat is deliberately unsupported. The authenticated frame
  // is only a launcher; the companion-to-tab and ownership behavior is exercised
  // by test-browser-fallback.mjs, not an assumed shared iframe storage domain.
  await h.wait(() => document.body.dataset.companionFallback === 'true', 'Exact legitimate fallback authorizes');
  assert.equal(await h.evaluate(() => !!document.getElementById('prompt')), false);
  await h.driver.switchTo().defaultContent();
  await h.driver.switchTo().window(page);
  await h.screenshot('authorized-companion');
  await h.driver.switchTo().window(controller);
  const documents = await h.evaluate(async () => (await chrome.storage.session.get('companionDocuments')).companionDocuments);
  assert.ok(Object.keys(documents).length);
  assert.equal(documents.undefined, undefined);
  assert.ok(Object.values(documents).includes(id));
  await h.driver.switchTo().window(page);
  // Page-created same-extension iframe with forged query and challenge cannot
  // inherit the exact isolated host's authorization.
  await h.evaluate(base => {
    const rogue = document.createElement('iframe');
    rogue.id = 'rogue';
    rogue.src = `${base}companion.html?tab=999999&conversation=forged#continue`;
    document.body.append(rogue);
    addEventListener('message', event => {
      if (event.data?.type === 'accanto-challenge') rogue.contentWindow.postMessage(event.data, '*');
    });
  }, h.base);
  await h.driver.switchTo().frame(await h.driver.findElement(By.css('#rogue')));
  await h.wait(() => /Open Accanto/.test(document.body.textContent) && !document.querySelector('#prompt'), 'Rogue frame rejected', 12000);
  assert.notEqual(await h.evaluate(() => document.body.dataset.embedded), 'true');
  const rogueBroker = await h.evaluate(() => chrome.runtime.sendMessage({ type: 'conversation', tabId: 999999 }));
  assert.match(rogueBroker.error, /not an authorized/i);
  const handles = await h.driver.getAllWindowHandles();
  for (const type of ['companion-open-panel', 'companion-fallback-ready', 'companion-fallback-close']) {
    assert.match((await h.evaluate(type => chrome.runtime.sendMessage({ type }), type)).error, /not an authorized/i);
  }
  assert.deepEqual(await h.driver.getAllWindowHandles(), handles, 'Rogue actions cannot open a panel');
  console.log('Verified legitimate document authorization and rogue iframe rejection');
  await h.driver.switchTo().defaultContent();
  await h.screenshot('rogue-frame-rejected');
  // Reload invalidates the former document even when its URL stays the same.
  await h.driver.switchTo().window(controller);
  await h.evaluate(async tabId => {
    window.previousDocument = (await chrome.scripting.executeScript({ target: { tabId }, func: () => document.title }))[0].documentId;
  }, id);
  await h.driver.switchTo().window(page);
  await h.driver.navigate().refresh();
  await h.driver.switchTo().window(controller);
  const stale = await h.evaluate(async tabId => {
    try {
      const result = await chrome.scripting.executeScript({ target: { tabId, documentIds: [window.previousDocument] }, func: () => document.title });
      return result.map(item => ({ error: String(item.error || ''), result: item.result }));
    } catch (error) { return { error: String(error) }; }
  }, id);
  assert.doesNotMatch(JSON.stringify(stale), /Firefox invoice/, 'Stale document target must never reach replacement document');
  await h.evaluate(keys => { window.previousAuthorizations = keys; }, Object.keys(documents));
  await h.wait(async () => {
    const { companionDocuments = {} } = await chrome.storage.session.get('companionDocuments');
    return window.previousAuthorizations.every(key => companionDocuments[key] === undefined);
  }, 'Reload revokes old companion authorization');
  const afterReload = await h.evaluate(async () => (await chrome.storage.session.get('companionDocuments')).companionDocuments || {});
  for (const key of Object.keys(documents)) assert.equal(afterReload[key], undefined, 'Reload revokes old companion authorization');
  await h.driver.switchTo().window(page);
  await h.wait(() => !!document.querySelector('[data-accanto-companion]'), 'Reload creates a fresh launcher');
  const fresh = await h.driver.findElement(By.css('[data-accanto-companion]')).getShadowRoot();
  await (await fresh.findElement(By.css('.launcher'))).click();
  await h.driver.switchTo().frame(await fresh.findElement(By.css('iframe')));
  await h.wait(() => document.body.dataset.companionFallback === 'true', 'Fresh document authorizes independently');
  await h.driver.switchTo().defaultContent();
  await h.driver.switchTo().window(controller);
  const liveDocuments = await h.evaluate(async () => (await chrome.storage.session.get('companionDocuments')).companionDocuments);
  assert.ok(Object.keys(liveDocuments).length, 'Revocation exercises a live authorization');
  // Genuine removal, not a stubbed permissions API.
  await h.evaluate(origin => chrome.permissions.remove({ origins: ['http://127.0.0.1/*', `${origin}/*`] }), fixture.origin);
  await h.wait(async () => !(await chrome.scripting.getRegisteredContentScripts()).some(script => script.matches.some(match => match.includes('127.0.0.1'))), 'Revocation unregisters fixture origin');
  await h.evaluate(keys => { window.revokedDocuments = keys; }, Object.keys(liveDocuments));
  await h.wait(async () => {
    const { companionDocuments = {} } = await chrome.storage.session.get('companionDocuments');
    return window.revokedDocuments.every(key => companionDocuments[key] === undefined);
  }, 'Permission removal revokes the live exact-frame authorization');
  const revoked = await h.evaluate(async tabId => {
    try { return await chrome.scripting.executeScript({ target: { tabId }, func: () => document.title }); }
    catch (error) { return { error: String(error) }; }
  }, id);
  assert.doesNotMatch(JSON.stringify(revoked), /Firefox invoice/);
  await h.driver.switchTo().window(page);
  await h.wait(() => !document.querySelector('[data-accanto-companion]'), 'Revocation removes the existing companion');
  await h.screenshot('permission-revoked');
  console.log('Verified stale-document rejection, reload authorization cleanup, and real permission revocation');
  console.log('PASS Firefox security: grant/injection failure, exact fallback document, rogue broker/actions denied, stale targeting, reload and live permission revocation');
} catch (error) {
  await h?.failure(error);
  process.exitCode = 1;
} finally {
  await h?.close();
  await fixture.close();
}
