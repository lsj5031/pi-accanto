import { RemoteCodemodeSandbox } from '@earendil-works/pi-codemode/portable';

export function createBrowserSandbox() {
  const workers = new Set();
  const sandbox = new RemoteCodemodeSandbox({
    memoryLimitBytes: 32 * 1024 * 1024,
    interruptBudget: 20000,
    remote: () => ({
      execute: (request, exchange) => new Promise((resolve, reject) => {
        const worker = new Worker(new URL('codemode-worker.js', import.meta.url), { type: 'module' });
        const finish = (error) => {
          clearTimeout(timer);
          workers.delete(cancel);
          worker.terminate();
          error ? reject(error) : resolve();
        };
        const cancel = () => finish(new Error('Code Mode stopped.'));
        const timer = setTimeout(() => finish(new Error('Code Mode exceeded 30 seconds.')), 30000);
        workers.add(cancel);
        worker.onerror = (event) => finish(new Error(event.message || 'Code Mode worker failed.'));
        worker.onmessage = async ({ data }) => {
          if (data.type === 'finished') { finish(); return; }
          if (data.type !== 'exchange') return;
          try {
            const reply = await exchange(data.messages);
            if (reply?.type === 'stop') { finish(); return; }
            worker.postMessage({ type: 'reply', id: data.id, reply });
          } catch (error) { finish(error); }
        };
        worker.postMessage({ type: 'start', request });
      }),
    }),
  });
  return { sandbox, stop: () => { for (const cancel of workers) cancel(); } };
}
