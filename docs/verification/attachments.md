# Multi-source attachments verification

Verified in an isolated Droid worktree on Linux, using pinned Playwright Chromium.
Base: `d927ff0c9de5ee965069da5dd84112e6f06b0a02`; branch:
`feat/conversation-attachments`. Primary checkout untouched. No publication by
this agent; the user subsequently published the branch.

## Composer geometry follow-up

Small visual correction on the same branch after `2470411`. The earlier visual
review missed the font-based plus's low/right appearance and inconsistent
composer geometry. No source-storage, model, permission or lifecycle changes.

| Before | After | Why |
| --- | --- | --- |
| Font `+` inside a 34px add control | Symmetric 18px SVG inside the existing 32px icon-button system | Center the actual drawn glyph independently of font metrics |
| Add 34px, context 28px, action 32px; radii 7/6/8px | Shared 32px height and 7px radius; context padding 8px, action padding 10px | Cohesive controls without changing their roles or labels |
| Font `×` for attachment removal and tab-picker close | Matching centered SVG crosses, retaining accessible names and keyboard behavior | Correct the same font-metric defect in related controls |
| Inline action spacing and separate Stop display modes | Explicit 6px flex gap and consistent flex centering | Keep simultaneous import Stop/Send controls aligned |

Validation for this follow-up only:

- `npm run build` and the **existing** `npm run test:attachments` passed.
  The complete fixtures, packaging and unrelated suites were deliberately not
  rerun.
- **New** `test/control-geometry.mjs` assertions run through that suite:
  empty/loading/dialog states, 320/380/900px panels, actual Chrome 200% zoom,
  and actual compact/enlarged companion iframes. Visible composer controls are
  32px high with 7px radii. Add/context/source-count center differences and
  SVG/control center differences are below 0.1 CSS pixel; context text is
  within 1 CSS pixel of vertical center. Actual SVG drawing bounds, not only
  the SVG viewport, are checked for plus/remove/close.
- Before the CSS correction, the new browser assertion failed with
  `Empty compact panel: 32px composer control, got 34`.
- Fresh compact/enlarged, 320px, loading and 200% screenshots were opened and
  inspected directly. The plus is centered, controls share geometry, remove
  crosses remain clear, and the context/count and loading actions align.
  Existing keyboard menu/removal/focus and source behavior checks still pass.
- Evidence below is refreshed from the focused suite, including its new
  actual-iframe captures and tab-picker close screenshot.

## Scope and lifecycle

- **Source**: stable UUID, kind, useful name, size, import state and kind-specific
  metadata. File blobs live in a conversation-specific IndexedDB source store;
  Pi Durable remains the transcript/task owner. Installed Durable document types
  are JSON-based, so original blobs are deliberately outside history/deltas.
- **Selection**: `+`, file chooser, drop, image paste, or explicit tab picker.
  Opening the picker reads local titles/URLs only. Choosing a tab requests only
  its origin's Chrome permission and captures document identity, not page text.
- **Reading**: metadata catalog per question; `list_sources` / `read_source` work
  directly and through Code Mode, without new write capabilities or URL fetching.
  Text/tab reads cap at 12,000 characters; PDFs at 8 pages / 16,000 characters.
  Additional tabs reuse bounded visible-page extraction with fields excluded.
- **Lifetime**: ready sources survive reload, model changes and ownership
  handoff. Tasks remain isolated. Reset and explicit page/web-context changes
  delete originals/metadata, not old messages. Incomplete imports may need
  selecting again after closing/reloading. Stop/removal abort imports and reads;
  late operations cannot restore removed records or return stale evidence.
- **Tabs**: browser-session ID plus exact Chrome document ID and URL, never
  tab-ID-only reattachment. Navigated/reloaded/closed/restarted sources require
  explicit reselection. Internal session/document/tab IDs stay out of the model
  catalog. The restart guard is tested with a changed session token; same-URL
  document replacement is tested by closing the panel and reloading its tab.
- **Images**: native profile `input` modalities determine support. Unknown models
  default to text-only, with an explicit custom-image setting. Header dimensions
  are bounded before actual decoding. Actual image blocks reach the provider
  adapter when read; unsupported images do not prevent PDF/text use.
- **Privacy**: source content/names are untrusted. No unrelated-tab content or
  API keys enter the source catalog. Removal blocks future tool reads and deletes
  the original, but cannot retract earlier messages, provider copies or backups.
  History can resend earlier excerpts/images, as with existing page evidence.

## Original implementation checks and outcomes

All following final commands passed:

| Command | Outcome |
| --- | --- |
| `npm ci` | Pinned dependencies installed; audit reported 0 vulnerabilities |
| `npm run package` | Installable `artifacts/pi-accanto-0.2.0.zip` |
| `npm run test:distribution` | 4 existing checks passed, including unpacking the ZIP |
| `npm run test:permissions` | 2 existing permission-state checks passed |
| `npm run test:panel-state` | 5 existing Stop-stage checks passed; source cancellation added to fixture dependencies |
| `npm run test:identity` | Existing two-install-path Chrome identity check passed |
| `npm run test:fixtures` | Complete browser, conversations, PDF, research, companion and attachment suites passed |
| `npm run test:attachments` | New focused suite passed independently, including final screenshot capture |
| `git diff --check` | Passed |

