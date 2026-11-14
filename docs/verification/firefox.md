# Experimental Firefox desktop port

This is an **unsigned developer build**, not an approved Firefox distribution.
The minimum is Firefox **153.0**, the documented floor for the exact-document
identity APIs. Missing document IDs still fail closed on newer browsers.
Android and private browsing are excluded. Firefox 158.0.1 was available locally;
that is not evidence for the latest stable or current ESR.

## Build and temporarily install

Use Node.js 22+ and the locked dependencies. From the checkout:

```sh
npm ci
node build.mjs --browser=firefox
node package-extension.mjs --browser=firefox
```

The output is `dist-firefox/` and
`artifacts/pi-accanto-0.3.0-firefox.zip`. Default `node build.mjs` still builds
Chrome into `dist/`; default packaging still produces `pi-accanto-VERSION.zip`.
Both include local QuickJS/PDF workers, decoder assets and license notices.

1. Use a separate, disposable Firefox profile, created through `about:profiles`.
   Do not use a profile with saved logins, private tabs or important extension data.
2. Open `about:debugging#/runtime/this-firefox`.
3. Choose **Load Temporary Add-on**, then choose **manifest.json** inside
   `dist-firefox/`, or inside the extracted Firefox ZIP. Do not choose the source
   checkout's Chrome manifest or the Chrome ZIP.
4. Open a normal HTTP(S) webpage and click Accanto's toolbar action. On granted
   sites its companion launcher can appear automatically. The Firefox companion
   explains its limitation and offers **Open in a tab**.

The temporary extension disappears when Firefox restarts. Do not rely on temporary
installation as durable storage or recovery. Back up test chats before removing
or replacing it. After rebuilding, choose **Reload** in `about:debugging`, refresh
host tabs and reenter session-only keys. Stop active work before reloads.

Ordinary persistent installation requires a **Mozilla-signed XPI**, including
self-distribution. A ZIP or renamed unsigned XPI is not a signed install. There
are no signature-bypass steps here.

## Why the Firefox companion opens a tab

Observed in Firefox 158.0.1, the public companion iframe exposes a restricted
content-context API surface: `tabs`, `scripting`, `permissions`, `commands`,
`windows` and `storage.session` are unavailable. A temporary API bridge proved
the more serious problem: iframe IndexedDB, Web Locks and BroadcastChannel did
not share the standalone panel's ownership domain. Two runtimes could acquire
the same conversation independently. A nested private extension iframe did not
restore privileged APIs.

The bridge was removed. The Firefox frame **does not import panel/agent code or
open conversation storage**. It authenticates its exact browser-issued document
against the isolated host's retained iframe, then offers a narrowly scoped
background action to open the source tab's standalone panel. Rogue public frames
cannot use that action. Chrome retains its existing full embedded companion.
Navigation, reload, removal and permission loss revoke companion authorization;
BFCache restoration creates a fresh launcher rather than resuming the old frame.

Full embedded Firefox chat, shared iframe/standalone ownership and clipboard
parity remain blocked. Solving them needs a separately designed and reviewed
execution/storage architecture, not a relaxed document check or a second store
presented as the same conversation.

## Automated qualification

