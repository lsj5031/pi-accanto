import { BACKUP_LIMITS, base64, decode, snapshotMessages, transcript, validateBackup } from './portable.js';
import { importArchives } from './archives.js';
import { imageDimensions } from './attachments.js';
import { readPdf } from './pdf-reader.js';

export async function inspectPortableSource({ kind, mime, bytes }) {
  if (kind === 'text') {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\0')) throw new Error('Invalid text source.');
    return {};
  }
  if (kind === 'pdf') {
    if (!new TextDecoder().decode(bytes.subarray(0, 1024)).includes('%PDF-')) throw new Error('Invalid PDF source.');
    const result = await readPdf(bytes, 1, AbortSignal.timeout(30000));
    return { pages: result.totalPages };
  }
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw new Error('Invalid image type.');
  const dimensions = imageDimensions(bytes, mime);
  const image = await createImageBitmap(new Blob([bytes], { type: mime }));
  try {
    if (image.width !== dimensions.width || image.height !== dimensions.height) throw new Error('Invalid image metadata.');
  } finally { image.close(); }
  return { mime, ...dimensions };
}

export function backupUI({ embedded, currentId, busy, setBusy, snapshot, refresh }) {
  const $ = id => document.getElementById(id);
  $('portable-controls').hidden = embedded;
  $('installed-version').textContent = chrome.runtime.getManifest().version;
  if (embedded) return;
  const update = () => {
    const blocked = busy();
    $('export-backup').disabled = $('import-backup').disabled = $('backup-file').disabled = blocked;
  };
  const observer = new MutationObserver(update);
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-busy'] });
  observer.observe($('attachment-list'), { childList: true, subtree: true });
  let pending;
  async function guard(run) {
    if (busy()) throw new Error('Stop active work before backup or restore.');
    const locks = await navigator.locks.query();
    if (locks.held.some(lock => lock.name.startsWith('pi-accanto-owner-') && lock.name !== `pi-accanto-owner-${currentId()}`)) throw new Error('Close other Accanto chat panels before backup or restore.');
    return navigator.locks.request('accanto-portable-operation', { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('Another backup or restore is running.');
      if (busy()) throw new Error('Stop active work before backup or restore.');
      setBusy(true);
      $('backup-file').disabled = $('cancel-import').disabled = true;
      try { return await run(); } finally { setBusy(false); $('backup-file').disabled = $('cancel-import').disabled = false; }
    });
  }
  const status = message => { $('backup-status').textContent = message; };
  $('export-backup').onclick = async () => {
    try {
      await guard(async () => {
        status('Preparing backup…');
        const chat = await snapshot();
        const backup = await validateBackup({ format: 'pi-accanto-archive', version: 1, conversations: [chat] }, inspectPortableSource);
        const json = JSON.stringify(backup);
        if (new Blob([json]).size > BACKUP_LIMITS.bytes) throw new Error('Backup exceeds 80 MiB.');
        const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url; link.download = 'accanto-conversation.json'; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        status(`Backup download ready: 1 conversation, ${chat.messages.length} messages, ${chat.sources.length} sources. Check browser downloads to confirm it was saved.`);
      });
    } catch (error) { status(error.message); }
  };
  $('backup-file').onchange = async event => {
    pending = undefined; $('confirm-import').hidden = true;
    const file = event.target.files[0];
    if (!file) return;
    try {
      await guard(async () => {
        status('Validating backup…');
        if (file.size > BACKUP_LIMITS.bytes) throw new Error('Backup exceeds 80 MiB.');
        pending = await validateBackup(JSON.parse(await file.text()), inspectPortableSource);
        const chats = pending.conversations;
        status(`Ready: ${chats.length} conversations, ${chats.reduce((n, c) => n + c.messages.length, 0)} messages, ${chats.reduce((n, c) => n + c.sources.length, 0)} sources. Import as new read-only archives?`);
        $('confirm-import').hidden = false;
      });
    } catch { status('Could not validate backup. It may be corrupt, unsupported, or active work is open. No chats changed.'); }
    finally { event.target.value = ''; }
  };
  $('cancel-import').onclick = () => { if ($('cancel-import').disabled) return; pending = undefined; $('confirm-import').hidden = true; status('Import cancelled.'); };
  $('import-backup').onclick = async () => {
    try {
      await guard(async () => {
        if (!pending) return;
        status('Importing…');
        const backup = pending, count = backup.conversations.length;
        await importArchives(backup);
        pending = undefined; $('confirm-import').hidden = true;
        status(`Imported ${count} read-only archived conversations. Existing chats unchanged.`);
        try { await refresh(); }
        catch { status(`Imported ${count} read-only archived conversations. Open a new Accanto tab to refresh History.`); }
      });
    } catch (error) { status(error.message); }
  };
}

