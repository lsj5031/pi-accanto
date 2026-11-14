# Contributing

This is an early Chrome extension release. Edge, arbitrary model profiles and
unattended execution are not verified. Start with a focused issue or pull request
that explains the user-visible behavior and how it was checked.

## Reproduce the fixture checks

Use Node.js 22 or later. From the repository root:

```sh
npm ci
npx playwright install chromium
npm run build
npm run test:fixtures
```

On Linux, use `npx playwright install --with-deps chromium` to install Chromium's
system dependencies too. Tests run headlessly using Playwright's full Chromium,
disposable profiles and local fixtures. Research-provider responses are mocked;
no model credentials or personal Pi configuration files are loaded. GitHub
Actions runs the same commands. Build/install steps need network access; fixture
tests do not require a live search or model service.

Run an individual suite with `npm test`, `npm run test:pdf`,
`npm run test:conversations`, `npm run test:research` or `npm run test:companion`. Add `-- --headed` to see
its browser. Set `ACCANTO_CHROME_EXECUTABLE` to an absolute browser executable
path for a different Chromium build; CI uses the Playwright-pinned version instead.
Artifacts default to ignored `test-results/`; `ACCANTO_ARTIFACT_DIR` overrides
the output root. Read [PRIVACY.md](PRIVACY.md) before sharing test reports.

## Build an installable download

Run `npm run package` to rebuild and create `artifacts/pi-accanto-VERSION.zip`.
The ZIP contains `manifest.json` at its root, bundled scripts, runtime assets and
license notices. Packaging uses `zip` on macOS/Linux or PowerShell's
`Compress-Archive` on Windows. Run `npm run test:distribution` to check packaging
and extract/verify the actual download. Without a packaged build, that last
check is explicitly skipped.

Successful CI runs upload the ZIP as the **extension-download** artifact after
fixture checks pass. Download and extract both the artifact wrapper and the
extension ZIP before using Chrome's **Load unpacked**. The source manifest opens
build instructions; the build removes that popup so the toolbar opens Accanto.
This developer workflow does not publish releases. The separate tag-triggered
release workflow publishes a directly installable ZIP and SHA256SUMS only after
all required gates. There is no Chrome Web Store integration.

For a release, follow [distribution verification and operator steps](docs/verification/distribution.md).
`npm run release:prepare -- v0.3.0` validates versions and the actual packaged
ZIP offline and writes checksums/release notes. Add `--verify` to check those
files without writing. Release tooling requires Linux/macOS `zip` and `unzip`;
the automated publisher runs on Linux. Never change the stable manifest key.
Maintainers must protect `main`, `v*` tags, and the `release` environment. Only a
reviewed main commit may be tagged. A tag workflow's code runs before ancestry
checks, so ancestry alone is not a substitute for tag and environment protection.

`npm run test:portable` adds pure schema/allowlist boundaries and real Chromium
export/restore under a fresh extension identity, with generated data and no paid
model. Archives use a separate version-1 IndexedDB domain store and atomic
imports; they never import Pi Durable task/lease documents. Export reads through
`Conversation.entries()` and the attachment collection's snapshot API, not raw
durable database internals. Backups deliberately restore readable archived chats,
not executable task state. `npm run test:release` checks the real packaged ZIP
and failure cases. Both are CI gates; portable tests are in `test:fixtures`.

The manifest's `key` is a public RSA key that pins the unpacked extension ID to
`iojliefpiallbakabkahmiaadgmlfjkf`. Preserve it across builds and releases.
No private signing key is stored or needed for unpacked installs. Changing the
public key creates a new extension identity, storage namespace and gateway origin.
`npm run test:identity` loads the real build from two different paths in disposable
Chrome profiles and checks that both IDs match. Build first; browser selection
uses the same `ACCANTO_CHROME_EXECUTABLE` override as the other browser fixtures.

`npm run test:permissions` checks the production all-site permission handler's
pending, denial, retry and removal feedback with controlled Chrome API responses.
It does not verify the native permission dialog. Native acceptance/denial still
needs a visible browser and a fresh profile without pre-granted website access.

`npm run test:panel-state` exercises Stop during each asynchronous preparation
stage and while submission is being queued. The companion fixtures additionally
cover drafts across idle/deferred model-change reloads, two-way page-context
switching, configuration versus chat verification, and rendered text contrast.

`npm run test:attachments` is the focused multi-source suite (also part of
`test:fixtures` and CI). It uses real file inputs, drag/drop/paste events,
PDF.js, the shipped source collection and Code Mode, plus a local faux HTTP
provider through the production Chat Completions adapter. It asserts actual
outbound image bytes and PDF/text tool evidence, not model understanding.
No real keys, payments, profiles or external model/search calls are used.
The companion suite also attaches/removes a long-named text file in the actual
authenticated compact and enlarged iframe.

`npm run test:pdf` also runs `test-pdf-visual.mjs`: real Chromium renders a mixed
15-page raster/text/blank fixture, checks pixels and outbound main/file image
bytes, bounds, text-only feedback, the Code Mode direct-call boundary, render
cancellation/removal/ownership cleanup and the actual 30-second timeout. It
does not claim live-model interpretation accuracy.
High-resolution CCITT/header regressions and the local actual-document evidence
are described in [PDF image-body verification](docs/verification/pdf-image-body.md).

