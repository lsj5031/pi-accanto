import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, openSync, closeSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { By } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export { By };

async function executable(override, candidates, label) {
  for (const path of override ? [resolve(override)] : candidates) {
    try { await access(path, constants.X_OK); return path; } catch {}
  }
  throw new Error(`Set ${label} to an installed executable. This harness never downloads browsers or drivers.`);
}

// Uses only a fresh WebDriver-owned profile. System access is required to
// discover the *runtime* UUID and manipulate fixture-only optional grants.
// It is not a product requirement or evidence of native permission acceptance.
export async function launchFirefox(suite) {
  const artifacts = resolve(process.env.ACCANTO_ARTIFACT_DIR || resolve(root, 'test-results'), `firefox-${suite}`);
  await mkdir(artifacts, { recursive: true });
  const extension = resolve(process.env.ACCANTO_FIREFOX_EXTENSION || resolve(root, 'dist-firefox'));
  const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
  assert.ok(manifest.background?.scripts?.length, 'Build Firefox first: node build.mjs --browser=firefox');
  assert.equal(manifest.background.service_worker, undefined);
  const binary = await executable(process.env.ACCANTO_FIREFOX_BINARY, [
    '/snap/firefox/current/usr/lib/firefox/firefox', '/usr/lib/firefox/firefox',
    ...process.env.PATH.split(delimiter).map(path => resolve(path, 'firefox')),
  ], 'ACCANTO_FIREFOX_BINARY');
  const geckodriver = await executable(process.env.ACCANTO_GECKODRIVER, [
    '/snap/firefox/current/usr/lib/firefox/geckodriver',
    ...process.env.PATH.split(delimiter).map(path => resolve(path, 'geckodriver')),
  ], 'ACCANTO_GECKODRIVER');
  const hashes = {};
  for (const file of ['manifest.json', 'background.js', 'panel.js', 'companion-host.js', 'companion-bridge.js', 'codemode-worker.js', 'quickjs.wasm']) {
    hashes[file] = createHash('sha256').update(await readFile(resolve(extension, file))).digest('hex');
  }
  const scratch = await mkdtemp(resolve(artifacts, 'disposable-'));
  const downloads = resolve(scratch, 'downloads');
  await mkdir(downloads);
  const log = openSync(resolve(artifacts, 'geckodriver.log'), 'w');
  const service = new firefox.ServiceBuilder(geckodriver)
    .addArguments('--host', '127.0.0.1', '--allow-system-access', '--profile-root', scratch)
    .setStdio(['ignore', log, log]).build();
  const options = new firefox.Options().setBinary(binary)
    .setPreference('browser.download.folderList', 2)
    .setPreference('browser.download.dir', downloads)
    .setPreference('browser.download.useDownloadDir', true)
    .setPreference('browser.helperApps.neverAsk.saveToDisk', 'application/json');
  if (!process.argv.includes('--headed')) options.addArguments('-headless');
  let driver;
  let watchdog;
  const cleanup = async () => {
    clearTimeout(watchdog);
    if (driver) {
      let timer;
      try {
        await Promise.race([
          driver.quit(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Firefox quit timed out')), 5000); }),
        ]);
      } catch { await service.kill(); }
      finally { clearTimeout(timer); }
    }
    await service.kill();
    closeSync(log);
    await rm(scratch, { recursive: true, force: true });
  };
  try {
    driver = await firefox.Driver.createSession(options, service);
    await driver.manage().setTimeouts({ implicit: 0, pageLoad: 20000, script: 40000 });
    await driver.manage().window().setRect({ width: 1280, height: 960 });
    const version = (await driver.getCapabilities()).get('browserVersion');
    assert.ok(Number(version.split('.')[0]) >= 153, `Firefox ${version} is below the document-identity API floor`);
    const installed = await driver.installWebExtension(extension, { permanent: false });
    const id = installed.id;
    assert.equal(id, manifest.browser_specific_settings.gecko.id);
    const privileged = async (fn, ...args) => {
      await driver.setContext('chrome');
      try { return await evaluate(fn, ...args); }
      finally { await driver.setContext('content'); }
    };
    const evaluate = async (fn, ...args) => {
      const result = await driver.executeAsyncScript(`
        const done = arguments[arguments.length - 1];
        Promise.resolve().then(() => (${fn.toString()})(...Array.from(arguments).slice(0, -1)))
          .then(value => done({ ok: true, value: value ?? null }),
            error => done({ ok: false, error: String(error?.stack || error) }));
      `, ...args);
      if (!result) throw new Error('Firefox script context was destroyed during evaluation');
      if (!result.ok) throw new Error(result.error);
      return result.value;
    };
    const base = await privileged(id => {
      const policy = WebExtensionPolicy.getByID(id);
      if (!policy) throw new Error('Installed extension has no runtime policy');
      return policy.getURL('');
    }, id);
    assert.match(base, /^moz-extension:\/\/[^/]+\/$/);
    await writeFile(resolve(artifacts, 'environment.json'), JSON.stringify({
      version, binary, geckodriver, extension, id, base,
      hashes, temporaryInstall: true, nativePermissionDialogs: false,
    }, null, 2));
    // Hard cap includes browser commands, not just individual polling calls.
    watchdog = setTimeout(() => {
      console.error(`Firefox ${suite} exceeded 180 seconds`);
      void service.kill();
      process.exitCode = 1;
    }, 180000);
    const wait = (fn, message, timeout = 15000) => driver.wait(() => evaluate(fn), timeout, message, 100);
    const screenshot = async name => {
      const path = resolve(artifacts, `${name}.png`);
      await writeFile(path, Buffer.from(await driver.takeScreenshot(), 'base64'));
      return path;
    };
    const grantOrigins = async origins => {
      for (const origin of origins) assert.match(origin, /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/\*$/, 'Only loopback fixture grants are allowed');
      // Firefox host match patterns do not bind ports. A port-bearing pattern
      // can be stored by the internal API without actually matching requests.
      // Retain the requested pattern as well: permissions.contains/request
      // compares it differently from the network permission matcher.
      origins = [...new Set([...origins, ...origins.map(origin => `http://${new URL(origin).hostname}/*`)])];
      await privileged(async (id, origins) => {
        const { ExtensionPermissions } = ChromeUtils.importESModule('resource://gre/modules/ExtensionPermissions.sys.mjs');
        const { ExtensionParent } = ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs');
        const extension = ExtensionParent.GlobalManager.getExtension(id);
        await ExtensionPermissions.add(id, { origins, permissions: [], data_collection: [] }, extension);
      }, id, origins);
    };
    return {
      driver, base, id, artifacts, scratch, downloads, evaluate, privileged, wait, screenshot, grantOrigins, close: cleanup,
      async open(path) { await driver.get(new URL(path, base).href); },
      async newTab(url) { await driver.switchTo().newWindow('tab'); await driver.get(url); return driver.getWindowHandle(); },
      async click(css) { await driver.findElement(By.css(css)).click(); },
      async fill(css, text) { const element = await driver.findElement(By.css(css)); await element.clear(); await element.sendKeys(text); },
      async text(css) { return evaluate(css => document.querySelector(css)?.textContent || '', css); },
      async failure(error) {
        console.error(error);
        await screenshot('failure').catch(() => {});
        const status = await evaluate(() => document.getElementById('status')?.textContent || '').catch(() => '');
        if (status) console.error('Visible panel status:', status);
        // Only fixture extension errors, never the browser's global console.
        await writeFile(resolve(artifacts, 'failure.txt'), `${String(error.stack || error)}\n${status}`);
      },
    };
  } catch (error) { await cleanup(); throw error; }
}
