// Chrome applies a host page's `upgrade-insecure-requests` CSP to network
// requests made by an extension iframe embedded in that page. A plain-HTTP
// model, PDF or web source would then be requested over HTTPS and fail with
// ERR_SSL_PROTOCOL_ERROR on the exact same settings. Keep embedded-page traffic
// out of the page process: the extension worker is not embedded in the page.
const nativeFetch = globalThis.fetch;

function proxiedFetch(input, init) {
  let request;
  try {
    request = new Request(input, init);
  } catch (error) {
    return Promise.reject(error);
  }
  return (async () => {
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.clone().text();
    if (request.signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    const port = chrome.runtime.connect({ name: 'accanto-fetch' });
    return new Promise((resolve, reject) => {
      let opened = false;
      let finished = false;
      let controller;
      const stream = new ReadableStream({
        start(value) { controller = value; },
        cancel() { port.disconnect(); },
      });
      const failure = () => request.signal.aborted
        ? new DOMException('The operation was aborted.', 'AbortError')
        : new TypeError('Failed to fetch');
      const fail = () => {
        if (finished) return;
        finished = true;
        const error = failure();
        if (opened) { try { controller.error(error); } catch { /* Already closed. */ } } else reject(error);
        port.disconnect();
      };
      // Disconnecting our own port does not fire onDisconnect, so settle the
      // response stream here; otherwise readers wait forever for more events.
      request.signal.addEventListener('abort', fail, { once: true });
      port.onDisconnect.addListener(fail);
      port.onMessage.addListener((message) => {
        if (message.type === 'headers') {
          opened = true;
          const bodyless = [204, 205, 304].includes(message.status);
          resolve(new Response(bodyless ? null : stream, {
            status: message.status,
            statusText: message.statusText,
            headers: message.headers,
          }));
        } else if (message.type === 'chunk') {
          if (!finished) controller.enqueue(Uint8Array.from(atob(message.data), (character) => character.charCodeAt(0)));
        } else if (message.type === 'end') {
          finished = true;
          try { controller.close(); } catch { /* Already closed. */ }
          port.disconnect();
        } else if (message.type === 'error') {
          fail();
        }
      });
      port.postMessage({
        url: request.url,
        method: request.method,
        headers: [...request.headers],
        body,
        redirect: request.redirect,
        credentials: request.credentials,
        referrerPolicy: request.referrerPolicy,
      });
    });
  })();
}

// Only plain-HTTP URLs are affected by the CSP upgrade; HTTPS requests keep
// the direct path.
export function installWorkerFetch() {
  globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    return /^http:/i.test(url) ? proxiedFetch(input, init) : nativeFetch(input, init);
  };
}
