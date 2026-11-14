import assert from 'node:assert/strict';
import { launchFirefox } from './test/firefox-browser.mjs';
import { fixtureServer, ready, idle, send, tabId } from './test/firefox-fixtures.mjs';

const fixture = await fixtureServer();
let h;
try {
  h = await launchFirefox('smoke');
  await h.open('panel.html?settings=1');
  await h.wait(() => !!document.getElementById('installed-version')?.textContent, 'Settings startup');
  assert.equal(await h.evaluate(() => document.getElementById('model-endpoint').value), '');
  // Grants use Firefox's permission implementation in this isolated profile.
  // Native permission prompts and toolbar activeTab are NOT simulated as passed.
  await h.grantOrigins([`${fixture.origin}/*`, `${fixture.modelOrigin}/*`]);
  await h.fill('#model-endpoint', `${fixture.modelOrigin}/v1`);
  await h.fill('#model-id', 'firefox-fixture');
  await h.fill('#api-key', 'synthetic-firefox-key');
  await h.click('#connect');
  await h.wait(() => document.getElementById('connection-status')?.dataset.state === 'configured', 'Synthetic catalog connection');
  await h.screenshot('model-configured');
  await h.newTab(`${fixture.origin}/main`);
  await h.newTab(`${fixture.origin}/other`);
  await h.newTab(`${h.base}panel.html?settings=1`);
  const id = await tabId(h, `${fixture.origin}/main`);
  assert.ok(Number.isInteger(id));
  await h.open(`panel.html?tab=${id}`);
  await ready(h);
  const owner = await h.driver.getWindowHandle();
  const conversationUrl = await h.driver.getCurrentUrl();
  const state = await h.evaluate(() => Promise.all([
    chrome.storage.local.get('conversations'), chrome.storage.session.get('browserSession'),
  ]));
  assert.ok(Object.keys(state[0].conversations).length, 'Real background broker created a conversation');
  assert.equal(typeof state[1].browserSession, 'string');
  await send(h, 'Read the invoice, then give a streamed synthetic answer.');
  await h.wait(() => document.getElementById('transcript')?.textContent.includes('Synthetic streamed answer:'), 'Incremental response visible');
  assert.equal(await h.evaluate(() => document.getElementById('send').disabled), true, 'Stream remains active before final chunk');
  await h.screenshot('streaming');
  fixture.release();
  await idle(h);
  assert.match(await h.text('#transcript'), /invoice NZ-427 totals \$183\.75/);
  assert.equal(fixture.requests.length, 2, 'Real tool execution precedes the second model request');
  assert.equal(fixture.requests[0].authorization, 'Bearer synthetic-firefox-key');
  const tool = fixture.requests[1].input.messages.find(message => message.role === 'tool');
  assert.match(JSON.stringify(tool), /NZ-427.*183\.75/);
  assert.doesNotMatch(JSON.stringify(tool), /PASSWORD-EXCLUDED|TAB-ONLY|PRIVATE-FIELD/);
  await h.screenshot('conversation');
  // Actual shared IndexedDB, BroadcastChannel and Web Locks ownership transfer.
  await h.newTab(conversationUrl);
  await h.wait(() => document.getElementById('panel-owner')?.hidden === false, 'Second panel cannot take ownership silently');
  assert.equal(await h.evaluate(() => document.getElementById('send').disabled), true);
  await h.click('#continue-here');
  await ready(h);
  assert.match(await h.text('#transcript'), /invoice NZ-427 totals \$183\.75/);
  await h.screenshot('ownership-transfer');
  await h.driver.switchTo().window(owner);
  await h.wait(() => document.getElementById('send')?.disabled, 'Previous owner relinquishes control');
  console.log('PASS Firefox smoke: background, local streaming, bounded page evidence, shared conversation ownership');
} catch (error) {
  await h?.failure(error);
  process.exitCode = 1;
} finally {
  await h?.close();
  await fixture.close();
}
