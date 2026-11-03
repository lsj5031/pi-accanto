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
`npm run test:conversations` or `npm run test:research`. Add `-- --headed` to see
its browser. Set `ACCANTO_CHROME_EXECUTABLE` to an absolute browser executable
path for a different Chromium build; CI uses the Playwright-pinned version instead.
Artifacts default to ignored `test-results/`; `ACCANTO_ARTIFACT_DIR` overrides
the output root. Read [PRIVACY.md](PRIVACY.md) before sharing test reports.

## Opt-in integration checks

`npm run test:research:live` adds real provider requests and live-model scenarios.
Provide `ACCANTO_MODEL_ENDPOINT` (OpenAI-compatible base URL),
`ACCANTO_MODEL_ID` and `ACCANTO_MODEL_API_KEY` in your local process environment,
using your own secret manager or a non-logged prompt. Do not put keys in source,
command-line arguments, issues or committed environment files. No personal
configuration file is read automatically. The model's context/reasoning profile
must be compatible with the adapter described in the README.

The research live suite uses a test-only Node relay for model requests from its
disposable extension ID. Production runtime has no relay. It also attempts
keyless Exa search, approved MDN reading and invalid-key TinyFish/Brave requests.
Exa quota, external network availability and model output make it unsuitable as
a deterministic CI gate. Authenticated TinyFish/Brave service success is not
established by their synthetic fixture responses.

`npm run test:sidebar` uses the same explicit model environment settings but
direct model transport and actual native Chrome permission/sidebar controls.
It requires Windows with an **unlocked interactive desktop**; it always opens a
visible browser. Set `ACCANTO_CHROME_EXECUTABLE` if the Playwright Chromium build
does not match the version you intend to verify. Native clipboard/menu behavior
is outside the portable fixture job. Missing live settings fail clearly; they
do not silently pass or skip assertions.

## Boundaries to preserve

- Keep context, attachments, source approvals and sandbox stores isolated by task
  and conversation. Never silently read unrelated tabs.
- Treat page/source text as untrusted. Preserve password exclusions, bounded
  extraction, cancellation and honest partial failures.
- Keep model/search keys out of persistent storage and artifacts. Broader page
  permissions must not remove exact-source approvals.
- Code Mode may compose approved reading/search tools; editing remains model-only
  and there is no automatic submission or arbitrary navigation.
- Verify representative rendered states for visual changes and describe whether
  evidence uses fixtures, real services or a test relay.

Original contributions are submitted under the project's [MIT license](LICENSE).
Preserve third-party attribution; the build inventories license files for the
bundled packages. Review [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) when
changing dependencies or vendored resources. Do not publish credentials, private
page content or live artifacts in an issue or pull request.
