import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { validDocumentId } from './document-identity.js';

// Drive the production message/event handlers, with deterministic browser-owned
// identities and controlled host responses. Real browser coverage is separate.
const source = (await readFile(new URL('./background.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });
const tick = () => new Promise(resolve => setImmediate(resolve));
async function setup() {
  const store = {};
  const timers = new Map();
  let timerId = 0;
  let hostReply = {};
  const sent = [];
  let writeGate;
  const chrome = {
    action: { onClicked: event() }, commands: { onCommand: event() },
    scripting: { getRegisteredContentScripts: async () => [] },
    permissions: { getAll: async () => ({}), onAdded: event(), onRemoved: event() },
    storage: {
      session: {
        get: async keys => structuredClone(Object.fromEntries((typeof keys === 'string' ? [keys] : keys || Object.keys(store)).filter(key => key in store).map(key => [key, store[key]]))),
        set: async data => {
          if (writeGate) { const gate = writeGate; writeGate = undefined; gate.started(); await gate.promise; }
          Object.assign(store, structuredClone(data));
        },
      },
      local: { get: async () => ({}) }, onChanged: event(),
    },
    tabs: { query: async () => [], onUpdated: event(), onRemoved: event(), sendMessage: async (_id, message) => { sent.push(message); return hostReply; } },
    runtime: { id: 'extension', getManifest: () => ({}), getURL: path => `moz-extension://fixture/${path}`, onMessage: event() },
  };
  vm.runInNewContext(source, {
    chrome, crypto: globalThis.crypto, validDocumentId, listArchives: async () => [],
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: id => timers.delete(id),
  });
  await tick();
  const sender = { id: 'extension', url: 'moz-extension://fixture/companion.html', frameId: 2, tab: { id: 7 }, documentId: 'document-A' };
  const message = (data, from = sender) => new Promise(resolve => chrome.runtime.onMessage.listeners[0](data, from, value => resolve(structuredClone(value))));
  return {
    chrome, store, sender, message, timers, sent, host: value => { hostReply = value; },
    pauseWrite() {
      let release;
      let started;
      const promise = new Promise(resolve => { release = resolve; });
      const reached = new Promise(resolve => { started = resolve; });
      writeGate = { promise, started };
      return { reached, release };
    },
  };
}

test('missing document identity cannot authorize or read a conversation', async () => {
  const { message, sender, store } = await setup();
  for (const documentId of [undefined, null, '', 'invalid document']) {
    const invalid = { ...sender, documentId };
    assert.match((await message({ type: 'companion-authorize' }, invalid)).error, /identity/);
    assert.match((await message({ type: 'conversation' }, invalid)).error, /not an authorized/);
  }
  assert.equal(store.companionDocuments, undefined);
});

test('only the exact retained host iframe can complete authorization', async () => {
  const fixture = await setup();
  fixture.host({ documentId: 'rogue-document' });
  let resolved = false;
  const pending = fixture.message({ type: 'companion-authorize' }).then(value => { resolved = true; return value; });
  await tick();
  assert.equal(resolved, false);
  assert.equal(fixture.store.companionDocuments, undefined);
  for (const expire of [...fixture.timers.values()]) expire();
  assert.ok((await pending).error);
  fixture.host({ documentId: 'document-A' });
  assert.equal((await fixture.message({ type: 'companion-authorize' })).tabId, 7);
  assert.deepEqual(fixture.store.companionDocuments, { 'document-A': 7 });
});

test('navigation and host removal revoke documents, including outstanding challenges', async () => {
  const fixture = await setup();
  fixture.host({ documentId: 'document-A' });
  await fixture.message({ type: 'companion-authorize' });
  fixture.chrome.tabs.onUpdated.listeners[0](7, { status: 'loading' });
  await tick();
  assert.deepEqual(fixture.store.companionDocuments, {});
  assert.match((await fixture.message({ type: 'conversation' })).error, /not an authorized/);
  fixture.host({});
  const pending = fixture.message({ type: 'companion-authorize' });
  await tick();
  await fixture.message({ type: 'companion-revoke' }, { ...fixture.sender, frameId: 0, url: 'https://fixture.test/' });
  assert.ok((await pending).error);
  await tick();
  assert.deepEqual(fixture.store.companionDocuments, {});
});

test('opening the Firefox fallback panel requires exact authorization', async () => {
  const fixture = await setup();
  const request = { type: 'companion-open-panel' };
  assert.match((await fixture.message(request)).error, /not an authorized/);
  assert.match((await fixture.message(request, { ...fixture.sender, frameId: 0, url: 'https://fixture.test/' })).error, /not an authorized/);
  fixture.host({ documentId: 'document-A' });
  await fixture.message({ type: 'companion-authorize' });
  const opened = [];
  fixture.chrome.tabs.create = async options => { opened.push(structuredClone(options)); };
  assert.deepEqual(await fixture.message(request), { ok: true });
  assert.deepEqual(opened, [{ url: 'moz-extension://fixture/panel.html?tab=7', active: true }]);
  fixture.chrome.tabs.onRemoved.listeners[0](7);
  await tick();
  assert.match((await fixture.message(request)).error, /not an authorized/);
});

test('same-document navigation revokes authorization and destroys the embedded runtime', async () => {
  const fixture = await setup();
  fixture.host({ documentId: 'document-A' });
  await fixture.message({ type: 'companion-authorize' });
  fixture.chrome.tabs.onUpdated.listeners[0](7, { url: 'https://fixture.test/#new-section' }, { status: 'complete' });
  await tick();
  assert.deepEqual(fixture.store.companionDocuments, {});
  assert.ok(fixture.sent.some(message => message.type === 'companion-remove'));
});

test('expiration during an asynchronous authorization write leaves no trusted document', async () => {
  const fixture = await setup();
  const gate = fixture.pauseWrite();
  fixture.host({ documentId: 'document-A' });
  const authorization = fixture.message({ type: 'companion-authorize' });
  await gate.reached;
  for (const expire of [...fixture.timers.values()]) expire();
  assert.ok((await authorization).error);
  gate.release();
  await tick();
  assert.deepEqual(fixture.store.companionDocuments, {});
  assert.match((await fixture.message({ type: 'conversation' })).error, /not an authorized/);
});
