import { listArchives } from './archives.js';
import { validDocumentId } from './document-identity.js';

chrome.action.onClicked.addListener(openAccanto);
chrome.commands.onCommand.addListener((command, tab) => { void handleCommand(command, tab); });

async function handleCommand(command, tab) {
  const action = { 'enlarge-chat': 'enlarge', 'open-chat-tab': 'tab' }[command];
  if (!action) return;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.url?.startsWith(chrome.runtime.getURL('panel.html'))) return;
  if (/^https?:/.test(tab.url || '') && !/\.pdf(?:[?#]|$)/i.test(tab.url)) await openCompanion(tab, action);
  else if (action === 'tab') await openAgentTab(/^(https?:|file:)/.test(tab.url || '') ? tab.id : undefined);
}

function openAccanto(tab) {
  if (/^https?:/.test(tab.url || '') && !/\.pdf(?:[?#]|$)/i.test(tab.url)) void openCompanion(tab);
  else void openAgentTab(/^(https?:|file:)/.test(tab.url || '') ? tab.id : undefined);
}

function openAgentTab(tabId, handoff = false) {
  const context = Number.isInteger(tabId) ? `tab=${tabId}` : 'web=1';
  return chrome.tabs.create({ url: chrome.runtime.getURL(`panel.html?${context}${handoff ? '#continue' : ''}`), active: !handoff });
}

async function openCompanion(tab, action) {
  try {
    // A toolbar click also restores a companion hidden on this website.
    const { companionHiddenSites = [] } = await chrome.storage.local.get('companionHiddenSites');
    const origin = new URL(tab.url).origin;
    if (companionHiddenSites.includes(origin)) {
      await chrome.storage.local.set({ companionHiddenSites: companionHiddenSites.filter(site => site !== origin) });
    }
    const injected = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['companion-host.js'] });
    if (!injected?.length || injected[0].error || !validDocumentId(injected[0].documentId)) throw new Error('Companion injection unavailable');
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'companion-open', action }, { frameId: 0 });
    if (!result?.ok) throw new Error('Companion unavailable');
  } catch {
    // Preserve the source tab when a document cannot host the companion.
    await openAgentTab(tab.id);
  }
}

// Automatic appearance on future visits requires a durable site grant.
let registration = Promise.resolve();
function syncCompanions() {
  registration = registration.catch(() => {}).then(async () => {
    const { origins = [] } = await chrome.permissions.getAll();
    const matches = origins.filter(origin => /^https?:/.test(origin));
    const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: ['accanto-companion'] });
    if (!matches.length) {
      if (scripts.length) await chrome.scripting.unregisterContentScripts({ ids: ['accanto-companion'] });
    } else {
      const script = { id: 'accanto-companion', matches, js: ['companion-host.js'], runAt: 'document_idle' };
      if (scripts.length) await chrome.scripting.updateContentScripts([script]);
      else await chrome.scripting.registerContentScripts([script]);
    }
    for (const tab of await chrome.tabs.query({})) {
      if (!/^https?:/.test(tab.url || '')) continue;
      // Chrome checks both durable grants and a still-valid toolbar activeTab
      // grant. An unrelated permission change must not remove the latter.
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['companion-host.js'] }).then(results => {
        if (!results?.length || results[0].error || !validDocumentId(results[0].documentId)) throw new Error('Companion injection unavailable');
      })
        .catch(() => chrome.tabs.sendMessage(tab.id, { type: 'companion-remove' }).catch(() => {}));
    }
  });
  return registration;
}
chrome.permissions.onAdded.addListener(() => { void syncCompanions(); });
chrome.permissions.onRemoved.addListener(() => { void syncCompanions(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.companionHiddenSites) void syncCompanions();
});
void syncCompanions();

const companionUrl = chrome.runtime.getURL('companion.html');
const panelUrl = chrome.runtime.getURL('panel.html');
const challenges = new Map();
const isCompanion = sender => sender.url?.split('?')[0] === companionUrl && Number.isInteger(sender.tab?.id) && sender.frameId > 0 && validDocumentId(sender.documentId);

async function trustedPanel(sender) {
  if (sender.url?.split('?')[0] === panelUrl) return true;
  if (!isCompanion(sender)) return false;
  const { companionDocuments = {} } = await chrome.storage.session.get('companionDocuments');
  return companionDocuments[sender.documentId] === sender.tab.id;
}

