import assert from 'node:assert/strict';
import test from 'node:test';
import { snapshotMessages, validateBackup, base64, decode, BACKUP_LIMITS } from './portable.js';
const inspect = async ({ kind, bytes }) => {
  if (kind === 'text') new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return {};
};
const source = { id: 'source-1', name: 'evidence.txt', kind: 'text', data: base64(new TextEncoder().encode('evidence 713')) };
const fixture = () => ({ format: 'pi-accanto-archive', version: 1, conversations: [{ title: 'Synthetic chat', messages: [{ role: 'user', blocks: [{ type: 'text', text: 'Question [source-1]' }] }], sources: [source] }] });
test('allowlisted domain selection excludes credential and runtime canaries', async () => {
  const entries = [{ kind: 'accanto.target', data: { apiKey: 'KEY-CANARY', tabId: 73 }, lease: 'LEASE-CANARY', model: [{ role: 'user', content: 'A question', headers: { Authorization: 'HEADER-CANARY' } }] }];
  const value = fixture();
  value.conversations[0].messages = snapshotMessages(entries);
  Object.assign(value.conversations[0], { endpoint: 'ENDPOINT-CANARY', settings: 'SETTINGS-CANARY', task: 'TASK-CANARY' });
  Object.assign(value.conversations[0].sources[0], { session: 'SESSION-CANARY', documentId: 'DOCUMENT-CANARY' });
  const clean = await validateBackup(value, inspect);
  assert.doesNotMatch(JSON.stringify(clean), /CANARY/);
  assert.equal(clean.conversations[0].transcript, 'user\nA question');
  assert.equal(new TextDecoder().decode(decode(clean.conversations[0].sources[0].data, 100)), 'evidence 713');
});
test('strict malformed, version, count, base64, type and aggregate boundaries', async () => {
  for (const mutate of [
    b => b.version = 2,
    b => b.conversations = Array(21).fill(b.conversations[0]),
    b => b.conversations[0].sources.push(source),
    b => b.conversations[0].sources[0].id = '../escape',
    b => b.conversations[0].sources[0].data = 'AAAA=',
    b => b.conversations[0].sources[0].kind = 'executable',
    b => b.conversations[0].sources[0].name = 'payload.exe',
    b => b.conversations[0].sources[0].name = '../evidence.txt',
    b => b.conversations[0].messages[0].role = 'task',
    b => b.conversations[0].messages = Array(BACKUP_LIMITS.messages + 1).fill(b.conversations[0].messages[0]),
    b => b.conversations[0].messages[0].blocks[0].text = 'x'.repeat(2 * 1024 * 1024 + 1),
    b => { b.conversations[0].messages = Array(25).fill({ role: 'user', blocks: [{ type: 'text', text: 'x'.repeat(2 * 1024 * 1024) }] }); },
  ]) {
    const b = structuredClone(fixture()); mutate(b);
    await assert.rejects(validateBackup(b, inspect));
  }
});
test('tool calls become inert readable text, images remain native blocks', async () => {
  const messages = snapshotMessages([{ model: [{ role: 'assistant', content: [{ type: 'toolCall', name: 'fetch', arguments: { url: 'https://example.test/?private=yes' }, id: 'OLD-RUN' }, { type: 'image', data: 'AQ==', mimeType: 'image/png', task: 'RUN' }] }] }]);
  assert.match(messages[0].blocks[0].text, /Tool: fetch/);
  assert.equal(messages[0].blocks[1].type, 'image');
  assert.doesNotMatch(JSON.stringify(messages), /OLD-RUN|task/);
  assert.deepEqual(snapshotMessages([{ model: [{ role: 'assistant', content: [], errorMessage: 'Synthetic provider failure' }] }])[0].blocks, [{ type: 'text', text: 'Synthetic provider failure' }]);
});
test('tab and main-page references keep citations but never browser bindings', async () => {
  const b = fixture();
  b.conversations[0].sources = [{ id: 'tab-source', kind: 'tab', name: 'Citation', url: 'https://example.test/?private=value', tabId: 73, documentId: 'OLD-DOC', session: 'OLD-SESSION', lease: 'OLD-LEASE' }];
  b.conversations[0].messages = snapshotMessages([{ kind: 'accanto.target', data: { target: { id: 91, session: 'OLD-SESSION', title: 'Main page', url: 'https://example.test/main' } } }]);
  const clean = await validateBackup(b, inspect);
  assert.equal(clean.conversations[0].sources[0].url, 'https://example.test/?private=value');
  assert.match(clean.conversations[0].transcript, /Unavailable page reference: Main page/);
  assert.doesNotMatch(JSON.stringify(clean), /OLD-|tabId|documentId|lease/);
});
