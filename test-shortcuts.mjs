import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { artifactDirectory, browserOptions } from './test/browser.mjs';

if (process.platform !== 'win32') throw new Error('Native shortcuts require an unlocked interactive Windows desktop.');
const artifacts = artifactDirectory('shortcuts');
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(`${tmpdir()}/accanto-shortcuts-`);
const title = `Pi Tab verification shortcuts ${Date.now()}`;
const native = (action, ...args) => execFileSync('powershell.exe', ['-NoProfile', '-File', resolve('native-ui.ps1'), '-WindowTitle', `*${title}*`, '-Action', action, ...args], { windowsHide: true, encoding: 'utf8' });
const keys = value => native('shortcut', '-Keys', value);
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><title>${title}</title><style>body{font:18px system-ui;margin:64px;color:#30432d}input{font:inherit;padding:12px}</style><h1>Keyboard shortcuts</h1><p>This isolated page tests real Windows keyboard input.</p><label>Website input <input id="website"></label>`);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
let browser;
try {
  browser = await chromium.launchPersistentContext(profile, {
    ...browserOptions, headless: false, viewport: null,
    args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`, '--force-renderer-accessibility', '--force-device-scale-factor=1'],
  });
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
  await worker.evaluate(() => chrome.storage.local.set({ mode: 'scripted' }));
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.bringToFront();
  native('prepare');
  const assignments = await worker.evaluate(() => chrome.commands.getAll());
  console.log('Chrome assignments:', assignments);
  assert.equal(assignments.some(command => command.name === 'adjust-companion'), false, 'Move/resize must not register a shortcut');
  for (const [name, shortcut] of Object.entries({ _execute_action: 'Alt+Shift+Q', 'enlarge-chat': 'Alt+Shift+D', 'open-chat-tab': 'Alt+Shift+S' })) {
    assert.equal(assignments.find(command => command.name === name)?.shortcut, shortcut, `${name} must actually be assigned by Chrome`);
  }
  // These are OS keystrokes, not Playwright/CDP key events. No site grant is
  // preinstalled: opening must also grant Chrome's temporary activeTab access.
  await page.locator('#website').focus();
  keys('%+q');
  await page.waitForFunction(() => document.querySelector('[data-accanto-companion]')?.getBoundingClientRect().width > 300);
  const chat = page.frames().find(frame => frame.url().includes('/companion.html'));
  await chat.waitForFunction(() => document.getElementById('status')?.textContent.includes('Ready'));
  const bounds = () => page.locator('[data-accanto-companion]').boundingBox();
  const original = await bounds();
  await chat.locator('#prompt').fill('An unsent draft survives window shortcuts');
  await page.locator('#website').focus();
  keys('%+d');
  await page.waitForFunction(() => document.querySelector('[data-accanto-companion]').getBoundingClientRect().width === 900);
  await page.screenshot({ path: resolve(artifacts, 'enlarged.png') });
  await chat.locator('#prompt').focus();
  keys('%+d');
  await page.waitForFunction(width => document.querySelector('[data-accanto-companion]').getBoundingClientRect().width === width, original.width);
  assert.deepEqual(await bounds(), original);
  assert.equal(await chat.locator('#prompt').inputValue(), 'An unsent draft survives window shortcuts');
  await page.screenshot({ path: resolve(artifacts, 'compact.png') });
  await chat.locator('#open-shortcuts').click();
  for (const [id, shortcut] of Object.entries({ 'open-shortcut': 'Alt+Shift+Q', 'enlarge-key': 'Alt+Shift+D', 'tab-shortcut': 'Alt+Shift+S' })) {
    await chat.waitForFunction(({ id, shortcut }) => document.getElementById(id).textContent === shortcut, { id, shortcut });
  }
  await page.screenshot({ path: resolve(artifacts, 'help.png') });
  await chat.getByRole('button', { name: 'Close keyboard shortcuts' }).click();
  const conversation = new URL(chat.url()).searchParams.get('conversation');
  await page.locator('#website').focus();
  const opened = browser.waitForEvent('page');
  keys('%+s');
  const tab = await opened;
  await tab.waitForFunction(() => document.getElementById('status')?.textContent.includes('Ready'));
  assert.equal(new URL(tab.url()).searchParams.get('conversation'), conversation);
  // Keep a unique native window title when the standalone extension tab is active.
  await tab.evaluate(title => { document.title = title; }, title);
  const standaloneOpened = browser.waitForEvent('page');
  keys('%+s');
  const continued = await standaloneOpened;
  await continued.waitForFunction(() => document.getElementById('status')?.textContent.includes('Ready'));
  assert.equal(new URL(continued.url()).searchParams.get('conversation'), conversation);
  assert.equal(browser.pages().filter(page => page.url().includes('/panel.html')).length, 2, 'One command must create one destination, even with multiple panels open');
  const report = { browser: browser.browser().version(), input: 'Windows SendKeys to verified foreground test window', assignments, open: true, activeTabGrant: true, enlargeFromWebsite: true, restoreFromChat: true, openChatFromWebsite: true, openChatFromStandalone: true };
  await writeFile(resolve(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  console.log('PASS: native Chrome shortcuts, website/chat focus, activeTab grant, enlarge/restore and single-destination conversation handoff.');
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
  await rm(profile, { recursive: true, force: true });
}
