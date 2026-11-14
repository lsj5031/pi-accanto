// Firefox match patterns grant a host across ports. A port-bearing pattern can
// pass permission storage checks without granting network access.
export function hostPermission(value, manifest = chrome.runtime.getManifest()) {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol)) throw new Error('Website access requires an HTTP(S) address.');
  return `${url.protocol}//${manifest.browser_specific_settings?.gecko ? url.hostname : url.host}/*`;
}
