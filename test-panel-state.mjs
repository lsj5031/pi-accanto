import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Exercise the real handlers while controlling asynchronous preparation steps.
const source = await readFile(new URL('./panel.js', import.meta.url), 'utf8');
const handlers = source.slice(source.indexOf("  $('composer').addEventListener('submit'"), source.indexOf('  // Runs do not resume automatically'));
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

for (const stage of ['permission', 'attachment', 'identity', 'page-context', 'submission']) {
  test(`Stop during ${stage} prevents later submission work`, { timeout: 5000 }, async () => {
    const gate = deferred();
    const reached = deferred();
    const elements = new Map();
    const $ = id => {
      if (!elements.has(id)) elements.set(id, {
        value: '', disabled: false, dataset: {}, focus() {},
        addEventListener(_, fn) { this.handler = fn; },
      });
      return elements.get(id);
    };
    $('prompt').value = 'A draft that must not run after Stop';
    const calls = { submit: 0, abort: 0, stop: 0 };
    const pause = async name => {
      if (name !== stage) return;
      reached.resolve();
      await gate.promise;
    };
    let reads = 0;
    const dependencies = {
      $, document: { body: { dataset: {} } },
      refreshModelAccess: async () => { await pause('permission'); return true; },
      attachCurrent: () => pause('attachment'),
      inTarget: async () => { await pause(++reads === 1 ? 'identity' : 'page-context'); return { text: 'Page context' }; },
      pageIdentity() {}, pagePassages() {},
      root: {
        async submit() {
          calls.submit++;
          await pause('submission');
          return { wait: async () => ({ status: 'done' }) };
        },
        async abort() { calls.abort++; },
      },
      codeMode: { stop() { calls.stop++; } },
      attachments: { cancel() {}, list: () => [] },
      context: {}, saveDraft: async () => {}, reportDraftError() {},
      showAttachment: async () => {}, statusChanged() {}, reloadPanel() {},
      connectionStatus() {}, modelId: 'fixture', crypto: globalThis.crypto,
    };
    const run = await new AsyncFunction('deps', `
      const { $, document, refreshModelAccess, attachCurrent, inTarget, pageIdentity, pagePassages,
        root, codeMode, context, saveDraft, reportDraftError, showAttachment, statusChanged,
        reloadPanel, connectionStatus, modelId, crypto, attachments } = deps;
      let busy = false, ownsConversation = true, submissionController;
      const scripted = false, apiKey = 'fixture', webResearch = false, reconnectPending = false;
      const attachment = ${stage !== 'attachment'}, useConversationTab = false, missingModelAccess = 'Missing access';
      ${handlers}
      return { isBusy: () => busy, signal: () => submissionController?.signal };
    `)(dependencies);
    const running = $('composer').handler({ preventDefault() {} });
    assert.equal($('prompt').value, '', 'Clear the composer synchronously');
    await reached.promise;
    assert.equal(run.isBusy(), true);
    const signal = run.signal();
    $('stop').handler();
    assert.equal(signal.aborted, true);
    // A newer draft typed during preparation must win over the submitted one.
    if (stage === 'page-context') $('prompt').value = 'A newer follow-up draft';
    gate.resolve();
    await running;
    assert.equal(calls.submit, stage === 'submission' ? 1 : 0);
    assert.ok(calls.abort >= (stage === 'submission' ? 2 : 1));
    assert.equal(calls.stop, 1);
    assert.equal(run.isBusy(), false);
    assert.equal($('stop').disabled, true);
    assert.equal($('send').disabled, false);
    assert.equal($('prompt').value, stage === 'page-context' ? 'A newer follow-up draft' : 'A draft that must not run after Stop');
    assert.match($('status').textContent, /Stopped/);
  });
}
