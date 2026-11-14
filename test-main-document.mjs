import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { injectedDocument } from './document-identity.js';

const source = await readFile(new URL('./panel.js', import.meta.url), 'utf8');
const handler = source.slice(source.indexOf('async function inTarget('), source.indexOf('async function showAttachment('));
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
async function setup(results, controller) {
  const calls = [];
  const chrome = { tabs: { get: async () => ({ url: 'https://example.test/new-path', status: 'complete' }) }, scripting: {
    executeScript: async options => { calls.push(options); const result = results.shift(); if (result instanceof Error) throw result; return result; },
  } };
  const inTarget = await new AsyncFunction('chrome', 'injectedDocument', 'submissionController', `
    const ownsConversation = true, browserSession = 'session';
    const attachment = { id: 7, origin: 'https://example.test', url: 'https://example.test/old-path', documentId: 'old-document', session: browserSession };
    const localFileHelp = 'Local file access needed';
    ${handler}
    return inTarget;
  `)(chrome, injectedDocument, controller);
  return { inTarget, calls };
}

test('main-page reads follow same-origin navigation but pin each operation to the current document', async () => {
  const { inTarget, calls } = await setup([
    [{ documentId: 'current-document', result: { url: 'https://example.test/new-path', origin: 'https://example.test' } }],
    [{ documentId: 'current-document', result: { text: 'current invoice' } }],
  ]);
  assert.deepEqual(await inTarget(() => ({ text: 'unused mock' })), { text: 'current invoice' });
  assert.deepEqual(structuredClone(calls[1].target), { tabId: 7, documentIds: ['current-document'] });
});

test('Stop during document binding cannot start a later page read', async () => {
  let release;
  const identity = new Promise(resolve => { release = resolve; });
  const controller = new AbortController();
  const { inTarget, calls } = await setup([identity], controller);
  const reading = inTarget(() => ({}));
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  release([{ documentId: 'current-document', result: { url: 'https://example.test/new-path' } }]);
  await assert.rejects(reading, { name: 'AbortError' });
  assert.equal(calls.length, 1, 'Only identity, never the cancelled content read');
});

test('missing identity and navigation during injection never return page text', async () => {
  for (const identity of [[], [{ result: { url: 'https://example.test/new-path' } }]]) {
    const { inTarget, calls } = await setup([identity]);
    await assert.rejects(inTarget(() => ({})), /securely/);
    assert.equal(calls.length, 1);
  }
  const { inTarget } = await setup([
    [{ documentId: 'current-document', result: { url: 'https://example.test/new-path' } }],
    new Error('No such document'),
  ]);
  await assert.rejects(inTarget(() => ({})), /changed while reading/);
});
