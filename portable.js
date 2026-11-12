// Portable domain data only. Never serialize durable documents, provider config,
// model objects, browser identities, or executable submission/task records.
export const BACKUP_LIMITS = { bytes: 80 * 1024 * 1024, decoded: 48 * 1024 * 1024, messages: 2000, sources: 10 };
const fail = () => { throw new Error('Invalid or unsupported backup. No conversations were changed.'); };
const string = (v, max) => typeof v === 'string' && v.length <= max;
export function base64(bytes) {
  let value = '';
  for (let i = 0; i < bytes.length; i += 8192) value += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(value);
}
export function decode(value, max) {
  if (!string(value, Math.ceil(max / 3) * 4) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail();
  const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
  if (!bytes.length || bytes.length > max || base64(bytes) !== value) fail();
  return bytes;
}
export function snapshotMessages(entries) {
  return entries.flatMap(entry => [
    ...(entry.kind === 'accanto.target' && entry.data?.target ? [{ role: 'user', blocks: [{ type: 'text', text: `Unavailable page reference: ${entry.data.target.title || ''}\n${entry.data.target.url || ''}\nReselect the tab in a new chat.` }] }] : []),
    ...(entry.model || []).filter(m => ['user', 'assistant', 'toolResult'].includes(m.role)).map(m => {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content || []).flatMap(b =>
      b.type === 'text' ? [{ type: 'text', text: b.text }] :
        b.type === 'image' ? [{ type: 'image', mime: b.mimeType, data: b.data }] :
          b.type === 'toolCall' ? [{ type: 'text', text: `Tool: ${b.name}\n${JSON.stringify(b.arguments)}` }] : []);
    if (!blocks.length && typeof m.errorMessage === 'string') blocks.push({ type: 'text', text: m.errorMessage });
    return { role: m.role, blocks };
  })]);
}
export function transcript(messages) {
  return messages.map(m => `${m.role}\n${m.blocks.map(b => b.type === 'text' ? b.text : `[Image: ${b.mime}]`).join('\n')}`).join('\n\n');
}
export async function validateBackup(value, inspect) {
  if (!value || value.format !== 'pi-accanto-archive' || value.version !== 1 || !Array.isArray(value.conversations) || !value.conversations.length || value.conversations.length > 20) fail();
  let total = 0, messageCount = 0;
  const conversations = [];
  for (const c of value.conversations) {
    if (!c || !string(c.title, 200) || !Array.isArray(c.messages) || !Array.isArray(c.sources) || c.sources.length > 10) fail();
    const messages = [];
    for (const m of c.messages) {
      if (++messageCount > BACKUP_LIMITS.messages || !m || !['user', 'assistant', 'toolResult'].includes(m.role) || !Array.isArray(m.blocks) || m.blocks.length > 100) fail();
      const blocks = [];
      for (const b of m.blocks) {
        if (b?.type === 'text' && string(b.text, 2 * 1024 * 1024)) {
          total += new TextEncoder().encode(b.text).length;
          blocks.push({ type: 'text', text: b.text });
        } else if (b?.type === 'image' && ['image/png', 'image/jpeg', 'image/webp'].includes(b.mime)) {
          const bytes = decode(b.data, 16 * 1024 * 1024);
          total += bytes.length;
          await inspect({ kind: 'image', mime: b.mime, bytes });
          blocks.push({ type: 'image', mime: b.mime, data: b.data });
        } else fail();
        if (total > BACKUP_LIMITS.decoded) fail();
      }
      messages.push({ role: m.role, blocks });
    }
    const sources = [], ids = new Set();
    let sourceBytes = 0;
    for (const s of c.sources) {
      if (!s || !string(s.id, 80) || !/^[a-zA-Z0-9_-]+$/.test(s.id) || ids.has(s.id) || !string(s.name, 240)) fail();
      ids.add(s.id);
      if (s.kind === 'tab') {
        if (!string(s.url, 8192) || !/^https?:\/\//.test(s.url)) fail();
        try { if (!['http:', 'https:'].includes(new URL(s.url).protocol)) fail(); } catch { fail(); }
        sources.push({ id: s.id, kind: 'tab', name: s.name, url: s.url });
      } else {
        if (!['text', 'pdf', 'image'].includes(s.kind)) fail();
        const extension = s.kind === 'pdf' ? /\.pdf$/i : s.kind === 'image' ? /\.(png|jpe?g|webp)$/i : /\.(txt|md|csv|json|log|tsv)$/i;
        if (/[/\\\u0000-\u001f]/.test(s.name) || !extension.test(s.name)) fail();
        const bytes = decode(s.data, (s.kind === 'text' ? 2 : 16) * 1024 * 1024);
        sourceBytes += bytes.length; total += bytes.length;
        if (sourceBytes > BACKUP_LIMITS.decoded || total > BACKUP_LIMITS.decoded) fail();
        const metadata = await inspect({ kind: s.kind, mime: s.mime, bytes });
        if (s.kind === 'image' && ((s.width !== undefined && s.width !== metadata.width) || (s.height !== undefined && s.height !== metadata.height))) fail();
        sources.push({ id: s.id, kind: s.kind, name: s.name, data: s.data, ...metadata });
      }
    }
    conversations.push({ title: c.title, messages, sources, transcript: transcript(messages) });
  }
  return { format: 'pi-accanto-archive', version: 1, conversations };
}
