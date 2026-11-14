import assert from 'node:assert/strict';
import { launchFirefox } from './test/firefox-browser.mjs';
import { fixtureServer, scripted, ready, idle, send, tabId } from './test/firefox-fixtures.mjs';

const fixture = await fixtureServer();
let h;
try {
  h = await launchFirefox('pdf-viewer');
  await scripted(h);
  await h.grantOrigins([`${fixture.origin}/*`]);
  await h.newTab(`${fixture.origin}/document.pdf`);
  await h.wait(() => document.contentType === 'application/pdf', 'Firefox native PDF viewer');
  await h.screenshot('native-viewer');
  await h.newTab(`${h.base}panel.html?settings=1`);
  const id = await tabId(h, `${fixture.origin}/document.pdf`);
  const injection = await h.evaluate(async tabId => {
    try { return await chrome.scripting.executeScript({ target: { tabId }, func: () => document.contentType }); }
    catch (error) { return { error: String(error) }; }
  }, id);
  assert.match(JSON.stringify(injection), /error/i, 'Native viewer remains injection-restricted despite host grant');
  await h.open(`panel.html?tab=${id}`);
  await ready(h);
  await send(h, 'Summarize this PDF.');
  await idle(h);
  const feedback = await h.text('#status');
  assert.match(feedback, /Firefox.*PDF|PDF.*Firefox/i);
  assert.match(feedback, /attach.*file|file.*attach/i, 'Failure must offer the supported explicit-file path');
  assert.doesNotMatch(await h.text('#transcript'), /Scripted compatibility check finished/, 'Do not pretend to read the native viewer');
  await h.screenshot('honest-file-fallback');
  console.log('PASS Firefox native PDF restriction and honest explicit-file fallback');
} catch (error) {
  await h?.failure(error);
  process.exitCode = 1;
} finally {
  await h?.close();
  await fixture.close();
}
