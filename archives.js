// A separate, inert domain store. One transaction commits an entire import.
export async function archiveStore() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('accanto-portable-archives', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('chats', { keyPath: 'id' });
      request.result.createObjectStore('headers', { keyPath: 'id' });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}
async function operation(mode, run, storeName = 'chats') {
  const db = await archiveStore();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(mode === 'readwrite' ? ['chats', 'headers'] : storeName, mode);
      let result;
      try { result = run(tx.objectStore(storeName), tx); }
      catch {
        try { tx.abort(); } catch { /* It may already have been aborted by a failed write. */ }
        reject(new Error('Could not save archive. Free device storage and try again. No chats were imported.'));
        return;
      }
      tx.oncomplete = () => resolve(result?.result);
      tx.onerror = tx.onabort = () => reject(new Error('Could not save archive. Free device storage and try again. No chats were imported.'));
    });
  } finally { db.close(); }
}
export const listArchives = () => operation('readonly', store => store.getAll(), 'headers');
export const getArchive = id => operation('readonly', store => store.get(id));
export const importArchives = backup => operation('readwrite', (store, tx) => {
  for (const chat of backup.conversations) {
    const id = `archive-${crypto.randomUUID()}`;
    store.add({ ...chat, id, archived: true });
    tx.objectStore('headers').add({ id, title: chat.title, archived: true });
  }
});
