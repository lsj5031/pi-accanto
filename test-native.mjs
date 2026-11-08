import { chromium } from 'playwright';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { pdf, reportPdf } from './test/pdf-fixtures.mjs';
import { browserOptions, artifactDirectory, liveModelSettings } from './test/browser.mjs';

if (process.platform !== 'win32') throw new Error('The native browser suite requires an unlocked interactive Windows desktop. Use npm run test:fixtures for portable checks.');
const model = liveModelSettings();
const artifacts = artifactDirectory('native');
await mkdir(artifacts, { recursive: true });
const pdfArtifacts = artifactDirectory('native-pdf');
await mkdir(pdfArtifacts, { recursive: true });
const profile = await mkdtemp(`${tmpdir()}/pi-native-`);
let denyPdf = false;
const server = createServer((req, res) => {
  if (req.url.includes('verification.pdf')) {
    if (denyPdf && req.headers['sec-fetch-dest'] === 'empty') { res.writeHead(403); res.end('Access expired'); return; }
    res.setHeader('Content-Type', 'application/pdf');
    res.end(req.url.includes('scan-') ? pdf([null]) : reportPdf);
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end('<!doctype html><title>Pi Tab verification</title><style>body{font:18px system-ui;max-width:650px;margin:50px auto;color:#223}textarea{width:95%;height:120px;font:18px system-ui;padding:15px}</style><h1>Local invoice draft</h1><p>Invoice NZ-427 has 3 items at $27.50 each and delivery of $8.25.</p><label for="draft">Message to customer</label><textarea id="draft">Hi Alex, your order is ready.</textarea><input type="password" id="password" value="never-read"><script>window.submissions=0;document.addEventListener("submit",()=>window.submissions++);</script>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const native = (action, ...args) => {
  try { return execFileSync('powershell.exe', ['-NoProfile', '-File', resolve('native-ui.ps1'), '-Action', action, ...args], { encoding: 'utf8', windowsHide: true }); }
  catch (error) {
    if (action !== 'screenshot') execFileSync('powershell.exe', ['-NoProfile', '-File', resolve('native-ui.ps1'), '-Action', 'screenshot', '-Path', resolve(pdfArtifacts, 'native-action-failure.png')], { windowsHide: true });
    throw error;
  }
};
let browser;
let remote;
try {
  browser = await chromium.launchPersistentContext(profile, {
    ...browserOptions,
    headless: false,
    args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`, '--force-renderer-accessibility', '--force-device-scale-factor=1', '--remote-debugging-port=0'],
    viewport: null,
  });
  const fixture = await browser.newPage();
  await fixture.goto(`http://127.0.0.1:${server.address().port}`);
  await fixture.bringToFront();
  await fixture.locator('#draft').focus();
  try {
    native('workflow');
  } catch (error) {
    native('screenshot', '-Path', resolve(artifacts, 'native-failure.png'));
    console.log(native('list'));
    throw error;
  }
  const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker');
  const [attachedTab] = await worker.evaluate(() => chrome.tabs.query({ active: true, currentWindow: true }));
  assert.match(attachedTab.url, /^http:\/\/127\.0\.0\.1:/, 'Toolbar action must grant activeTab access');
  await fixture.waitForFunction(() => document.querySelector('[data-accanto-companion]')?.getBoundingClientRect().width > 300);
  const companion = fixture.frames().find(frame => frame.url().includes('/companion.html'));
  await companion.locator('#minimize').click();
  const launcher = await fixture.locator('[data-accanto-companion]').boundingBox();
  await fixture.mouse.click(launcher.x + 26, launcher.y + 26, { button: 'right' });
  const panelOpened = browser.waitForEvent('page');
  await fixture.keyboard.press('Enter'); // Open in a tab from the companion menu.
  let panel = await panelOpened;
  const port = (await readFile(resolve(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
  remote = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  console.log('Connected browser:', remote.version());
  assert.equal(new URL(panel.url()).searchParams.get('tab'), String(attachedTab.id));
  await panel.waitForFunction(() => document.getElementById('status')?.textContent.includes('Connect your model'));
  assert.equal(await panel.locator('.product-header h1').isVisible(), true);
  await panel.screenshot({ path: resolve(artifacts, 'live-settings.png') });
  await panel.screenshot({ path: resolve(artifacts, 'conversation-setup.png') });
  const credential = model.apiKey;
  assert.equal(typeof credential, 'string');
  const requests = [];
  const responses = [];
  function observe(page) {
    page.on('request', (request) => {
      if (request.url().endsWith('/chat/completions')) {
        const body = request.postDataJSON();
        const contents = JSON.stringify(body.messages);
        requests.push({ model: body.model, roles: body.messages.map((message) => message.role), pageInput: body.messages.findLast((message) => message.role === 'user')?.content, tools: body.tools?.map((tool) => tool.function.name), passwordLeaked: contents.includes('never-read'), oldTaskPresent: contents.includes('NZ-429'), otherTaskPresent: contents.includes('YY-880') });
      }
    });
    page.on('requestfailed', request => {
      if (request.url().endsWith('/chat/completions')) responses.push({ failure: request.failure()?.errorText });
    });
    page.on('response', async (response) => {
      if (response.url().endsWith('/chat/completions')) {
        const entry = { status: response.status(), contentType: response.headers()['content-type'] };
        responses.push(entry);
        if (!response.ok()) entry.body = (await response.text().catch(() => 'Response body unavailable')).replaceAll(credential, '[REDACTED]');
      }
    });
  }
  observe(panel);
  await panel.locator('#connect-model').click();
  await panel.locator('#model-endpoint').fill(model.endpoint);
  await panel.locator('#model-id').fill(model.modelId);
  await panel.locator('#api-key').fill(credential);
  const needsModelPermission = !await worker.evaluate(origin => chrome.permissions.contains({ origins: [origin] }), `${new URL(model.endpoint).origin}/*`);
  const connected = panel.waitForEvent('load');
  await panel.locator('#connect').evaluate((button) => button.click());
  if (needsModelPermission) native('allow-site');
  await connected;
  await panel.waitForFunction(() => document.getElementById('status')?.textContent.includes('Ready'));
  await panel.waitForFunction(() => document.getElementById('send')?.disabled === false);
  assert.match(await panel.locator('#connection-status').textContent(), /Credential available/);
  await fixture.bringToFront();
  await panel.screenshot({ path: resolve(artifacts, 'live-ready.png') });
  await panel.screenshot({ path: resolve(artifacts, 'conversation-empty.png') });
  await panel.locator('#prompt').fill('Read the invoice in this tab. Calculate the total including delivery. Answer with the invoice number and total.');
  await panel.locator('#prompt').press('Control+Enter');
  await panel.waitForFunction(() => !document.getElementById('send')?.disabled, null, { timeout: 150000 });
  const report = {
    chrome: remote.version(), context: 'TAB', activeTabGranted: true,
    liveStatus: await panel.locator('#status').innerText(),
    liveTranscript: await panel.locator('#transcript').textContent(), requests, responses,
  };
  const answer = await panel.locator('article.assistant').last().innerText();
  report.liveReadPassed = /90\.75/.test(answer) && /NZ-427/i.test(answer)
    && /Attached page context captured/.test(JSON.stringify(requests[0]?.pageInput))
    && /Invoice NZ-427/.test(JSON.stringify(requests[0]?.pageInput));
  console.log('Live result:', report.liveStatus, report.liveTranscript);
  await panel.screenshot({ path: resolve(artifacts, report.liveReadPassed ? 'live-read.png' : 'live-blocked.png') });
  native('prepare');
  native('screenshot', '-Path', resolve(artifacts, 'chrome-agent-live.png'));
  native('screenshot', '-Path', resolve(artifacts, 'conversation-chrome-read.png'));
  await panel.screenshot({ path: resolve(artifacts, 'conversation-read.png') });
  if (report.liveReadPassed) {
    await panel.getByRole('button', { name: 'Copy response', exact: true }).last().click();
    await panel.getByRole('button', { name: 'Response copied', exact: true }).waitFor();
    const copied = execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'], { encoding: 'utf8', windowsHide: true });
    assert.match(copied, /NZ-427/);
    assert.match(copied, /90\.75/);
    report.clipboardCopyPassed = true;
    await panel.screenshot({ path: resolve(artifacts, 'ux-native-copy.png') });
    const readDetails = panel.locator('article.toolResult details').first();
    if (await readDetails.count()) {
      await readDetails.locator('summary').click();
      await panel.screenshot({ path: resolve(artifacts, 'conversation-details.png') });
      await readDetails.locator('summary').click();
    }
    report.liveCases = [{ invoice: 'NZ-427', total: '90.75', answer }];
    async function send(prompt) {
      const start = Date.now();
      await panel.locator('#prompt').fill(prompt);
      await panel.locator('#send').evaluate((button) => button.click());
      try {
        await panel.waitForFunction(() => !document.getElementById('send')?.disabled, null, { timeout: 150000 });
        assert.match(await panel.locator('#status').innerText(), /Reply complete/);
        return { answer: await panel.locator('article.assistant').last().innerText(), elapsedMs: Date.now() - start };
      } catch (error) {
        const status = await panel.locator('#status').innerText();
        await writeFile(resolve(artifacts, 'native-failure.json'), JSON.stringify({ prompt, error: String(error), status, requests, responses, transcript: await panel.locator('#transcript').textContent() }, null, 2));
        await panel.screenshot({ path: resolve(artifacts, 'native-failure.png') });
        throw error;
      }
    }
    for (const item of [
      { invoice: 'NZ-428', text: 'Invoice NZ-428 has 5 items at $12.40 each and delivery of $3.35.', total: '65.35' },
      { invoice: 'NZ-429', text: 'Invoice NZ-429 has 2 items at $19.95 each and delivery of $7.10.', total: '47.00' },
    ]) {
      await fixture.locator('p').evaluate((paragraph, text) => { paragraph.textContent = text; }, item.text);
      const before = requests.length;
      const result = await send('Read the invoice again: its values have changed. Calculate the total including delivery with two decimal places and give the current invoice number.');
      assert.ok(result.answer.includes(item.total), result.answer);
      assert.ok(result.answer.includes(item.invoice), result.answer);
      assert.ok(requests.length > before, 'The changed page must reach the model');
      assert.ok(JSON.stringify(requests[before].pageInput).includes(item.text), 'Each question must include a fresh page excerpt');
      report.liveCases.push({ ...item, ...result });
    }
    report.liveEdits = [];
    for (const text of [
      'Hi Alex, your invoice total is $47.00 including delivery.',
      'Hi Morgan — please review invoice NZ-429. Thank you!',
      'Draft only: payment is pending; do not send this message.',
    ]) {
      await fixture.locator('#draft').focus();
      const result = await send(`Replace the focused message field with exactly this text: ${text}`);
      assert.equal(await fixture.locator('#draft').inputValue(), text);
      assert.equal(await fixture.evaluate(() => window.submissions), 0);
      report.liveEdits.push({ text, ...result });
      if (report.liveEdits.length === 1) {
        native('prepare');
        native('screenshot', '-Path', resolve(artifacts, 'chrome-agent-live-edit.png'));
        native('screenshot', '-Path', resolve(artifacts, 'conversation-chrome-edit.png'));
        await panel.screenshot({ path: resolve(artifacts, 'conversation-edit.png') });
      }
    }
    await fixture.locator('#password').focus();
    const rejected = await send('Replace the focused password field with test-replacement.');
    assert.equal(await fixture.locator('#password').inputValue(), 'never-read');
    assert.match(rejected.answer, /cannot|can't|unable|password|sensitive|excluded/i);
    report.livePasswordExclusion = rejected;
    assert.ok(requests.every((request) => !request.passwordLeaked));
    const pending = panel.waitForRequest((request) => request.url().endsWith('/chat/completions'));
    await panel.locator('#prompt').fill('Do not use tools. Write a very long, detailed 10000-word essay about the history of typography.');
    await panel.locator('#send').evaluate((button) => button.click());
    await pending;
    await panel.screenshot({ path: resolve(artifacts, 'conversation-running.png') });
    await panel.locator('#stop').evaluate((button) => button.click());
    await panel.waitForFunction(() => !document.getElementById('send')?.disabled, null, { timeout: 15000 });
    report.cancelStatus = await panel.locator('#status').innerText();
    assert.match(report.cancelStatus, /Stopped/);
    report.recovery = await send('Reply with exactly: Ready for the next task. Do not use tools.');
    assert.match(report.recovery.answer, /Ready for the next task/);
    // Exercise the product's explicit conversation handoff to another agent tab.
    const originalPanel = panel;
    const agentOpened = browser.waitForEvent('page');
    await panel.locator('#history-menu > summary').click();
    await panel.locator('#open-conversation').click();
    panel = await agentOpened;
    await panel.waitForFunction(() => document.getElementById('status').textContent.includes('Ready'));
    observe(panel);
    assert.equal(await originalPanel.locator('#send').isDisabled(), true);
    report.followupsContext = 'TAB via Open in a tab; initial answers and controls also ran in an agent tab';
    const other = await browser.newPage();
    await other.goto(`http://127.0.0.1:${server.address().port}/other`);
    await other.evaluate(() => {
      document.title = 'Pi Tab verification · Other task';
      document.querySelector('p').textContent = 'Invoice YY-880 has 6 items at $11.20 each and delivery of $2.10.';
    });
    await other.locator('#draft').fill('Other task draft');
    await fixture.locator('#draft').focus();
    await other.bringToFront();
    const followupStart = requests.length;
    const followup = await send('Without using tools, what was the last invoice number and its total that we calculated?');
    assert.match(followup.answer, /NZ-429/);
    assert.match(followup.answer, /47\.00/);
    assert.ok(requests[followupStart].oldTaskPresent, 'Follow-up must retain previous page context');
    const inspected = await send('Inspect the attached page again. Which invoice is on it?');
    assert.match(inspected.answer, /NZ-429/);
    assert.match(JSON.stringify(requests.at(-1).pageInput), /Invoice NZ-429/);
    await panel.screenshot({ path: resolve(artifacts, 'attachment-live-followup.png') });
    await panel.reload();
    await panel.waitForFunction(() => document.getElementById('status')?.textContent.includes('Ready'));
    assert.equal(await panel.locator('#target').textContent(), 'Pi Tab verification');
    // This source tab has never received activeTab. Grant its site from Accanto.
    await panel.locator('#use-current-tab').evaluate((button) => button.click());
    await panel.waitForFunction(() => !document.getElementById('use-current-tab').disabled);
    assert.match(await panel.locator('#status').textContent(), /toolbar action/);
    assert.equal(await panel.locator('#target').textContent(), 'Pi Tab verification');
    // Approve the real broad host prompt, verify another tab can be read, then
    // revoke it and prove site-by-site approval is required again.
    await panel.locator('#connection').evaluate(element => { element.open = true; });
    await panel.locator('#all-sites').click();
    native('allow-site');
    await panel.waitForFunction(() => document.getElementById('all-sites').textContent === 'Remove all-site access');
    await panel.locator('#all-sites').scrollIntoViewIfNeeded();
    await panel.locator('#settings').screenshot({ path: resolve(artifacts, 'settings-all-sites-enabled.png') });
    assert.match(await panel.evaluate(async (url) => {
      const tab = (await chrome.tabs.query({})).find(tab => tab.url === url);
      const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => document.querySelector('p').textContent });
      return result.result;
    }, other.url()), /Invoice YY-880/);
    await panel.reload();
    await panel.waitForFunction(() => document.getElementById('status').textContent.includes('Ready'));
    assert.equal(await panel.locator('#all-sites').textContent(), 'Remove all-site access');
    await panel.locator('#connection').evaluate(element => { element.open = true; });
    await panel.locator('#all-sites').click();
    native('allow-site');
    await panel.waitForFunction(() => document.getElementById('all-sites').textContent === 'Allow all websites' && !document.getElementById('all-sites').disabled);
    assert.equal(await panel.evaluate(origin => chrome.permissions.contains({ origins: [origin, 'https://mcp.exa.ai/*'] }), `${new URL(model.endpoint).origin}/*`), true, 'Revoking broad page access must retain model/search service access');
    await panel.locator('#connection').evaluate(element => { element.open = false; });
    await panel.waitForFunction(() => !document.getElementById('site-access').hidden);
    report.allSiteAccess = { realChromeApproval: true, restoredAfterReload: true, revoked: true };
    await panel.locator('#allow-site').click();
    // Chrome may remember the earlier broad approval and restore a subset
    // without showing another native prompt. Still require actual page access.
    try {
      await panel.waitForFunction(() => document.getElementById('status').textContent.includes('Site access allowed'), null, { timeout: 1000 });
    } catch (error) {
      if (error.name !== 'TimeoutError') throw error;
      native('allow-site');
    }
    await panel.waitForFunction(() => document.getElementById('status').textContent.includes('Site access allowed'));
    await panel.locator('#use-current-tab').evaluate((button) => button.click());
    await panel.waitForFunction(() => document.getElementById('target').textContent.includes('Other task'));
    const changedStart = requests.length;
    const changed = await send('Read this invoice and calculate its total including delivery. Give the invoice number and total with two decimals.');
    assert.match(changed.answer, /YY-880/);
    assert.match(changed.answer, /69\.30/);
    assert.ok(requests.slice(changedStart).every((request) => !request.oldTaskPresent), 'Prior task must not enter model context');
    assert.match(await panel.locator('#transcript').textContent(), /NZ-429/);
    await panel.screenshot({ path: resolve(artifacts, 'attachment-live-changed.png') });
    await panel.locator('#new-conversation').evaluate((button) => button.click());
    await panel.waitForFunction(() => document.getElementById('status').textContent.includes('Chat reset'));
    assert.equal(await panel.locator('article').count(), 0);
    await panel.screenshot({ path: resolve(artifacts, 'attachment-live-new.png') });
    const freshStart = requests.length;
    await send('Reply with exactly: Fresh conversation ready. Do not use tools.');
    assert.ok(requests.slice(freshStart).every((request) => !request.oldTaskPresent));
    assert.equal(requests[freshStart].roles.filter((role) => role === 'user').length, 1, 'New chat excludes previous questions');
    assert.match(JSON.stringify(requests[freshStart].pageInput), /Invoice YY-880/, 'New chat includes its newly attached page');
    await other.close();
    await fixture.bringToFront();
    const beforeUnavailable = requests.length;
    await panel.locator('#prompt').fill('Replace the focused field with must not redirect.');
    await panel.locator('#send').evaluate((button) => button.click());
    await panel.waitForFunction(() => !document.getElementById('send').disabled);
    assert.match(await panel.locator('#status').textContent(), /attached tab is unavailable/);
    assert.equal(requests.length, beforeUnavailable, 'Unavailable target must not invoke the model');
    assert.equal(await fixture.locator('#draft').inputValue(), report.liveEdits.at(-1).text);
    await panel.screenshot({ path: resolve(artifacts, 'attachment-live-unavailable.png') });
    report.attachment = { followup, changed, preservedFollowupContext: true, oldTaskExcluded: true, nativeSiteGrant: true, newConversationClearsContext: true, closedTargetBlocked: true };
    await panel.reload();
    await panel.waitForFunction(() => document.getElementById('status')?.textContent.includes('Ready'));
    assert.match(await panel.locator('#transcript').innerText(), /Fresh conversation ready/);
    assert.doesNotMatch(await panel.locator('#transcript').innerText(), /NZ-429/);
    assert.equal(await panel.locator('#send').isEnabled(), true);
    assert.equal(await panel.locator('#api-key').inputValue(), '');
    report.liveReloadPassed = true;
    assert.ok(responses.some((response) => response.status === 200 && response.contentType.includes('text/event-stream')));

    // Real built-in PDF viewer uses the persistent site grant, with no toolbar click on this tab.
    const pdfTab = await browser.newPage();
    // Native workflow finds the browser by the PDF filename in its title.
    const pdfUrl = `http://127.0.0.1:${server.address().port}/Pi%20Tab%20verification.pdf`;
    await pdfTab.goto(pdfUrl);
    await pdfTab.bringToFront();
    await pdfTab.waitForLoadState('networkidle');
    await panel.locator('#use-current-tab').evaluate(button => button.click());
    await panel.waitForFunction(() => !document.getElementById('use-current-tab').disabled);
    assert.equal(await panel.locator('#target').getAttribute('title'), pdfUrl);
    await panel.waitForFunction(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.status === 'complete');
    await panel.locator('#new-conversation').evaluate(button => button.click());
    await panel.waitForFunction(() => !document.getElementById('new-conversation').disabled);
    assert.match(await panel.locator('#status').textContent(), /Chat reset/);
    const pdfRead = await send('Read this PDF using inspect_tab. Give the Harbour project code, total cost of both depots plus delivery, reference code and approval status. Cite physical PDF page numbers for the facts.');
    assert.match(pdfRead.answer, /H-731/);
    assert.match(pdfRead.answer, /165\.85/);
    assert.match(pdfRead.answer, /KOWHAI-92/);
    assert.match(pdfRead.answer, /pending/i);
    const pdfResult = JSON.parse(await panel.locator('article.toolResult pre').last().textContent());
    assert.deepEqual(pdfResult.pages.map(page => page.page), [1, 2, 3]);
    await panel.screenshot({ path: resolve(pdfArtifacts, 'pdf-live-answer.png') });
    native('prepare');
    native('screenshot', '-Path', resolve(pdfArtifacts, 'pdf-native-chrome.png'));
    await fixture.bringToFront();
    const pdfFollowup = await send('Inspect the attached document again and report its reference code.');
    assert.match(pdfFollowup.answer, /KOWHAI-92/);
    assert.match(await panel.locator('article.toolResult').last().textContent(), /"format":"pdf"/);
    const localPdf = resolve(profile, 'Pi Tab verification local.pdf');
    await writeFile(localPdf, reportPdf);
    await pdfTab.goto(pathToFileURL(localPdf).href);
    await pdfTab.waitForLoadState('networkidle');
    await pdfTab.bringToFront();
    const localAgentOpened = browser.waitForEvent('page');
    native('workflow');
    const localAgent = await localAgentOpened;
    await localAgent.waitForFunction(() => document.getElementById('status')?.textContent.includes('Ready'));
    await localAgent.close();
    if (await panel.locator('#continue-here').isVisible()) {
      await panel.locator('#continue-here').click();
      await panel.waitForFunction(() => document.getElementById('status')?.textContent.includes('Ready'));
    }
    await pdfTab.bringToFront();
    await panel.locator('#use-current-tab').evaluate(button => button.click());
    await panel.waitForFunction(() => !document.getElementById('use-current-tab').disabled);
    await panel.waitForFunction(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.status === 'complete');
    await panel.locator('#new-conversation').evaluate(button => button.click());
    await panel.waitForFunction(() => !document.getElementById('new-conversation').disabled);
    const localRead = await send('Read this local PDF. Give the project code and the reference code with page numbers.');
    assert.match(localRead.answer, /H-731/);
    assert.match(localRead.answer, /KOWHAI-92/);
    await panel.screenshot({ path: resolve(pdfArtifacts, 'pdf-local-live-answer.png') });
    await pdfTab.goto(`http://127.0.0.1:${server.address().port}/scan-Pi%20Tab%20verification.pdf`);
    await pdfTab.waitForLoadState('networkidle');
    await pdfTab.bringToFront();
    await panel.locator('#use-current-tab').evaluate(button => button.click());
    await panel.waitForFunction(() => !document.getElementById('use-current-tab').disabled);
    assert.match(await panel.locator('#target').getAttribute('title'), /scan-Pi%20Tab%20verification\.pdf$/);
    await panel.waitForFunction(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.status === 'complete');
    await panel.locator('#new-conversation').evaluate(button => button.click());
    await panel.waitForFunction(() => !document.getElementById('new-conversation').disabled);
    const scanRead = await send('Read this PDF and summarize its contents in at most two sentences.');
    assert.match(await panel.locator('article.toolResult').last().textContent(), /No extractable text/);
    assert.match(scanRead.answer, /no.*(?:text|extract)|cannot.*(?:read|extract)|scann|image.only|OCR/i);
    await panel.locator('#transcript').evaluate(element => { element.scrollTop += element.querySelector('article.assistant:last-child').getBoundingClientRect().top - element.getBoundingClientRect().top; });
    await panel.screenshot({ path: resolve(pdfArtifacts, 'pdf-scan-live-answer.png') });
    denyPdf = true;
    const deniedRead = await send('Try reading the attached PDF again. Explain the result in at most two sentences.');
    assert.match(await panel.locator('article.toolResult').last().textContent(), /HTTP 403/);
    assert.match(deniedRead.answer, /403|access|fetch|forbidden/i);
    await panel.locator('#transcript').evaluate(element => { element.scrollTop += element.querySelector('article.assistant:last-child').getBoundingClientRect().top - element.getBoundingClientRect().top; });
    await panel.screenshot({ path: resolve(pdfArtifacts, 'pdf-denied-live-answer.png') });
    denyPdf = false;
    report.pdf = { pdfRead, pdfFollowup, localRead, scanRead, deniedRead, toolbarGrantRequired: true, pages: pdfResult.pages.map(page => page.page) };
    await writeFile(resolve(pdfArtifacts, 'pdf-live-report.json'), JSON.stringify({ chrome: remote.version(), context: 'TAB', ...report.pdf }, null, 2));
    await pdfTab.close();
    await fixture.bringToFront();
    await writeFile(resolve(artifacts, 'native-report.json'), JSON.stringify(report, null, 2));
    console.log('PASS: live HTML controls and attachment cases; online/local PDF answers with page references, PDF follow-up while another tab active, scan honesty and fetch denial.');
  }
  assert.ok(requests.every((request) => request.model === 'main' && !request.roles.includes('developer')));
  // Check native browser tools independently if inference is blocked.
  await fixture.locator('p').evaluate((paragraph) => { paragraph.textContent = 'Invoice NZ-427 has 3 items at $27.50 each and delivery of $8.25.'; });
  await panel.locator('#connection').evaluate((details) => { details.open = true; });
  await panel.locator('.advanced > summary').click();
  await panel.locator('#mode').selectOption('scripted');
  await Promise.all([panel.waitForEvent('load'), panel.locator('#connect').evaluate((button) => button.click())]);
  await panel.waitForFunction(() => document.getElementById('status')?.textContent.includes('Ready'));
  await panel.locator('#send').evaluate((button) => button.click());
  await panel.waitForFunction(() => !document.getElementById('send')?.disabled);
  assert.match(await panel.locator('#transcript').textContent(), /Invoice NZ-427 has 3 items/);
  assert.doesNotMatch(await panel.locator('#transcript').textContent(), /never-read/);
  await fixture.locator('#draft').focus();
  await panel.locator('#prompt').fill('Type: Hi Alex, your invoice total is $90.75 including delivery.');
  await panel.locator('#send').evaluate((button) => button.click());
  await panel.waitForFunction(() => !document.getElementById('send')?.disabled);
  assert.equal(await fixture.locator('#draft').inputValue(), 'Hi Alex, your invoice total is $90.75 including delivery.');
  assert.equal(await fixture.evaluate(() => window.submissions), 0);
  native('prepare');
  native('screenshot', '-Path', resolve(artifacts, 'chrome-agent-edit.png'));
  await fixture.locator('#password').focus();
  await panel.locator('#prompt').fill('Type: must not change password');
  await panel.locator('#send').evaluate((button) => button.click());
  await panel.waitForFunction(() => !document.getElementById('send')?.disabled);
  assert.equal(await fixture.locator('#password').inputValue(), 'never-read');
  assert.match(await panel.locator('#transcript').textContent(), /Password and other sensitive field types are excluded/);
  await panel.reload();
  await panel.waitForFunction(() => document.getElementById('status')?.textContent.includes('Ready'));
  assert.match(await panel.locator('#transcript').innerText(), /Hi Alex, your invoice total is/);
  report.scriptedNativeControlsPassed = true;
  await writeFile(resolve(artifacts, 'native-report.json'), JSON.stringify(report, null, 2));
  console.log('PASS: real toolbar activeTab grant, agent tab, scripted inspection/edit/password exclusion/reload.');
  assert.ok(report.liveReadPassed, 'Live inference failed; inspect native-report.json for the actual endpoint response');
} finally {
  await remote?.close();
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
