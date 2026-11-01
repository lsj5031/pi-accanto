# Pi Accanto

A little help, right beside your tab. **Accanto** is Italian for “beside” or
“next to.”

An extension-only Pi Durable 1.4.0 prototype for Chrome/Edge. No native host,
BrowserMCP, separate Pi process, or WASM is needed. Node is used only to build
and test the extension, not at runtime.

## Try it

Run `npm ci` and `npm run build` to create the extension bundle.

The built extension is in `dist/`. In Chrome's `chrome://extensions` (or Edge's
`edge://extensions`), enable Developer mode, choose **Load unpacked**, and select
this checkout's `dist` directory. The existing verified checkout is at
`T:\playground\pi-browser-prototype`; keep that path to preserve its extension ID.

Open a disposable website and click this extension's toolbar action (or use
Alt+Shift+P if available). The explicit action handler grants temporary access
to that tab and opens the sidebar. Invoke it again when moving to another site.

In **Model connection**, select **Local model · main**, enter the endpoint's
API key, and click **Connect**. The extension checks that `/models` lists `main`.
The key stays in `chrome.storage.session`; it is not bundled, written to
IndexedDB, or restored after a browser restart. Then ask a page question, or
focus a normal text input/textarea and ask the assistant to replace its text.
Editing emits input/change events but never clicks Submit. Websites can react
to those events, so use a disposable page.

The provider is `local-gguf`, at `http://192.168.1.111:11236/v1`, with model
`main`, OpenAI chat completions, reasoning enabled, and developer-role support
disabled. The supplied context/output limits and text/image model capabilities
are configured. Browser tools currently supply text only. The manifest permits
the model host, and CSP limits network connections to this endpoint and port.

**Live workflow verified:** the actual Chrome for Testing 156.0.8078.74 sidebar
completed three invoice-reading cases ($90.75, $65.35, $47.00), three exact-text
edits without submission, password exclusion, streaming model requests, Stop,
recovery after Stop, and history/session-credential restoration after reload.
The offline regression suite also passes, including browser-restart history
persistence. These are prototype checks on a disposable fixture, not a claim of
compatibility with every website.

The initial live request failed with HTTP 403 because Splash rejected the
extension's Origin. With the user's approval, the Mitori runner's installed
`/Users/leo/Code/splash-runtime/current/server/http_security.py` now allows exactly
`chrome-extension://cpagjnnhdjoiccpfdnioojedbmeajjgp` through its same-origin
comparison, after Host and duplicate-header checks. Service `ai.mitori.splash`
was restarted. Other tested extension/web origins and untrusted Hosts remain
rejected. The extension does not strip Origin headers or disable browser
security. Loading the unpacked extension from a different path may change its
ID and require updating this allowance.

This is an installed-runtime patch; a Splash upgrade can overwrite it. To roll
it back, restore `if origins:` in that file, remove its two exception comments,
and restart the service. No launcher or launchd configuration was changed.
The server inspection also found that API-key authentication was already
unconfigured: inference without a key succeeds before and after the patch.
The origin exception preserves that existing setting; the extension's key
field does not mean the current server enforces authentication.

For a credential-free browser-tool check, choose **Offline scripted check**
and click **Connect**. Every instruction except `Type: ...` runs inspection;
`Type: replacement text` replaces the focused field. This uses Pi's real Faux
provider and performs no AI inference. Offline and live history use separate
IndexedDB databases.

## Architecture

- Sidebar owns the Pi harness for its lifetime.
- Pi Durable calls custom extension tools through `chrome.scripting`.
- IndexedDB stores the conversation, including inspected text and field contents.
- A Web Lock prevents two panels from opening the same store concurrently.
- Each request captures the active tab once. Tool calls keep that target.
- Browser tools are not declared replay-safe. Old work is not explicitly resumed
  on startup, and a new request does not restore its old tab binding.
- Closing the panel destroys its runtime; history is restored on reopening.
  This does not promise unattended background execution or rollback of an action
  already dispatched.

## Build and checks

```powershell
npm ci
npm run build
npx playwright install chromium
npm test
```

`npm test` loads the bundled MV3 extension in an isolated Chromium profile with
the scripted provider. It checks browser tool execution, password exclusion,
exclusive ownership, reload, and browser-restart persistence. It renders an
extension tab at sidebar width and grants the test copy loopback access.

`npm run test:sidebar` runs the actual Windows Chrome sidebar. It uses native
mouse input on Chrome's Extensions menu and toolbar action, then attaches to
the real `SIDE_PANEL` target through CDP. The shipped manifest is unmodified;
the test asserts the action granted `activeTab` access. It enters the credential
from `%USERPROFILE%\.pi\agent\models.json` without logging it and attempts live
inference, then checks inspection, focused editing without submission, password
exclusion, Stop/recovery, and reload with the real model. It also runs the
scripted browser-tool controls independently. It exits nonzero if live inference
fails, even when scripted controls pass. Screenshots and the response report
are saved under
`../.amp/in/artifacts/pi-browser-prototype/`.

The native test currently expects Chrome for Testing 156.0.8078.74, matching the
installed Chrome version, at
`../.amp/in/chrome-testing/chrome/win64-156.0.8078.74/chrome-win64/chrome.exe`.
Install it with `npx @puppeteer/browsers install chrome@156.0.8078.74 --path ../.amp/in/chrome-testing`.
Both tests use disposable browser profiles and fixture servers and clean them up.

Unattended execution while the panel is closed and recovery of an action
interrupted by closing the browser are not promised. Edge has not been tested.
Code Mode / QuickJS WASM is not included.
