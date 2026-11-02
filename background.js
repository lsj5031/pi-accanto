chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
// One stable panel path per browser tab lets Chrome retain separate panel
// contexts. Conversation IDs also work in ordinary extension tabs.
async function configurePanel(tabId) {
  await chrome.sidePanel.setOptions({ tabId, path: `panel.html?tab=${tabId}`, enabled: true });
}

chrome.tabs.onCreated.addListener(tab => { void configurePanel(tab.id); });
void chrome.tabs.query({}).then(tabs => Promise.all(tabs.map(tab => configurePanel(tab.id))));
chrome.action.onClicked.addListener((tab) => {
  // Keep opening inside the toolbar action's user gesture.
  void chrome.sidePanel.open({ tabId: tab.id });
});

// Serialize catalog and tab-map updates in the service worker, including first
// initialization. Independent panels must never race to claim a tab or session.
let updates = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || message.type !== 'conversation') return;
  updates = updates.then(async () => {
    const session = await chrome.storage.session.get(['browserSession', 'tabConversations']);
    const browserSession = session.browserSession || crypto.randomUUID();
    const mapping = session.tabConversations || {};
    const { conversations = {} } = await chrome.storage.local.get('conversations');
    if (!Object.keys(conversations).length) {
      const databases = await indexedDB.databases();
      if (databases.some(database => ['pi-tab-live-v1', 'pi-tab-prototype-v1'].includes(database.name))) {
        conversations.legacy = { id: 'legacy', title: 'Earlier conversation' };
      }
    }
    let tabId = message.tabId;
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
    return { id, tabId: tab?.id, browserSession, conversations: Object.values(conversations) };
  });
  updates.then(reply, error => reply({ error: error.message }));
  updates = updates.catch(() => {});
  return true;
});