export function renderArchive(chat) {
  const transcript = document.getElementById('transcript');
  transcript.classList.add('archived');
  transcript.replaceChildren();
  for (const m of chat.messages) {
    const article = document.createElement('article');
    article.className = m.role;
    const label = document.createElement('strong'); label.textContent = m.role;
    article.append(label);
    for (const b of m.blocks) {
      if (b.type === 'text') {
        const p = document.createElement('pre'); p.style.whiteSpace = 'pre-wrap'; p.textContent = b.text; article.append(p);
      } else {
        const image = document.createElement('img');
        image.alt = 'Archived message image'; image.src = `data:${b.mime};base64,${b.data}`; image.style.maxWidth = '100%'; article.append(image);
      }
    }
    transcript.append(article);
  }
  const heading = document.createElement('h2'); heading.textContent = 'Archived sources'; transcript.append(heading);
  for (const source of chat.sources) {
    const section = document.createElement('section');
    const name = document.createElement('p'); name.textContent = `${source.name} [${source.id}]`; section.append(name);
    if (source.kind === 'tab') {
      const note = document.createElement('p'); note.textContent = `${source.url} · Unavailable reference. Reselect the tab in a new chat.`; section.append(note);
    } else {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Save source locally';
      button.onclick = () => {
        const url = URL.createObjectURL(new Blob([decode(source.data, 16 * 1024 * 1024)], { type: source.mime || (source.kind === 'pdf' ? 'application/pdf' : 'text/plain') }));
        const link = document.createElement('a'); link.href = url; link.download = source.name; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      };
      section.append(button);
      if (source.kind === 'pdf') {
        const page = document.createElement('input'); page.type = 'number'; page.min = '1'; page.max = String(source.pages); page.value = '1'; page.setAttribute('aria-label', `Physical page of ${source.name}`);
        const read = document.createElement('button'); read.type = 'button'; read.textContent = 'Read PDF page text';
        const output = document.createElement('pre'); output.style.whiteSpace = 'pre-wrap'; output.setAttribute('role', 'status');
        read.onclick = async () => {
          read.disabled = true;
          try {
            const n = Number(page.value);
            if (!Number.isInteger(n) || n < 1 || n > source.pages) throw new Error('Choose a valid physical page.');
            const result = await readPdf(decode(source.data, 16 * 1024 * 1024), n, AbortSignal.timeout(30000));
            output.textContent = JSON.stringify(result, null, 2);
          } catch (error) { output.textContent = error.message; }
          finally { read.disabled = false; }
        };
        section.append(page, read, output);
      }
      if (source.kind === 'image') {
        const details = document.createElement('details'), summary = document.createElement('summary'), image = document.createElement('img');
        summary.textContent = 'View archived image'; image.alt = source.name;
        image.src = `data:${source.mime};base64,${source.data}`; image.style.maxWidth = '100%';
        details.append(summary, image); section.append(details);
      }
      if (source.kind === 'text') {
        const pre = document.createElement('pre'); pre.style.whiteSpace = 'pre-wrap';
        pre.textContent = new TextDecoder().decode(decode(source.data, 2 * 1024 * 1024)); section.append(pre);
      }
    }
    transcript.append(section);
  }
}

export async function snapshotChat(root, attachments, context, title) {
  const entries = [];
  let cursor;
  do {
    const page = await root.entries({ order: 'ascending' }, 256, cursor, context);
    entries.push(...page.items); cursor = page.next;
    if (entries.length > BACKUP_LIMITS.messages) throw new Error('Conversation exceeds the portable entry limit.');
  } while (cursor);
  const sources = [];
  for (const source of await attachments.snapshot()) {
    const { blob, ...metadata } = source;
    sources.push(blob ? { ...metadata, data: base64(new Uint8Array(await blob.arrayBuffer())) } : metadata);
  }
  const messages = snapshotMessages(entries);
  return { title, messages, sources, transcript: transcript(messages) };
}