After packaging both targets, run `npm run test:browser-target`,
`npm run test:firefox:distribution` and `npm run test:firefox`.
The browser harness uses installed Selenium/geckodriver with fresh temporary
profiles and the actual `dist-firefox/`, never a patched test bundle.
`ACCANTO_ARTIFACT_DIR` redirects logs and screenshots outside the checkout.
See [contributor instructions](../../CONTRIBUTING.md#experimental-firefox-build)
for executable overrides.

The security and fallback suites check the authorized launcher, no embedded
conversation database/lock/agent import, source-bound standalone opening,
rogue broker/action rejection, stale document targeting, navigation/reload
cleanup and removal of a live permission grant. Exclusive ownership is tested
between standalone tabs, not between an iframe and a tab. Separate suites cover
local synthetic streaming, selected PDF bytes, Wasm/Stop/timeout and inert
portable backup import. Optional permissions are granted through isolated
browser test privileges, not native permission dialogs. CI currently validates
the Firefox package only; real Firefox tests require an installed browser/driver.

## A keyless local check

No API key, AI service or internet connection is needed for scripted checks.

1. Serve a local fixture with your normal local HTTP server. For example, from
   this checkout run `python3 -m http.server 8765 --bind 127.0.0.1`, then open
   `http://127.0.0.1:8765/docs/examples/code-mode-invoice.html`.
2. Click Accanto in the toolbar, then **Open in a tab** in its companion.
   In Settings, expand **Developer tools**, choose **Offline scripted check**
   and click **Connect**. This mode uses deterministic tool calls, not a model.
3. If page access is missing, choose **Allow this site** in the Accanto panel.
   Approve Firefox's real dialog, then choose **Use this page** or retry.
   Decline once and retry to check honest feedback. Toolbar access is temporary;
   automatic launchers require a durable website grant.
4. Run `Inspect this tab`. Check the invoice text in the tool result.
   Run `Code: text(3 * 27.50 + 8.25);` and check `90.75`.
   Also try `Code: text(JSON.parse(await tools.inspect_tab({})).title);`.
   **Stop** must cancel active work, and leaving/reloading a host page must not
   restart an old run.
5. Use **+ → Choose browser tab** to select a second normal page. Selection reads
   identity only; it does not scan other tabs' text. Read it explicitly with
   `Code: text(JSON.parse(await tools.list_sources({})));`, then use its returned
   source ID with `tools.read_source({source_id:"ID"})`. Reload that selected tab
   and confirm the old source is unavailable until explicitly selected again.
6. In Settings, remove all-site access if you granted it. **Restore service
   access** is a separate click, so its native request has a fresh user gesture.
   It restores only configured model/search services, not arbitrary websites.

Scripted `Search:` commands still contact the selected real search provider.
Do not use them for an offline check. Automated transport tests should use local
synthetic model/research endpoints, never personal keys. A real model connection
sends its scoped key to the configured endpoint even for the catalog check.

## Selected PDF files, backups and shortcuts

- Firefox's native PDF viewer rejects injected scripts, including extensionless
  PDF URLs. File-scheme access does not fix that. Click the toolbar to open an
  Accanto panel, choose **Web only · No page attached**, then **+ → Attach files**
  and select the PDF yourself. The original stays local; requested text/images
  enter model requests when using a model. Chrome's existing native-PDF path is
  unchanged.
- In scripted mode, use `Code: text(JSON.parse(await tools.list_sources({})));`
  to obtain the selected PDF ID, then
  `Code: text(await tools.read_source({source_id:"ID",start_page:1}));`.
  Native text works without vision. Visual PDF reads must be direct model tool
  calls, not Code Mode; existing render, size, page-count and timeout limits apply.
- Limits remain 10 sources, 16 MiB per file, 2 MiB per text file, 48 MiB combined,
  and 16 megapixels per image. Selected originals and extracted content are not
  encrypted by Accanto.
- Open an idle chat in a tab, then Settings → **Save this chat backup**. Import
  the selected JSON backup and confirm **Import new archives**. Check that it
  creates a new read-only archive, not a resumed task. Keys, settings, permissions,
  active work and browser document/session IDs are excluded. Exported content
  can itself contain secrets. Keep test backups local.
- Open the keyboard-shortcut help. **Customize shortcuts** uses Firefox's
  shortcut settings, not `chrome://extensions/shortcuts`. Check actual
  assignments and conflicts. The default toolbar shortcut is Alt+Shift+Q;
  Alt+Shift+S opens the page chat in a tab. Enlarge/restore only affects the
  Firefox fallback container, not an embedded chat. Native OS shortcut delivery,
  clipboard and chooser/dialog acceptance need separate visible-browser checks.

## Data, identity and release gates

Chrome and Firefox have separate extension stores and permissions. Migrate
readable chats using portable backups, not profile copying. Profile isolation
also does not make material safe to send to a configured service. See
[PRIVACY.md](../../PRIVACY.md) for recipients, local persistence and deletion.

The development Gecko ID is `pi-accanto@lsj5031.github.io`. Its final reservation
and release ownership are not established. It is **not** Firefox's runtime
`moz-extension://UUID` origin. Runtime UUIDs depend on the installation/profile;
do not configure a gateway with the Gecko ID or the Chrome public-key origin as
though either were Firefox's origin. Allow only the intended runtime origin
where your gateway requires it. Host permissions do not override server
authentication or origin policy.

Firefox host permission patterns cover a scheme/hostname across ports. Accanto
omits ports in Firefox permission patterns but keeps the exact configured URL
for requests and credential scoping. Granting `http://localhost/*` is therefore
not a port-limited grant; local transport tests should use disposable profiles.
No wildcard gateway-origin policy is required or recommended.

The generated manifest declares required potential transmissions:
`websiteContent`, `browsingActivity`, `searchTerms`, `personalCommunications`,
and `authenticationInfo`. These correspond to user-selected page/file content,
URLs, questions/searches and scoped provider credentials. They do not mean that
the whole browsing history is uploaded or that the project operates a backend.
There is no optional-data-consent bypass. Final Mozilla category/consent review,
including sensitive user-supplied content, remains a distribution gate.

No signing submission, AMO approval or signed-install/update verification has
been performed. Code Mode's model-generated programs and the reproducibly
bounded, modified PDF.js worker need explicit Mozilla policy review. Do not
remove CSP, sandbox/decoder limits or provenance checks to obtain approval.
Latest stable, current ESR, other desktop OSes, containers/authenticated PDF
fetching, restart/update persistence and native permission/clipboard/shortcut
behavior remain separate qualification work.
