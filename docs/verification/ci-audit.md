# CI audit · 24 November 2026

At `9b2b8c3bcb6b297b31fd3642bbd4ee8242c3665b`, a `v*` tag scheduled two independent Ubuntu jobs that packaged the extension and ran the full portable suite. Route those tags to release verification alone. CI still covers every branch (including names with `/`), PRs and tags outside the release pattern. Keep the two tag patterns in sync.

## Runner time

| Successful CI run | Playwright install with OS deps | Complete fixtures | Whole job |
| --- | ---: | ---: | ---: |
| 45351279309 (`v0.4.1`) | 434 s | 332 s | 794 s |
| 43583253286 | 24 s | 359 s | 414 s |
| 43130697092 | 20 s | 372 s | 411 s |
| 43127639799 | 28 s | 356 s | 406 s |

The trigger change removes **one job per matching tag**. On `v0.4.1` that job occupied a runner for 13 min 14 s. Release verify ran concurrently, failed a PDF fixture and correctly blocked publish (45351279249). The saving is runner time. Branch latency and release wall-clock time have no measured improvement.

In the tag CI log, apt fetched 13.4 MB in 37 s and another 32.1 MB in 372 s, including fonts and Mesa. The Chromium, FFmpeg and shell downloads together took 5.5 s. Other installs took 439 s (45350351891) and 524 s (45351279249). A browser cache alone misses the expensive transfer.

The tag's serial fixture splits, rounded from npm log timestamps, were core 65 s, conversations 15 s, PDF/visual 77 s, research 86 s, companion 19 s, attachments 63 s and portable/backup UI about 6 s. Even eliminating the *entire* research suite would bound that run's improvement at 86 s. Separate jobs would also incur setup and compete for runners. Keep every suite and its current order.

## Verification and artifacts

- Both jobs install from the lockfile, install full Chromium, package, check distribution, release, permissions, panel state and identity, then run `test:fixtures`. Release additionally checks main ancestry, exact tag/version agreement, ZIP contents, checksum and release notes before handing `verified-release` to publish. Only publish has `contents: write`, the release environment and the draft/download/byte-comparison steps.
- Tag failures now upload available `test-results/` for seven days, matching CI. An early setup failure can leave only the job log. The publisher downloads `verified-release` by name, so diagnostic files stay outside the release assets.
- README, CONTRIBUTING and the source setup page direct **people** to `extension-download`. The repo has no automated consumer of that artifact. Branch/PR builds still provide the wrapper. Tag users get the directly installable release ZIP and `SHA256SUMS` after successful publication. A failed tag loses the independent CI download that existed on `v0.4.1`. Off-repo consumers of tag artifacts or the tag CI check cannot be enumerated here.
- `test:native` and `test:shortcuts` both require an unlocked Windows desktop, headed Chromium and PowerShell input automation. Native also requires explicit live-model settings. Portable checks exercise command routing, not OS hotkey delivery or real toolbar permission grants. Keep these as separate interactive checks. Live research also stays opt-in.

## Playwright container

MCR's `playwright:v1.56.1-noble` index hashes to `sha256:f1e7e01021efd65dd1a2c56064be399f3e4de00fd021ac561325f2bfbb2b837a`. Its `linux/amd64` manifest hashes to `sha256:42f02d323c310069b4d54c94bd91a608966a486c3492c48ae0b1cea747ec5ca2`. Both match the registry digest headers. The amd64 layers total 921 MB compressed. Image metadata and layer contents agree with the lockfile and identify Noble, Playwright 1.56.1, `/ms-playwright/chromium-1194` and amd64 Node `22.20.0`. The final dpkg database lacks `zip` and `unzip`, required by packaging and the release tests.

`test/browser.mjs` selects full Chromium with `channel: 'chromium'`. The locked driver resolves `chrome-linux/chrome`, present alongside `chrome-wrapper` and `chrome_sandbox`. With default launch options the driver supplies `--no-sandbox`. The image defaults to root. Keep the executable override unset and the existing extension flags and manifest handling intact. Static inspection establishes path and version compatibility. Mars is macOS arm64 with no Linux container runtime available for a launch or timing measurement.

**Hosted comparison before adoption.** On a trusted, non-tag branch, compare fresh read-only jobs at the same SHA with the host workflow as control. Pin the candidate to the amd64 digest, keep `setup-node` on 22, assert the active Node major, print `npx playwright --version`, and check the resolved Chromium binary. Supply `zip` and `unzip` and include their install time. Use the preinstalled browsers, a private enlarged `/dev/shm` if needed, and ordinary runner isolation. Run both sets of gates including offline release prepare/verify, the mock publisher and the real ZIP extraction. Exercise artifact upload/download with distinct canary names, inspect the wrapper, and check the inner ZIP against its own `SHA256SUMS`. Keep publishing, live credentials and privileged container options out of the comparison. Compare several full jobs including image pull, cache setup, fixtures and upload against the 15-minute CI timeout before changing either production workflow.

## Mars check and rollback

Node `22.23.4`, npm `10.9.9`, pinned prewarmed Chromium 1194, disposable profiles. `npm run test:fixtures` passed in **112.54 s**. Packaging and all five standalone gates passed, including actual archive extraction and the mock-publisher rerun/corruption cases. `release:prepare -- v0.4.1` before the gates, `--verify` afterwards and an independent `shasum -a 256 -c SHA256SUMS` passed. Actionlint 1.7.9 reported zero errors across both workflows. Six local workflow mutations were detected, covering trigger scope, full fixtures and failure evidence. Hosted event routing and artifact service behavior remain to be observed.

To roll back, remove `branches` and `tags-ignore` from CI's `push` and remove the failure-only upload from release verify. No test, package or publish command needs reverting.
