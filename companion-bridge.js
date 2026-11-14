// No storage or agent code runs until the worker verifies this exact iframe.
addEventListener('message', event => {
  if (event.source !== parent || event.data?.type !== 'accanto-challenge' || typeof event.data.challenge !== 'string') return;
  void chrome.runtime.sendMessage({ type: 'companion-confirm', challenge: event.data.challenge });
});
const authorization = await chrome.runtime.sendMessage({ type: 'companion-authorize' });
if (authorization?.error || !Number.isInteger(authorization?.tabId)) {
  document.body.replaceChildren(Object.assign(document.createElement('p'), { textContent: 'Open Accanto using its companion button, or your browser’s toolbar.' }));
} else if (chrome.runtime.getManifest().browser_specific_settings?.gecko) {
  // Firefox web-accessible iframes lack privileged APIs and partition durable
  // storage/locks from extension tabs. Never start a second agent in that domain.
  document.body.dataset.companionFallback = 'true';
  document.body.style.padding = '24px';
  const explanation = Object.assign(document.createElement('p'), { textContent: 'Firefox isolates embedded extension storage. Continue in an Accanto tab to keep your chats and active work together.' });
  const button = Object.assign(document.createElement('button'), { textContent: 'Open in a tab', type: 'button', className: 'btn' });
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const result = await chrome.runtime.sendMessage({ type: 'companion-open-panel' });
      if (!result?.ok) throw new Error(result?.error || 'Use Accanto’s toolbar to open a tab.');
    } catch (error) { explanation.textContent = error.message; }
    finally { button.disabled = false; }
  });
  const close = Object.assign(document.createElement('button'), { textContent: 'Close', type: 'button', className: 'btn' });
  close.addEventListener('click', () => { void chrome.runtime.sendMessage({ type: 'companion-fallback-close' }); });
  document.body.replaceChildren(explanation, button, close);
  await chrome.runtime.sendMessage({ type: 'companion-fallback-ready' });
} else {
  // Discard page-supplied query parameters: the actual sender tab is authoritative.
  history.replaceState(null, '', `companion.html?tab=${authorization.tabId}${location.hash === '#continue' ? '#continue' : ''}`);
  document.body.dataset.embedded = 'true';
  await import('./panel.js');
  parent.postMessage({ type: 'accanto-ready' }, '*');
}