The new suite checks asymmetric evidence (main page budget **731**, PDF **283**),
named text/multiple files, PDF page bounds, scanned/blank/corrupt PDFs, invalid
UTF-8, invalid/decode-failing/oversized images, PNG/JPEG/WebP, chooser/drop/paste,
count/size/aggregate bounds, removal/reload/handoff/conversation isolation,
same-URL and navigated tabs, model changes, Stop/import/read/extraction races,
web-only sources, keyboard removal, menu Escape and focus restoration.

At the exact 2 MiB text limit, a read returned **12,000 characters**, next offset
**12,000**, and the final independent marker **TAIL7** was preserved. Its catalog
was **139 characters**, not the file. Ten sources were accepted and the eleventh
rejected. Three 16 MiB selections reached the 48 MiB bound; the next byte was
rejected. A 10-billion-pixel header was rejected before image decoding.

Six local faux-provider requests exercised the real Chat Completions adapter:
pasted-image read with actual PNG bytes, PDF/text results alongside page context,
then PDF/text after switching to text-only with image bytes excluded. These
assert transport behavior, **not live-model reasoning or provider success**.
The existing companion suite was extended with actual compact/enlarged iframe
attachment/removal and a realistic long filename.

Earlier runs found an ownership-reload race, incomplete immediate cancellation,
and outdated settings/copy/diagnostic fixture expectations. Those were corrected
and the complete release gates rerun successfully. No failing checks remain.
The final diff review covered selection/privacy boundaries, sandbox tool
callers, persistence and ownership races, stale documents, cancellation and
image decoding. Accepted findings were fixed, including removing internal tab/
session identifiers from model metadata, checking pixel bounds before decode,
and ensuring unsupported additional PDF tabs cannot redirect a read to the main
page. A real additional-PDF-tab fixture verifies the attach-as-file guidance.

## Explicit design-engineering critique

Read the complete supplied
`/tmp/pi-accanto-emil-skills/skills/emil-design-eng/SKILL.md` and applied its review
framework after implementation. Rendered screenshots were directly viewable.
Inspected empty, add, loading, ready, answer/evidence, failure, scanned,
unsupported-image and removal states; 320/380/900px layouts; real compact and
expanded companion frames; long filenames; keyboard interactions; and actual
Chrome **200% zoom** (not merely a scaled screenshot).

| Before | After | Why |
| --- | --- | --- |
| New failures could be below the source list's visible area | New selections scroll into view; subsequent updates preserve scrolling/focus | Immediate, predictable feedback without stealing keyboard focus |
| UUID-key order changed chip order after reload | Persist monotonic selection order | Spatial consistency should survive a handoff/reload |
| Small, low-salience remove glyph | 32px named keyboard-operable target; follow-up replaces font glyph with centered SVG; focus returns to `+` | Removal is discoverable and repeated keyboard use stays predictable |
| Page chip competed with the source count at narrow widths | Shrinkable page chip; bounded, independently scrolling source list | Keep the composer and main-page controls usable at 320px and 200% zoom |
| Raw `read_source` / `list_sources` activity names | “Read attached source” / “List attached sources” | Describe the user's action instead of an implementation identifier |
| Idle imports had no usable Stop control | Stop appears during imports and cancellation is immediate | Loading must be interruptible, not decorative feedback |
| Unknown PDF page counts displayed placeholder page numbers | Kind and import/failure state until page count is known | Avoid ambiguous or misleading loading states |
| Context changes silently implied losing selected originals | Context/reset controls explain source clearing | Make consequential lifetime changes explicit |
| Potential temptation to animate every chip/menu update | No new animation dependency or keyboard animation | Frequent actions should feel instant and preserve the existing design |

## Evidence and remaining limits

Selected synthetic screenshots are committed under
[`attachments/`](attachments/):

- Ordered flow: `01-empty-compact.png`, `02-add-menu.png`, `02b-loading.png`,
  `03-ready-page-and-files.png`, `04-answer.png`, `05-remove.png`.
- States/layout: `02c-tab-picker.png`, `06-failure-and-scan.png`, `07-layout-320.png`,
  `08-200-percent.png`, `10-text-only-model.png`.
- Actual iframe: `attachments-compact.png`, `attachments-expanded.png`.

Regenerable reports/screenshots: `test-results/attachments/report.json`,
`test-results/attachments/` (including refreshed compact/enlarged iframe images),
`test-results/companion/` (original companion suite), and the existing suite
directories. No raw request dumps, credentials or personal browsing data committed.

OCR, password-protected PDFs, additional PDF-tab reading, arbitrary encodings,
SVG/GIF and arbitrary URL attachment fetching are intentionally unsupported.
Provider-specific image/context limits can be stricter than the local bounds.
No real model credentials/payments or live external service checks were used.
Native `test:shortcuts` and `test:native` were not run: they require an unlocked
Windows desktop (and the latter real model settings). Portable keyboard,
companion command-routing and focus checks passed. There is no mutation-testing
tool available in this session.
