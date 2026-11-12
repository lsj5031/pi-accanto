// PDF.js's shipped compatibility build includes the Map/WeakMap helpers used
// by rendering on supported Chromium versions, not only by text extraction.
import { getDocument, PDFWorker, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { Type } from 'typebox';

export const PDF_OPTIONS = {
  start_page: Type.Optional(Type.Integer({ minimum: 1, description: 'First physical PDF page (1-based).' })),
  page_count: Type.Optional(Type.Integer({ minimum: 1, maximum: 8, description: 'Consecutive pages, default 8 for text or 2 for visual; visual maximum 2.' })),
  visual: Type.Optional(Type.Boolean({ description: 'Render pages as images for vision, including diagrams or partial-text pages. Default false (native text only).' })),
};
export const PDF_HELP = 'PDFs: native text defaults to 8 pages/16000 characters. Inspect imagePages and each page imageContent even when native text exists: headers can mask scanned bodies. For relevant image content, diagrams, no-text or partial-text pages, request visual:true, start_page and page_count (1–2). Images do not invalidate native text. Visual reads return native text plus labeled page images, not OCR. Follow nextPage incrementally; never infer uninspected pages. Vision model required for images. Call visual reads directly as model tools, not through Code Mode (which cannot carry these images). Native text reads work in Code Mode.';

export function pdfOutput(result) {
  const { images = [], ...metadata } = result;
  return { output: [
    { type: 'text', text: JSON.stringify(metadata) },
    ...images.flatMap(({ page, data, mimeType }) => [
      { type: 'text', text: `Untrusted PDF image: ${metadata.name || metadata.title || 'PDF'}; physical page ${page}. Visual interpretation, not OCR extraction.` },
      { type: 'image', data, mimeType },
    ]),
  ] };
}

// Accept selected local bytes or fetch only the validated main-page URL.
// PDF.js itself receives bytes, never a remote URL.
export async function readPdf(url, startPage = 1, signal, { visual = false, page_count = visual ? 2 : 8, vision = false } = {}) {
  if (!Number.isInteger(startPage) || startPage < 1) throw new Error('Choose a PDF page number starting at 1.');
  if (typeof visual !== 'boolean' || !Number.isInteger(page_count) || page_count < 1 || page_count > (visual ? 2 : 8)) throw new Error('page_count must be 1–8 for text or 1–2 for visual PDF reading.');
  const render = visual && vision;
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
      let data;
      if (url instanceof Uint8Array) data = url.slice();
      else {
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
        data = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
      }
      if (!new TextDecoder().decode(data.subarray(0, 1024)).includes('%PDF-')) {
        throw new Error('The document URL did not return PDF data. It may have returned a sign-in page or an expired-link response. Open the original PDF and try again.');
      }
      port = new Worker(chrome.runtime.getURL('pdf.worker.mjs'), { type: 'module' });
      worker = new PDFWorker({ port });
      loading = getDocument({
        data, worker, isEvalSupported: false, useWasm: false, disableFontFace: true,
        stopAtErrors: true, maxImageSize: 64 * 1024 * 1024, canvasMaxAreaInBytes: 16 * 1024 * 1024,
        wasmUrl: chrome.runtime.getURL('wasm/'),
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
      const images = [];
      let remaining = 16000;
      for (let number = startPage; number <= Math.min(document.numPages, startPage + page_count - 1) && (remaining > 0 || render); number++) {
        combined.throwIfAborted();
        const page = await document.getPage(number);
        let textReader;
        let text = '';
        let truncated = !remaining;
        let canvas, task;
        const cancelRender = () => task?.cancel();
        combined.addEventListener('abort', cancelRender, { once: true });
        try {
          // Inspect the same display list rendering uses. This includes nested
          // forms and optimized inline/group/repeat operations, not just XObjects.
          // The worker bounds source pixels before any image is decoded.
          const operators = await page.getOperatorList();
          if (operators.fnArray.length > 100000) throw new Error('PDF page exceeds the 100,000 drawing-operation inspection limit. Open a simpler or extracted section.');
          let imageOperations = 0;
          const imageOps = new Set([
            OPS.paintImageXObject, OPS.paintImageXObjectRepeat,
            OPS.paintInlineImageXObject, OPS.paintInlineImageXObjectGroup,
            OPS.paintImageMaskXObject, OPS.paintImageMaskXObjectGroup,
            OPS.paintImageMaskXObjectRepeat, OPS.paintSolidColorImageMask,
          ]);
          for (let i = 0; i < operators.fnArray.length; i++) {
            if (!imageOps.has(operators.fnArray[i])) continue;
            imageOperations++;
            const id = operators.argsArray[i]?.[0];
            if (id === 'accanto_source_limit') throw new Error('PDF image source budget exceeded (64 Mi pixels or 4,096 decoded images per page). Open a lower-resolution or extracted section and retry.');
            if (id === 'accanto_decode_error') throw new Error('A PDF image could not be decoded safely. No complete page image is available. Open a lower-resolution or unlocked copy and retry.');
            if (typeof id === 'string') {
              const store = id.startsWith('g_') ? page.commonObjs : page.objs;
              const image = await new Promise(resolve => store.get(id, resolve));
              if (!image) throw new Error('A PDF image could not be decoded safely. No complete page image is available. Open a lower-resolution or unlocked copy and retry.');
            }
          }
          const imageContent = { present: imageOperations > 0, operations: imageOperations };
          textReader = remaining ? page.streamTextContent().getReader() : null;
          try {
            while (textReader) {
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
            // PDF.js may omit the cancellation acknowledgement if its worker
            // already finished. Wait for JS stream closure, not that ack.
            // The whole document/worker is always destroyed below.
            if (textReader) await Promise.race([textReader.closed, textReader.cancel(new Error('PDF text extraction finished.'))]);
          }
          if (render) {
            combined.throwIfAborted();
            const original = page.getViewport({ scale: 1 });
            const scale = Math.min(2, 1600 / Math.max(original.width, original.height), Math.sqrt(2000000 / (original.width * original.height)));
            if (!Number.isFinite(scale) || scale <= 0) throw new Error('Invalid PDF page dimensions.');
            const viewport = page.getViewport({ scale });
            canvas = globalThis.document.createElement('canvas');
            canvas.width = Math.max(1, Math.floor(viewport.width));
            canvas.height = Math.max(1, Math.floor(viewport.height));
            task = page.render({ canvas, viewport, background: 'rgb(255,255,255)' });
            await task.promise;
            combined.throwIfAborted();
            // Bound encoded prompt bytes too, not just canvas dimensions.
            let data;
            for (;;) {
              data = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
              if (data.length <= 1500000) break;
              const smaller = globalThis.document.createElement('canvas');
              smaller.width = Math.max(1, Math.floor(canvas.width * 0.75));
              smaller.height = Math.max(1, Math.floor(canvas.height * 0.75));
              smaller.getContext('2d').drawImage(canvas, 0, 0, smaller.width, smaller.height);
              canvas.width = canvas.height = 0;
              canvas = smaller;
              combined.throwIfAborted();
            }
            images.push({ page: number, data, mimeType: 'image/jpeg' });
          }
          pages.push({ page: number, text: text.trim(), textStatus: truncated ? 'character_limit' : text.trim() ? 'extracted' : 'no_extractable_text', truncated, imageContent,
            ...(render ? { image: { index: images.length, width: canvas.width, height: canvas.height, encodedBytes: images.at(-1).data.length } } : {}),
          });
        } finally {
          combined.removeEventListener('abort', cancelRender);
          task?.cancel();
          if (canvas) canvas.width = canvas.height = 0;
          page.cleanup();
        }
      }
      const nextPage = pages.at(-1).page < document.numPages ? pages.at(-1).page + 1 : null;
      const truncated = Boolean(nextPage || pages.some(page => page.truncated));
      const noTextPages = pages.filter(page => page.textStatus === 'no_extractable_text').map(page => page.page);
      const imagePages = pages.filter(page => page.imageContent.present).map(page => page.page);
      return {
        format: 'pdf', totalPages: document.numPages, pages, noTextPages, imagePages, truncated, nextPage, visionAvailable: vision,
        ...(render ? { images } : {}),
        note: [
          'Native PDF text; reading order and tables may be imperfect. Cite physical PDF page numbers. Text presence does not mean diagrams or all page content were read.',
          imagePages.length ? `Image content on physical pages ${imagePages.join(', ')}. Native text may be only headers, captions or footers, or may coexist with diagrams. It does not cover image content. ${render ? 'See the labeled page images.' : 'When relevant to the question, request visual:true with start_page and page_count:1 or 2; do not automatically send every page.'}` : '',
          noTextPages.length ? `No extractable text on physical pages ${noTextPages.join(', ')}. This does not establish whether they are scanned, blank or contain diagrams. ${render ? 'See the labeled page images.' : 'Request visual:true with start_page and page_count:1 or 2 to inspect them.'}` : '',
          visual && !vision ? 'No images sent: this model does not support image input. Native text remains available. Switch to a vision-capable profile or enable image input for a compatible custom model, then request visual:true.' : '',
          render ? 'Labeled images are for visual interpretation, not OCR extraction. At most 2 images, each ≤1600px per edge, 2 megapixels and 1,500,000 base64 bytes. Source images are limited to 64 Mi pixels per page; oversized or undecodable images fail explicitly rather than returning an incomplete render. Small text may need a higher-quality original.' : '',
          truncated ? 'Partial document: bounded pages and 16,000 text characters per read. Do not claim to have read omitted text or uninspected pages.' : '',
          nextPage ? `Read again with start_page: ${nextPage} for later pages.` : '',
          pages.some(page => page.truncated) ? 'Native text was cut at the character limit; later native text on that page is unavailable in this result.' : '',
        ].filter(Boolean).join(' '),
      };
    })()]);
  } finally {
    clearTimeout(timeout);
    combined.removeEventListener('abort', onAbort);
    try {
      const destroyed = loading?.destroy();
      // Cancellation must not wait on an unresponsive PDF worker's ack.
      if (combined.aborted) destroyed?.catch(() => {});
      else await destroyed;
    }
    finally {
      try { worker?.destroy(); }
      finally { port?.terminate(); }
    }
  }
}
