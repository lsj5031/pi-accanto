import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Run the production handler with controlled Chrome API completions. These
// exercise feedback races, not Chrome's native permission prompt.
const source = await readFile(new URL('./panel.js', import.meta.url), 'utf8');
const handler = source.slice(source.indexOf('  let allSitesAllowed = false;'), source.indexOf('  const searchConfig ='));
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function setup(initiallyAllowed = false) {
  let allowed = initiallyAllowed;
  const elements = { 'all-sites': { addEventListener: (_, fn) => { elements.click = fn; } }, 'access-status': {} };
  const listeners = [];
  const requests = [];
  const pendingContains = [];
  let delayContains = false;
  const chrome = {
    permissions: {
      contains: () => {
        if (!delayContains) return Promise.resolve(allowed);
        const result = deferred();
        pendingContains.push({ ...result, allowed });
        return result.promise;
      },
      request: options => {
        const result = deferred();
        requests.push({ ...result, options });
        return result.promise;
      },
      remove: async () => { allowed = false; listeners.forEach(fn => fn()); },
      onAdded: { addListener: fn => listeners.push(fn) },
      onRemoved: { addListener: fn => listeners.push(fn) },
    },
    runtime: { getManifest: () => ({ host_permissions: ['file:///*', 'https://mcp.exa.ai/*'] }) },
    storage: { local: { get: async () => ({}) }, session: { get: async () => ({}) } },
  };
  await new AsyncFunction('$', 'chrome', 'allSiteOrigins', 'endpoint', 'searchOrigins', 'showAttachment', handler)(
    id => elements[id], chrome, ['http://*/*', 'https://*/*'], 'https://model.example/v1', { exa: 'https://mcp.exa.ai/*' }, async () => {},
  );
  return {
    elements, requests, pendingContains,
    change: value => { allowed = value; listeners.forEach(fn => fn()); },
    delayContains: () => { delayContains = true; },
  };
}

test('first request, denial, retry, and grant show current feedback', async () => {
  const { elements, requests, change } = await setup();
  const first = elements.click();
  assert.equal(requests.length, 1, 'Request must run synchronously inside the click gesture');
  assert.equal(elements['all-sites'].disabled, true);
  assert.match(elements['access-status'].textContent, /Confirm website access in Chrome/);
  await elements.click();
  assert.equal(requests.length, 1, 'Repeated clicks must not start overlapping requests');
  requests[0].resolve(false);
  await first;
  assert.match(elements['access-status'].textContent, /declined/);
  assert.equal(elements['all-sites'].disabled, false);
  const retry = elements.click();
  assert.match(elements['access-status'].textContent, /Confirm website access in Chrome/);
  assert.doesNotMatch(elements['access-status'].textContent, /declined/);
  change(true);
  await Promise.resolve();
  assert.match(elements['access-status'].textContent, /Confirm website access in Chrome/);
  requests[1].resolve(true);
  await retry;
  assert.match(elements['access-status'].textContent, /All websites allowed/);
  assert.equal(elements['all-sites'].disabled, false);
  assert.equal(elements['all-sites'].textContent, 'Remove all-site access');
});

test('removal events preserve service reconfirmation, even when they finish late', async () => {
  const { elements, requests, pendingContains, delayContains } = await setup(true);
  delayContains();
  const removal = elements.click();
  // Storage reads and removal precede service reconfirmation.
  for (let i = 0; i < 10 && !requests.length; i++) await Promise.resolve();
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].options.origins, ['https://mcp.exa.ai/*', 'https://model.example/*']);
  assert.match(elements['access-status'].textContent, /Confirm model and search service access/);
  assert.equal(elements['all-sites'].disabled, true);
  requests[0].resolve(false);
  await removal;
  assert.match(elements['access-status'].textContent, /Website access removed. Reconnect/);
  for (const result of pendingContains) result.resolve(result.allowed);
  await Promise.resolve();
  assert.match(elements['access-status'].textContent, /Website access removed. Reconnect/);
  assert.equal(elements['all-sites'].disabled, false);
});
