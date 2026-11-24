import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { chromium } from 'playwright';
import { backgroundWorker, browserOptions } from './test/browser.mjs';

test('background worker selection ignores unrelated cached and arriving workers', async () => {
  const workers = [
    'https://fixture.example/background.js',
    'chrome-extension://fixture/other.js',
    'chrome-extension://fixture/background.js',
  ].map(url => ({ url: () => url, evaluate: () => true }));
  assert.equal(await backgroundWorker({ serviceWorkers: () => workers }), workers[2]);
  assert.equal(await backgroundWorker({
    serviceWorkers: () => workers.slice(0, 2),
    waitForEvent: (event, { predicate }) => {
      assert.equal(event, 'serviceworker');
      return workers.find(predicate);
    },
  }), workers[2]);
});

test('background worker waits for delayed runtime readiness without worker timers', async () => {
  const startup = [undefined, { runtime: {} }, { runtime: { id: 'fixture' } }];
  const worker = {
    url: () => 'chrome-extension://fixture/background.js',
    evaluate: probe => runInNewContext(`(${probe})()`, { chrome: startup.shift(), performance }),
  };
  assert.equal(await backgroundWorker({ serviceWorkers: () => [worker] }), worker);
  assert.equal(startup.length, 0);
});

test('background worker reports the selected worker when its probe stalls', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const url = 'chrome-extension://fixture/background.js';
  const worker = { url: () => url, evaluate: () => new Promise(() => {}) };
  const result = backgroundWorker({ serviceWorkers: () => [worker] });
  context.mock.timers.tick(5000);
  await assert.rejects(result, {
    message: `Waiting for chrome-extension://<id>/background.js. Workers: ${url}`,
    cause: new Error(`Extension runtime unavailable in ${url} after 5s`),
  });
});

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
        const worker = await backgroundWorker(browser);
        assert.equal(await worker.evaluate(() => chrome.runtime.id), 'iojliefpiallbakabkahmiaadgmlfjkf');
        assert.equal(new URL(worker.url()).host, 'iojliefpiallbakabkahmiaadgmlfjkf');
      } finally { await browser.close(); }
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