Keep source records and binary lifetimes separate from the model transcript.
`attachments.js` owns stable IDs, bounds, persistence and read cancellation;
`attachments-ui.js` owns file/paste/drop/tab selection and accessible source
controls. A tab source binds both browser-session and exact Chrome document
identity. Never replace that with a reusable tab ID or permission-based scan.
See [attachment verification](docs/verification/attachments.md) for screenshots,
tested lifecycle semantics and the explicit design-engineering critique.

## Opt-in integration checks

### Experimental Firefox build

The default build/package commands remain Chrome-only, with the same stable
public key and ZIP name. Build Firefox separately:

```sh
npm ci
node build.mjs --browser=firefox
node package-extension.mjs --browser=firefox
```

These create `dist-firefox/` and
`artifacts/pi-accanto-VERSION-firefox.zip`, an unsigned temporary-install package.
Do not load the source manifest in Firefox. Read the
[Firefox verification notes](docs/verification/firefox.md) for installation,
keyless local checks, observed iframe isolation, PDF limits and signing gates.

After building and packaging **both** targets, run the focused checks added for
the port:

```sh
node --test test-browser-target.mjs test-document-authorization.mjs test-main-document.mjs test-permissions.mjs test-panel-state.mjs test-distribution.mjs
```

The browser-target checks require actual packages, rather than silently skipping
missing outputs. The authorization checks drive production message handlers with
controlled browser responses; they are not a substitute for real Firefox tests.
Use disposable profiles and local synthetic endpoints for browser qualification.
Do not run authenticated external-model checks or use personal browser profiles
as part of the deterministic port gate.

`npm run test:browser-target` runs the focused build, main-document and
authorization unit suites. `npm run test:firefox:distribution` validates the
Firefox ZIP, and `npm run test:firefox` qualifies the actual unmodified
`dist-firefox/` using Selenium and an installed Firefox 153+ and geckodriver.
The harness never downloads either executable. Override discovery with absolute
`ACCANTO_FIREFOX_BINARY` and `ACCANTO_GECKODRIVER` paths if needed.
Set `ACCANTO_ARTIFACT_DIR` to a temporary evidence directory outside the checkout.

The Firefox browser gate includes `test-browser-fallback.mjs`: authenticated
launcher-to-tab opening, no embedded conversation runtime, source binding,
exclusive standalone ownership, rogue-frame rejection, navigation/reload
revocation and native-PDF file guidance. The security suite separately checks
actual permission removal, exact document targeting and unauthorized broker/
fallback actions. Feature/PDF suites retain real Wasm, cancellation, attachment,
portable backup and local transport coverage. These are not embedded-chat tests.
Optional grants use isolated browser test privileges; native dialog acceptance,
toolbar/OS shortcut delivery and ESR remain unqualified. CI currently builds
and validates the unsigned Firefox ZIP but does not run Firefox browser tests.

`npm run test:research:live` adds real provider requests and live-model scenarios.
Provide `ACCANTO_MODEL_ENDPOINT` (OpenAI-compatible base URL),
`ACCANTO_MODEL_ID` and `ACCANTO_MODEL_API_KEY` in your local process environment,
using your own secret manager or a non-logged prompt. Do not put keys in source,
command-line arguments, issues or committed environment files. No personal
configuration file is read automatically. The model's context/reasoning profile
must be compatible with the adapter described in the README.

The research live suite uses a test-only Node relay for model requests from its
disposable extension ID. Production runtime has no relay. It also attempts
keyless Exa search, MDN reading with Chrome host access and invalid-key TinyFish/Brave requests.
Exa quota, external network availability and model output make it unsuitable as
a deterministic CI gate. Authenticated TinyFish/Brave service success is not
established by their synthetic fixture responses.

`npm run test:native` uses the same explicit model environment settings but
direct model transport and actual native Chrome permission/toolbar controls.
It requires Windows with an **unlocked interactive desktop**; it always opens a
visible browser. Set `ACCANTO_CHROME_EXECUTABLE` if the Playwright Chromium build
does not match the version you intend to verify. Native clipboard/menu behavior
is outside the portable fixture job. Missing live settings fail clearly; they
do not silently pass or skip assertions.

## Boundaries to preserve

- Keep context, attachments, search-result eligibility and sandbox stores isolated by task
  and conversation. Never silently read unrelated tabs.
- Treat page/source text as untrusted. Preserve password exclusions, bounded
  extraction, cancellation and honest partial failures.
- Store remembered model/search keys only in extension-local storage, never sync
  storage, page messages or artifacts. Preserve session-only storage and explicit
  forgetting; keep model credentials scoped to their endpoint and API. Source reads
  reuse Chrome host grants, but remain limited to exact search results in the task.
- The public companion iframe must authenticate its exact document through the
  isolated host before loading agent code or storage. Page messages must never
  become a tool/credential bridge. Credentials are entered in extension tabs.
- Code Mode may compose approved reading/search tools; editing remains model-only
  and there is no automatic submission or arbitrary navigation.
- Verify representative rendered states for visual changes and describe whether
  evidence uses fixtures, real services or a test relay.

Original contributions are submitted under the project's [MIT license](LICENSE).
Preserve third-party attribution; the build inventories license files for the
bundled packages. Review [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) when
changing dependencies or vendored resources. Do not publish credentials, private
page content or live artifacts in an issue or pull request.
