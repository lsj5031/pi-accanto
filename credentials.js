const credentialFields = {
  apiKey: ['apiKey', 'apiKeyEndpoint', 'apiKeyApi'],
  tinyfishKey: ['tinyfishKey'],
  braveKey: ['braveKey', 'braveStorage'],
};

export async function readCredential(name) {
  const fields = credentialFields[name];
  const [session, saved] = await Promise.all([
    chrome.storage.session.get(fields),
    chrome.storage.local.get(fields),
  ]);
  // Keep a model key and its scope together, including legacy session keys.
  return { ...(session[name] ? session : saved), remember: session[name] ? false : true };
}

export async function saveCredential(name, values, remember) {
  const destination = remember ? 'local' : 'session';
  const other = remember ? 'session' : 'local';
  await chrome.storage[destination].set(values);
  await chrome.storage[other].remove(credentialFields[name]);
}

export async function forgetCredential(name) {
  await Promise.all([
    chrome.storage.local.remove(credentialFields[name]),
    chrome.storage.session.remove(credentialFields[name]),
  ]);
}
