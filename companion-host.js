// This script runs in Chrome's isolated world. The page never receives model
// keys, conversation messages, or an API that can invoke agent tools.
(() => {
  if (globalThis.accantoCompanion || !/^https?:$/.test(location.protocol) || document.contentType !== 'text/html') return;
  globalThis.accantoCompanion = true;
  const origin = location.origin;
  const extensionOrigin = new URL(chrome.runtime.getURL('/')).origin;
  const host = document.createElement('div');
  host.setAttribute('data-accanto-companion', '');
  host.style.cssText = 'all:initial!important;position:fixed!important;inset:auto 24px 24px auto!important;z-index:2147483647!important;pointer-events:none!important;color-scheme:light!important';
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `<style>
    *{box-sizing:border-box}button{font:13px/1.4 system-ui,sans-serif;cursor:pointer;color:#3b5434}button:focus-visible{outline:2px solid #487340;outline-offset:3px}button:active:not(:focus-visible){transform:scale(.97)}[hidden]{display:none!important}
    button:disabled{opacity:.45;cursor:default}
    .launcher{pointer-events:auto;display:grid;place-items:center;width:52px;height:52px;border:1px solid #cddcbe;border-radius:20px;background:#e8efdc;box-shadow:0 4px 14px #23321a15;transition:transform 140ms cubic-bezier(.23,1,.32,1),background-color 140ms ease}
    .face{position:relative;width:26px;height:23px;border-radius:9px;background:#8da76e}.face:before,.face:after{content:'';position:absolute;top:8px;width:3px;height:7px;border-radius:3px;background:#fff}.face:before{left:7px}.face:after{right:7px}
    .launcher[data-busy=true]:after{content:'';position:absolute;right:1px;top:1px;width:9px;height:9px;border:2px solid white;border-radius:50%;background:#486b36}
    .window{pointer-events:auto;position:relative;width:min(380px,calc(100vw - 24px));height:min(420px,calc(100dvh - 48px));min-width:min(300px,calc(100vw - 24px));min-height:min(320px,calc(100dvh - 48px));max-width:calc(100vw - 24px);max-height:calc(100dvh - 48px);border:1px solid #d9e2cf;border-radius:20px;background:#fcfdf8;box-shadow:0 16px 54px #23321a26;overflow:hidden}
    .window[data-closed=true]{position:absolute;right:0;bottom:0;opacity:0;pointer-events:none;clip-path:inset(100%)}
    iframe{border:0;width:100%;height:100%;display:block;background:#fcfdf8}
    .grip{pointer-events:auto;position:absolute;z-index:1;left:calc(50% - 32px);top:0;width:64px;height:13px;padding:0;border:0;background:transparent;cursor:grab;touch-action:none}.grip:after{content:'';display:block;width:26px;height:3px;margin:auto;border-radius:4px;background:#dbe3cf}.grip:active{cursor:grabbing;transform:none}
    .grip:focus-visible{outline-offset:-2px;border-radius:5px}
    .menu,.fallback{pointer-events:auto;position:absolute;right:0;bottom:62px;width:210px;padding:6px;border:1px solid #d9e2cf;border-radius:12px;background:#fcfdf8;box-shadow:0 6px 24px #23321a20;font:13px/1.5 system-ui,sans-serif;color:#465a3c}.menu button{display:block;width:100%;padding:9px;border:0;border-radius:6px;text-align:left;background:transparent}.fallback{bottom:0;width:100%;height:100%;padding:64px 24px 24px}.fallback button{padding:9px 12px;border:1px solid #cddcbe;border-radius:8px;background:#e8efdc}.fallback p{margin:0 0 18px}
    @media(hover:hover) and (pointer:fine){.launcher:hover{background:#dfe9d1;transform:translateY(-2px)}.launcher:hover .face:before,.launcher:hover .face:after{height:5px;transform:translateY(-1px)}.menu button:hover{background:#edf2e5}}
    @media(max-width:480px){.window{width:calc(100vw - 24px)}}
    @media(prefers-reduced-motion:reduce){.launcher{transition:none}.launcher:hover,button:active{transform:none}}
  </style>
  <button class="launcher" aria-label="Open Accanto" aria-expanded="false" title="Accanto · Right-click for options"><span class="face" aria-hidden="true"></span></button>
  <div class="menu" hidden><button data-action="tab">Open in a tab</button><button data-action="hide">Hide on this site</button></div>
  <section class="window" data-closed="true" aria-label="Accanto companion" inert hidden>
    <button class="grip" aria-label="Move Accanto. Drag or use arrow keys." title="Drag to move"></button>
    <div class="fallback" hidden><p>This page could not open the companion. Continue in an Accanto tab.</p><button data-action="tab">Open in a tab</button></div>
  </section>`;
  const launcher = shadow.querySelector('.launcher');
  const card = shadow.querySelector('.window');
  const grip = shadow.querySelector('.grip');
  const menu = shadow.querySelector('.menu');
  let frame;
  let open = false;
  let timer;
  let drag;
  let restoreBounds;
  const place = (right, bottom) => {
    const width = open ? card.offsetWidth : 52;
    const height = open ? card.offsetHeight : 52;
    host.style.setProperty('right', `${Math.max(12, Math.min(right, innerWidth - width - 12))}px`, 'important');
    host.style.setProperty('bottom', `${Math.max(12, Math.min(bottom, innerHeight - height - 12))}px`, 'important');
  };
  const clamp = () => place(parseFloat(host.style.right), parseFloat(host.style.bottom));
  const windowState = () => frame?.contentWindow.postMessage({ type: 'accanto-window-state', enlarged: Boolean(restoreBounds) }, extensionOrigin);
  const enlarge = () => {
    if (restoreBounds) {
      card.style.width = `${restoreBounds.width}px`;
      card.style.height = `${restoreBounds.height}px`;
      place(restoreBounds.right, restoreBounds.bottom);
      restoreBounds = undefined;
    } else {
      restoreBounds = { width: card.offsetWidth, height: card.offsetHeight, right: parseFloat(host.style.right), bottom: parseFloat(host.style.bottom) };
      card.style.width = `${Math.min(900, innerWidth - 24)}px`;
      card.style.height = `${innerHeight - 48}px`;
      place((innerWidth - card.offsetWidth) / 2, 24);
    }
    windowState();
  };
  const minimize = () => {
    open = false;
    card.dataset.closed = 'true';
    card.inert = true;
    launcher.hidden = false;
    launcher.setAttribute('aria-expanded', 'false');
    launcher.focus({ preventScroll: true });
    clamp();
  };
  const remove = event => {
    void chrome.runtime.sendMessage({ type: 'companion-revoke' }).catch(() => {});
    removeEventListener('pagehide', remove);
    if (event?.type !== 'pagehide') removeEventListener('pageshow', restored);
    clearTimeout(timer); host.remove(); chrome.runtime.onMessage.removeListener(receive); chrome.storage.onChanged.removeListener(hiddenChanged); removeEventListener('message', fromFrame); removeEventListener('resize', clamp); globalThis.accantoCompanion = false;
  };
  addEventListener('pagehide', remove, { once: true });
  const restored = event => {
    // BFCache must create a fresh iframe, never resume the old agent.
    if (event.persisted) {
      removeEventListener('pageshow', restored);
      void chrome.runtime.sendMessage({ type: 'companion-restore' }).catch(() => {});
    }
  };
  addEventListener('pageshow', restored);
  const hiddenChanged = (changes, area) => { if (area === 'local' && changes.companionHiddenSites?.newValue?.includes(origin)) remove(); };
  const receive = (message, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message.type === 'companion-ready') { clearTimeout(timer); shadow.querySelector('.fallback').hidden = true; }
    if (message.type === 'companion-close') minimize();
    if (message.type === 'companion-challenge' && frame?.contentWindow) {
      if (typeof chrome.runtime.getDocumentId === 'function') {
        Promise.resolve(chrome.runtime.getDocumentId(frame)).then(documentId => reply({ documentId }), () => reply({ ok: false }));
        return true;
      }
      frame.contentWindow.postMessage({ type: 'accanto-challenge', challenge: message.challenge }, extensionOrigin);
      reply({ ok: true });
    }
    if (message.type === 'companion-open') {
      if (message.action === 'tab') {
        openTab().then(() => reply({ ok: true }), () => reply({ ok: false }));
        return true;
      }
      show();
      if (message.action === 'enlarge') enlarge();
      reply({ ok: true });
    }
    if (message.type === 'companion-remove') remove();
  };
  const fromFrame = event => {
    if (!frame || event.origin !== extensionOrigin || event.source !== frame.contentWindow) return;
    if (event.data?.type === 'accanto-ready') { clearTimeout(timer); shadow.querySelector('.fallback').hidden = true; windowState(); }
    if (event.data?.type === 'accanto-minimize') minimize();
    if (event.data?.type === 'accanto-window' && open) {
      if (event.data.action === 'enlarge') enlarge();
    }
    if (event.data?.type === 'accanto-busy') {
      launcher.dataset.busy = String(event.data.busy === true);
      menu.querySelector('[data-action=tab]').disabled = event.data.busy === true;
    }
  };
  chrome.runtime.onMessage.addListener(receive);
  chrome.storage.onChanged.addListener(hiddenChanged);
  addEventListener('message', fromFrame);
  addEventListener('resize', clamp);
  const show = () => {
    open = true;
    menu.hidden = true;
    card.hidden = false;
    card.inert = false;
    card.dataset.closed = 'false';
    launcher.hidden = true;
    launcher.setAttribute('aria-expanded', 'true');
    clamp();
    if (!frame) {
      frame = document.createElement('iframe');
      frame.title = 'Pi Accanto assistant';
      frame.src = chrome.runtime.getURL('companion.html');
      frame.allow = 'clipboard-write';
      card.append(frame);
      timer = setTimeout(() => { shadow.querySelector('.fallback').hidden = false; }, 6500);
    } else frame.contentWindow.focus();
  };
  launcher.addEventListener('click', show);
  launcher.addEventListener('contextmenu', event => { event.preventDefault(); menu.hidden = !menu.hidden; if (!menu.hidden) menu.querySelector('button:not(:disabled)').focus(); });
  const openTab = async () => {
    if (menu.querySelector('[data-action=tab]').disabled) return;
    const result = await chrome.runtime.sendMessage({ type: 'companion-tab' });
    if (result?.error) { shadow.querySelector('.fallback p').textContent = 'Accanto could not open a tab. Try again using the toolbar icon.'; shadow.querySelector('.fallback').hidden = false; }
    else minimize();
    menu.hidden = true;
  };
  shadow.addEventListener('keydown', event => {
    if (event.key === 'Escape' && open && shadow.activeElement === grip) {
      event.preventDefault();
      frame.contentWindow.focus();
      return;
    }
    if (event.key === 'Escape') { menu.hidden = true; if (open) minimize(); else launcher.focus(); }
  });
  shadow.addEventListener('click', async event => {
    if (!event.isTrusted) return;
    const action = event.target.dataset.action;
    if (action === 'tab') await openTab();
    if (action === 'hide') {
      const { companionHiddenSites = [] } = await chrome.storage.local.get('companionHiddenSites');
      await chrome.storage.local.set({ companionHiddenSites: [...new Set([...companionHiddenSites, origin])] });
      remove();
    }
  });
  grip.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    grip.focus({ preventScroll: true });
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, right: parseFloat(host.style.right), bottom: parseFloat(host.style.bottom) };
    grip.setPointerCapture(event.pointerId);
  });
  grip.addEventListener('pointermove', event => { if (drag?.id === event.pointerId) place(drag.right + drag.x - event.clientX, drag.bottom + drag.y - event.clientY); });
  grip.addEventListener('lostpointercapture', () => { drag = undefined; });
  grip.addEventListener('pointerup', event => { if (drag?.id === event.pointerId) { grip.releasePointerCapture(event.pointerId); drag = undefined; } });
  grip.addEventListener('keydown', event => {
    const moves = { ArrowLeft: [16, 0], ArrowRight: [-16, 0], ArrowUp: [0, 16], ArrowDown: [0, -16] };
    const delta = moves[event.key];
    if (delta) { event.preventDefault(); place(parseFloat(host.style.right) + delta[0], parseFloat(host.style.bottom) + delta[1]); }
  });
  void chrome.storage.local.get('companionHiddenSites').then(({ companionHiddenSites = [] }) => {
    if (companionHiddenSites.includes(origin)) remove();
    else { document.documentElement.append(host); clamp(); }
  });
})();
