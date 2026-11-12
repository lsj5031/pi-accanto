import { BACKUP_LIMITS, base64, decode, snapshotMessages, transcript, validateBackup } from './portable.js';
import { importArchives } from './archives.js';
import { imageDimensions } from './attachments.js';
import { readPdf } from './pdf-reader.js';

const counted = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

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
        status(`Backup download ready: 1 conversation, ${counted(chat.messages.length, 'message')}, ${counted(chat.sources.length, 'source')}. Check browser downloads to confirm it was saved.`);
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
        status(`Ready: ${counted(chats.length, 'conversation')}, ${counted(chats.reduce((n, c) => n + c.messages.length, 0), 'message')}, ${counted(chats.reduce((n, c) => n + c.sources.length, 0), 'source')}. Import as ${chats.length === 1 ? 'a new read-only archive' : 'new read-only archives'}?`);
        $('import-backup').textContent = `Import ${counted(chats.length, 'archived chat')}`;
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
        status(`Imported ${counted(count, 'read-only archived conversation')}. Existing chats unchanged.`);
        try { await refresh(); }
        catch { status(`Imported ${counted(count, 'read-only archived conversation')}. Open a new Accanto tab to refresh History.`); }
      });
    } catch (error) { status(error.message); }
  };
}

export function renderArchive(chat) {
  const transcript = document.getElementById('transcript');
  transcript.classList.add('archived');
  transcript.replaceChildren();
  const references = new Map(chat.sources.map((source, index) => [source.id, { name: source.name, anchor: `archived-source-${index}` }]));
  const appendText = (element, text) => {
    let offset = 0;
    for (const match of text.matchAll(/\[([a-zA-Z0-9_-]+)\]/g)) {
      const reference = references.get(match[1]);
      if (!reference) continue;
      element.append(document.createTextNode(text.slice(offset, match.index)));
      const link = document.createElement('a');
      link.textContent = `[${reference.name}]`; link.href = `#${reference.anchor}`;
      link.onclick = event => { event.preventDefault(); document.getElementById(reference.anchor).scrollIntoView({ block: 'start' }); };
      element.append(link); offset = match.index + match[0].length;
    }
    element.append(document.createTextNode(text.slice(offset)));
  };
  let activity, activityCount = 0;
  for (const m of chat.messages) {
    const tool = m.role === 'toolResult' || m.role === 'assistant' && m.blocks.some(b => b.type === 'text' && b.text.startsWith('Tool: '));
    if (tool && !activity) {
      activity = document.createElement('details'); activity.className = 'turn-activity';
      activity.append(document.createElement('summary')); transcript.append(activity);
      activityCount = 0;
    } else if (!tool) activity = undefined;
    const article = document.createElement('article');
    article.className = tool ? 'activity' : m.role;
    const label = document.createElement('strong');
    label.textContent = tool ? m.role === 'toolResult' ? 'Tool result' : 'Tool request' : m.role === 'user' ? 'You' : 'Pi Accanto';
    if (!tool) label.className = 'message-label';
    article.append(label);
    for (const b of m.blocks) {
      if (b.type === 'text') {
        const p = document.createElement('pre'); p.style.whiteSpace = 'pre-wrap'; appendText(p, b.text); article.append(p);
      } else {
        const image = document.createElement('img');
        image.alt = 'Archived message image'; image.src = `data:${b.mime};base64,${b.data}`; image.style.maxWidth = '100%'; article.append(image);
      }
    }
    if (tool) {
      activity.firstChild.textContent = `Archived activity · ${counted(++activityCount, 'record')}`;
      activity.append(article);
    } else transcript.append(article);
  }
  const heading = document.createElement('h2'); heading.textContent = 'Archived sources'; transcript.append(heading);
  for (const [index, source] of chat.sources.entries()) {
    const section = document.createElement('section');
    section.id = `archived-source-${index}`;
    const name = document.createElement('p'); name.textContent = source.name; section.append(name);
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
        const pageControl = document.createElement('label'); pageControl.className = 'archive-page-control';
        pageControl.append('Page ', page, ` of ${source.pages}`);
        const read = document.createElement('button'); read.type = 'button'; read.textContent = 'Read PDF page text';
        const output = document.createElement('pre'); output.style.whiteSpace = 'pre-wrap'; output.setAttribute('role', 'status');
        read.onclick = async () => {
          read.disabled = true;
          try {
            const n = Number(page.value);
            if (!Number.isInteger(n) || n < 1 || n > source.pages) throw new Error('Choose a valid physical page.');
            const result = await readPdf(decode(source.data, 16 * 1024 * 1024), n, AbortSignal.timeout(30000), { page_count: 1 });
            output.textContent = result.pages.map(page => `Page ${page.page} of ${result.totalPages}\n${page.text || 'No native text on this page.'}${page.truncated ? '\nText limit reached; this page is only partially shown.' : ''}`).join('\n\n');
          } catch (error) { output.textContent = error.message; }
          finally { read.disabled = false; }
        };
        section.append(pageControl, read, output);
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
