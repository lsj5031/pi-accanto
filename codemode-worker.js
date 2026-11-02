import { serveCodemodeRemote } from '@earendil-works/pi-codemode/portable';

// The upstream remote server uses the same inline QuickJS launcher as
// InlineCodemodeSandbox. Keep synchronous WASM execution off the sidebar thread.
const wasm = fetch(new URL('quickjs.wasm', import.meta.url))
  .then((response) => {
    if (!response.ok) throw new Error('Could not load bundled QuickJS WASM.');
    return response.arrayBuffer();
  }).then((bytes) => WebAssembly.compile(bytes));
const waiting = new Map();
let sequence = 0;
self.onmessage = async ({ data }) => {
  if (data.type === 'reply') {
    waiting.get(data.id)?.(data.reply);
    waiting.delete(data.id);
    return;
  }
  if (data.type !== 'start') return;
  await serveCodemodeRemote(data.request, (messages) => new Promise((resolve) => {
    const id = ++sequence;
    waiting.set(id, resolve);
    self.postMessage({ type: 'exchange', id, messages });
  }), { wasm, maxInterruptBudget: 20000, maxMemoryLimitBytes: 32 * 1024 * 1024 });
  self.postMessage({ type: 'finished' });
};
