import { resolve } from 'node:path';
import manifest from '../manifest.json' with { type: 'json' };

// Playwright's full Chromium supports extensions in its new headless mode.
export const browserOptions = {
  channel: 'chromium',
  headless: !process.argv.includes('--headed'),
  ...(process.env.ACCANTO_CHROME_EXECUTABLE ? { executablePath: resolve(process.env.ACCANTO_CHROME_EXECUTABLE) } : {}),
};

export const artifactDirectory = (suite) => resolve(process.env.ACCANTO_ARTIFACT_DIR || 'test-results', suite);

export async function backgroundWorker(context) {
  const path = `/${manifest.background.service_worker}`;
  const matches = worker => {
    const url = new URL(worker.url());
    return url.protocol === 'chrome-extension:' && url.pathname === path;
  };
  try {
    const worker = context.serviceWorkers().find(matches)
      ?? await context.waitForEvent('serviceworker', { predicate: matches, timeout: 10000 });
    const ready = await worker.evaluate(async () => {
      const deadline = performance.now() + 5000;
      while (!globalThis.chrome?.runtime?.id && performance.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return Boolean(globalThis.chrome?.runtime?.id);
    });
    if (!ready) throw new Error(`Extension runtime unavailable in ${worker.url()} after 5s`);
    return worker;
  } catch (cause) {
    const urls = context.serviceWorkers().map(worker => worker.url());
    throw new Error(`Waiting for chrome-extension://<id>${path}. Workers: ${urls.join(', ') || 'none'}`, { cause });
  }
}

export function liveModelSettings() {
  const endpoint = process.env.ACCANTO_MODEL_ENDPOINT?.replace(/\/+$/, '');
  const modelId = process.env.ACCANTO_MODEL_ID;
  const apiKey = process.env.ACCANTO_MODEL_API_KEY;
  if (!endpoint || !modelId || !apiKey) throw new Error('Live checks require ACCANTO_MODEL_ENDPOINT, ACCANTO_MODEL_ID and ACCANTO_MODEL_API_KEY. No personal config files are read.');
  const url = new URL(endpoint);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('ACCANTO_MODEL_ENDPOINT must be an HTTP(S) base URL without embedded credentials, query or fragment.');
  return { endpoint, modelId, apiKey };
}
