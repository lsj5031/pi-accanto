import { getDocument, PDFWorker } from 'pdfjs-dist';

// Fetch only the validated attached URL; PDF.js receives bytes, never a remote URL.
export async function readPdf(url, startPage = 1, signal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('PDF reading timed out after 30 seconds. Wait for the document to finish loading and try again.')), 30000);
  const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
  let loading;
  let worker;
  let port;
  let onAbort;
  try {
    const cancelled = new Promise((_, reject) => {
      onAbort = () => reject(combined.reason);
      combined.addEventListener('abort', onAbort, { once: true });
    });
    combined.throwIfAborted();
    return await Promise.race([cancelled, (async () => {
      let response;
      try {
        response = await fetch(url, { credentials: 'include', redirect: 'error', signal: combined });
      } catch (error) {
        combined.throwIfAborted();
        throw new Error('Could not fetch this PDF. Reopen its original document URL and invoke the toolbar action. Sign-in, expired links, redirects, or browser cookie restrictions may prevent rereading it.');
      }
      if (!response.ok) throw new Error(`PDF fetch returned HTTP ${response.status}. Check sign-in and access to the original document, then try again.`);
      const maxBytes = 32 * 1024 * 1024;
      if (Number(response.headers.get('content-length')) > maxBytes) {
        await response.body.cancel();
        throw new Error('This PDF exceeds the 32 MiB reading limit. Open a smaller document or an extracted section.');
      }
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) {
          await reader.cancel();
          throw new Error('This PDF exceeds the 32 MiB reading limit. Open a smaller document or an extracted section.');
        }
        chunks.push(value);
      }
      const data = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
      if (!new TextDecoder().decode(data.subarray(0, 1024)).includes('%PDF-')) {
        throw new Error('The document URL did not return PDF data. It may have returned a sign-in page or an expired-link response. Open the original PDF and try again.');
      }
      port = new Worker(chrome.runtime.getURL('pdf.worker.mjs'), { type: 'module' });
      worker = new PDFWorker({ port });
      loading = getDocument({
        data, worker, isEvalSupported: false, useWasm: false, disableFontFace: true,
        cMapUrl: chrome.runtime.getURL('cmaps/'), cMapPacked: true,
        standardFontDataUrl: chrome.runtime.getURL('standard_fonts/'),
      });
      let document;
      try { document = await loading.promise; }
      catch (error) {
        if (error.name === 'PasswordException') throw new Error('This PDF requires a password. Password-protected PDFs are not supported; open an unlocked copy.');
        throw new Error('The PDF could not be parsed. It may be damaged or use an unsupported PDF format.');
      }
      if (startPage > document.numPages) throw new Error(`This PDF has ${document.numPages} pages; start_page must be within that range.`);
      const pages = [];
      let remaining = 16000;
      for (let number = startPage; number <= Math.min(document.numPages, startPage + 7) && remaining > 0; number++) {
        const page = await document.getPage(number);
        const textReader = page.streamTextContent().getReader();
        let text = '';
        let truncated = false;
        try {
          while (true) {
            combined.throwIfAborted();
            const { value, done } = await textReader.read();
            if (done) break;
            for (const item of value.items) {
              if (typeof item.str !== 'string') continue;
              const part = item.str + (item.hasEOL ? '\n' : ' ');
              if (part.length > remaining) truncated = true;
              text += part.slice(0, remaining);
              remaining -= Math.min(part.length, remaining);
              if (!remaining) { truncated = true; break; }
            }
            if (truncated) break;
          }
        } finally {
          await textReader.cancel(new Error('PDF text extraction finished.'));
          page.cleanup();
        }
        pages.push({ page: number, text: text.trim(), truncated });
      }
      const nextPage = pages.at(-1).page < document.numPages ? pages.at(-1).page + 1 : null;
      const truncated = Boolean(nextPage || pages.some(page => page.truncated));
      const hasText = pages.some(page => page.text);
      return {
        format: 'pdf', totalPages: document.numPages, pages, truncated, nextPage,
        note: [
          !hasText ? 'No extractable text in the inspected pages. They may be scanned/image-only or blank. OCR and vision are not available; do not infer their contents.' : 'Extracted PDF text; reading order and tables may be imperfect. Cite physical PDF page numbers.',
          truncated ? 'Partial document: limited to 8 pages and 16,000 characters per read. Do not claim to have read omitted text.' : '',
          nextPage ? `Call inspect_tab with start_page: ${nextPage} for later pages.` : '',
          pages.some(page => page.truncated) ? 'A page was cut at the character limit; later text on that page is unavailable in this result.' : '',
        ].filter(Boolean).join(' '),
      };
    })()]);
  } finally {
    clearTimeout(timeout);
    combined.removeEventListener('abort', onAbort);
    await loading?.destroy();
    worker?.destroy();
    port?.terminate();
  }
}