// Serialize catalog and tab-map updates in the service worker, including first
// initialization. Independent panels must never race to claim a tab or session.
let updates = Promise.resolve();
function revokeCompanions(tabId) {
  for (const pending of challenges.values()) if (pending.tabId === tabId) pending.finish({ error: 'The host document changed. Open Accanto again.' });
  updates = updates.catch(() => {}).then(async () => {
    const { companionDocuments = {} } = await chrome.storage.session.get('companionDocuments');
    for (const [id, tab] of Object.entries(companionDocuments)) if (tab === tabId) delete companionDocuments[id];
    await chrome.storage.session.set({ companionDocuments });
  });
}
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status === 'loading' || change.url) revokeCompanions(tabId);
  if (/^https?:/.test(change.url || '') && tab?.status === 'complete') {
    // Same-document navigation has no pagehide. Destroy its embedded runtime,
    // then restore only a launcher where the browser still grants access.
    void chrome.tabs.sendMessage(tabId, { type: 'companion-remove' }, { frameId: 0 }).catch(() => {})
      .then(() => syncCompanions());
  }
});
chrome.tabs.onRemoved.addListener(revokeCompanions);
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message.type === 'companion-restore' && sender.frameId === 0 && Number.isInteger(sender.tab?.id) && /^https?:/.test(sender.url || '')) {
    void syncCompanions();
    return;
  }
  if (message.type === 'companion-revoke' && sender.frameId === 0 && Number.isInteger(sender.tab?.id) && /^https?:/.test(sender.url || '')) {
    revokeCompanions(sender.tab.id);
    reply({ ok: true });
    return;
  }
  if (message.type === 'companion-authorize' && !isCompanion(sender)) {
    reply({ error: 'Open Accanto using its companion button. Exact document identity is required.' });
    return;
  }
  if (message.type === 'companion-authorize' && isCompanion(sender)) {
    // A public iframe URL is not an identity. Challenge the exact WindowProxy
    // retained by our isolated content script, then match its document ID.
    const challenge = crypto.randomUUID();
    const finish = (result) => {
      const pending = challenges.get(challenge);
      if (!pending) return;
      clearTimeout(pending.timer); challenges.delete(challenge); reply(result);
    };
    const timer = setTimeout(() => finish({ error: 'Open Accanto from its companion button.' }), 5000);
    challenges.set(challenge, { documentId: sender.documentId, tabId: sender.tab.id, finish, timer });
    const confirm = async () => {
      const pending = challenges.get(challenge);
      if (!pending) return;
      updates = updates.catch(() => {}).then(async () => {
        if (challenges.get(challenge) !== pending) return;
        const { companionDocuments = {} } = await chrome.storage.session.get('companionDocuments');
        if (challenges.get(challenge) !== pending) return;
        for (const [id, tabId] of Object.entries(companionDocuments)) if (tabId === sender.tab.id) delete companionDocuments[id];
        companionDocuments[sender.documentId] = sender.tab.id;
        await chrome.storage.session.set({ companionDocuments });
        if (challenges.get(challenge) !== pending) {
          delete companionDocuments[sender.documentId];
          await chrome.storage.session.set({ companionDocuments });
          return;
        }
        pending.finish({ tabId: sender.tab.id });
      });
      await updates;
    };
    challenges.get(challenge).confirm = confirm;
    void chrome.tabs.sendMessage(sender.tab.id, { type: 'companion-challenge', challenge }, { frameId: 0 }).then(result => {
      // Firefox can identify the exact retained frame without privileged
      // postMessage source semantics. Never accept a tab/frame/URL substitute.
      if (result?.documentId === sender.documentId) return confirm();
    })
      .catch(() => finish({ error: 'Companion unavailable. Open Accanto from the toolbar.' }));
    return true;
  }
  if (message.type === 'companion-confirm' && isCompanion(sender)) {
    const pending = challenges.get(message.challenge);
    if (!pending || pending.documentId !== sender.documentId || pending.tabId !== sender.tab.id) return;
    void pending.confirm().then(() => reply({ ok: true }), () => reply({ error: 'Companion authorization failed.' }));
    return true;
  }
  if (message.type === 'companion-tab' && sender.frameId === 0 && /^https?:/.test(sender.url || '')) {
    openAgentTab(sender.tab.id, true).then(() => reply({ ok: true }), error => reply({ error: error.message }));
    return true;
  }
  if (['companion-open-panel', 'companion-fallback-ready', 'companion-fallback-close'].includes(message.type)) {
    void (async () => {
      await updates;
      if (!isCompanion(sender) || !await trustedPanel(sender)) throw new Error('This window is not an authorized Accanto panel.');
      if (message.type === 'companion-open-panel') await openAgentTab(sender.tab.id);
      else await chrome.tabs.sendMessage(sender.tab.id, { type: message.type === 'companion-fallback-close' ? 'companion-close' : 'companion-ready' }, { frameId: 0 });
      return { ok: true };
    })().then(reply, error => reply({ error: error.message }));
    return true;
  }
  if (message.type !== 'conversation') return;
  updates = updates.then(async () => {
    if (!await trustedPanel(sender)) throw new Error('This window is not an authorized Accanto panel.');
    const session = await chrome.storage.session.get(['browserSession', 'tabConversations']);
    const browserSession = session.browserSession || crypto.randomUUID();
    const mapping = session.tabConversations || {};
    const { conversations = {} } = await chrome.storage.local.get('conversations');
    const archives = await listArchives();
    const archived = archives.find(chat => chat.id === message.id);
    if (archived) return { id: archived.id, browserSession, conversations: [...Object.values(conversations), ...archives.map(({ id, title }) => ({ id, title: `${title} · Archive` }))] };
    if (!Object.keys(conversations).length) {
      const databases = await indexedDB.databases();
      if (databases.some(database => ['pi-tab-live-v1', 'pi-tab-prototype-v1'].includes(database.name))) {
        conversations.legacy = { id: 'legacy', title: 'Earlier conversation' };
      }
    }
    let tabId = isCompanion(sender) ? sender.tab.id : message.tabId;
    if (!Number.isInteger(tabId)) {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      tabId = active?.id;
    }
    let tab;
    if (Number.isInteger(tabId)) tab = await chrome.tabs.get(tabId).catch(() => undefined);
    let id = message.id || mapping[tabId];
    if (message.id && !conversations[message.id]) throw new Error('Conversation not found. Choose a saved conversation.');
    if (!id || !conversations[id]) {
      id = crypto.randomUUID();
      conversations[id] = { id, title: tab?.title || 'New conversation' };
    }
    if (message.title) conversations[id].title = String(message.title).slice(0, 200);
    if (tab) mapping[tabId] = id;
    await chrome.storage.local.set({ conversations });
    await chrome.storage.session.set({ browserSession, tabConversations: mapping });
    return { id, tabId: tab?.id, browserSession, conversations: [...Object.values(conversations), ...archives.map(({ id, title }) => ({ id, title: `${title} · Archive` }))] };
  });
  updates.then(reply, error => reply({ error: error.message }));
  updates = updates.catch(() => {});
  return true;
});
