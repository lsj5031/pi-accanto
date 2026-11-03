import { resolve } from 'node:path';

// Playwright's full Chromium supports extensions in its new headless mode.
export const browserOptions = {
  channel: 'chromium',
  headless: !process.argv.includes('--headed'),
  ...(process.env.ACCANTO_CHROME_EXECUTABLE ? { executablePath: resolve(process.env.ACCANTO_CHROME_EXECUTABLE) } : {}),
};

export const artifactDirectory = (suite) => resolve(process.env.ACCANTO_ARTIFACT_DIR || 'test-results', suite);

export function liveModelSettings() {
  const endpoint = process.env.ACCANTO_MODEL_ENDPOINT?.replace(/\/+$/, '');
  const modelId = process.env.ACCANTO_MODEL_ID;
  const apiKey = process.env.ACCANTO_MODEL_API_KEY;
  if (!endpoint || !modelId || !apiKey) throw new Error('Live checks require ACCANTO_MODEL_ENDPOINT, ACCANTO_MODEL_ID and ACCANTO_MODEL_API_KEY. No personal config files are read.');
  const url = new URL(endpoint);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('ACCANTO_MODEL_ENDPOINT must be an HTTP(S) base URL without embedded credentials, query or fragment.');
  return { endpoint, modelId, apiKey };
}
