import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { browserOptions } from './test/browser.mjs';

test('Chrome assigns the same ID to builds installed at different paths', { timeout: 60000 }, async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), 'accanto-identity-'));
  try {
    for (const name of ['first-install', 'another-computer-path']) {
      const extension = resolve(scratch, name);
      await cp(resolve(import.meta.dirname, 'dist'), extension, { recursive: true });
      const browser = await chromium.launchPersistentContext(resolve(scratch, `${name}-profile`), {
        ...browserOptions,
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
      });
      try {
        await browser.route(/^https?:\/\//, route => route.abort('blockedbyclient'));
        const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker');
        assert.equal(await worker.evaluate(() => chrome.runtime.id), 'iojliefpiallbakabkahmiaadgmlfjkf');
        assert.equal(new URL(worker.url()).host, 'iojliefpiallbakabkahmiaadgmlfjkf');
      } finally { await browser.close(); }
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
