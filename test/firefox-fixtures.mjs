import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { pdf } from './pdf-fixtures.mjs';

export async function fixtureServer() {
  const requests = [];
  let releaseStream;
  const server = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'firefox-fixture' }] }));
    } else if (req.url === '/v1/chat/completions') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const input = JSON.parse(body);
      requests.push({ input, authorization: req.headers.authorization, origin: req.headers.origin });
      res.setHeader('Content-Type', 'text/event-stream');
      const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
        choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`);
      const lastUser = input.messages.findLastIndex(message => message.role === 'user');
      const tools = input.messages.slice(lastUser + 1).filter(message => message.role === 'tool');
      if (!tools.length) {
        chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'firefox-inspect', type: 'function', function: { name: 'inspect_tab', arguments: '{}' } }] });
        chunk({}, 'tool_calls');
      } else {
        chunk({ role: 'assistant', content: 'Synthetic streamed answer: ' });
        await new Promise(resolve => {
          releaseStream = resolve;
          res.once('close', resolve);
        });
        chunk({ content: 'invoice NZ-427 totals $183.75.' });
        chunk({}, 'stop');
      }
      res.end('data: [DONE]\n\n');
    } else if (req.url === '/document.pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      res.end(pdf([['Firefox selected PDF evidence 283.'], ['Physical page two PINE-64.']]));
    } else {
      if (req.url === '/blocked') res.setHeader('Content-Security-Policy', "frame-src 'none'");
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(req.url === '/other'
        ? '<!doctype html><title>Additional evidence</title><p>TAB-ONLY allowance 284.</p><textarea>PRIVATE-FIELD-EXCLUDED</textarea>'
        : '<!doctype html><title>Firefox invoice</title><h1>Invoice NZ-427</h1><p>Invoice NZ-427 totals $183.75.</p><input type="password" value="PASSWORD-EXCLUDED">');
    }
  });
  server.requestTimeout = 10000;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    origin: `http://127.0.0.1:${port}`, modelOrigin: `http://localhost:${port}`, requests,
    release() { assert.ok(releaseStream, 'A real streamed response must be pending'); releaseStream(); releaseStream = undefined; },
    async close() { releaseStream?.(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

export const ready = h => h.wait(() => document.getElementById('status')?.textContent.includes('Ready'), 'Panel ready');
export const idle = (h, timeout) => h.wait(() => !document.getElementById('send')?.disabled, 'Turn finished', timeout);
export async function send(h, prompt) {
  // The real composer handler runs; this avoids typing long Code Mode programs
  // character-by-character. No runtime handler or tool is replaced.
  await h.evaluate(prompt => { document.getElementById('prompt').value = prompt; document.getElementById('send').click(); }, prompt);
}
export async function scripted(h) {
  await h.open('panel.html?settings=1');
  await h.wait(() => !!document.getElementById('installed-version')?.textContent, 'Settings loaded');
  await h.evaluate(() => chrome.storage.local.set({ mode: 'scripted', modelConnection: { imageInput: true } }));
}
export async function tabId(h, url) {
  return h.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, url);
}
export async function attachFiles(h, paths) {
  // WebDriver's real file-input path, not a synthetic File/DataTransfer.
  await h.driver.findElement({ css: '#attachment-files' }).sendKeys(paths.join('\n'));
  await h.wait(() => document.querySelectorAll('#attachment-list li').length > 0 && !document.querySelector('#attachment-list [data-state=loading]'), 'Files imported');
}
export async function code(h, source, timeout = 15000) {
  const before = await h.evaluate(() => document.querySelectorAll('article.toolResult').length);
  await send(h, `Code: ${source}`);
  await h.wait(() => document.body.dataset.busy !== 'true' && !document.getElementById('send').disabled, 'Code Mode completed', timeout);
  const result = await h.evaluate(before => {
    const results = [...document.querySelectorAll('article.toolResult')];
    if (results.length <= before) throw new Error('Code Mode produced no new tool result');
    return results.at(-1).textContent;
  }, before);
  return result;
}
