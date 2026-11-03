// No storage or agent code runs until the worker verifies this exact iframe.
addEventListener('message', event => {
  if (event.source !== parent || event.data?.type !== 'accanto-challenge' || typeof event.data.challenge !== 'string') return;
  void chrome.runtime.sendMessage({ type: 'companion-confirm', challenge: event.data.challenge });
});
const authorization = await chrome.runtime.sendMessage({ type: 'companion-authorize' });
if (authorization?.error || !Number.isInteger(authorization?.tabId)) {
  document.body.replaceChildren(Object.assign(document.createElement('p'), { textContent: 'Open Accanto using its companion button, or Chrome’s toolbar.' }));
} else {
  // Discard page-supplied query parameters: the actual sender tab is authoritative.
  history.replaceState(null, '', `companion.html?tab=${authorization.tabId}${location.hash === '#continue' ? '#continue' : ''}`);
  document.body.dataset.embedded = 'true';
  await import('./panel.js');
  parent.postMessage({ type: 'accanto-ready' }, '*');
}
