# PDF image-body verification

Source base: `origin/main`, `b5db839b365bfd1ad53c3268c7fcaecb8ca436cf`.
Changes are isolated to `fix/pdf-image-body`; distribution work is separate.

## Root causes and fix

- The previous 16,000,000-source-pixel limit omitted ordinary high-resolution
  scans. A small native header/footer meant `noTextPages` did not identify the
  missing image body.
- PDF.js 6.5.438 routes CCITT through its shipped JBIG2 decoder. With Wasm
  disabled, the extension also needs a local decoder-fallback URL and files.
  The build now supplies those files and their licenses without enabling remote
  code, Wasm evaluation, OCR services, or new dependencies.
- PDF.js can resolve a partial operator list before rejecting its stream, and
  can deliver null image objects after decode failure. Merely increasing
  `maxImageSize` or throwing inside the worker is insufficient. A version-checked
  build patch preserves budget/inline/mask failures as detectable operations;
  the reader rejects them and null image objects before returning any images.

Each page now reports `imageContent` (presence and optimized image-operation
count); `imagePages` complements, rather than replaces, `noTextPages`. Inspection
uses PDF.js's display list, including forms, inline images, masks, groups and
repeats. Counts describe operations, not original image-object counts. Native
headers do not establish that the body was read. Images can also be diagrams
beside valid native text; their presence does not invalidate that text.

Main/file tool guidance requests visual reading when the image content matters,
not automatic transmission of every image-bearing page. Native text remains the
default. Visual reads remain direct model tools, at most two pages per call,
with explicit physical-page labels and `nextPage`. Code Mode is unchanged.

## Resource boundary

The source limit is 64 Mi pixels (67,108,864), admitting approximately 48MP
monochrome scans without admitting arbitrary decompression sizes. It represents
256 MiB of RGBA-equivalent primary image data per page, not a claim that total
browser RSS is 256 MiB. The worker checks before starting primary-image decoding,
charges aggregate images across transparency forms on the page, and checks actual
decoder dimensions, CCITT row/column parameters, component/bit depth, and
soft/explicit masks against the same budget. Cached
repeated paints reuse their decoded source. At most 4,096 distinct image decode
operations and 100,000 inspected drawing operations are permitted per page.

`canvasMaxAreaInBytes` is 16 MiB. PDF.js uses its supported OffscreenCanvas
resizer/downscaled decode paths; CCITT still requires packed-source decoding
and can create a full source bitmap before resizing. This option alone is not
a source-memory bound, hence the separate worker guards. Temporary decoder,
bitmap, component, browser and PDF-viewer allocations are additional. In a fresh
Chromium run over all 15 authorized local pages, the conservative sum of process
tree RSS peaked at approximately 1,799 MiB (shared mappings counted repeatedly).
The near-limit synthetic first read in a fresh browser process took 1.59 seconds
and peaked at approximately 1,606 MiB summed process-tree RSS.
This is a measurement of that run, not a universal process-memory ceiling.

Output limits remain two images, each at most 1,600 pixels per edge, two million
pixels and 1,500,000 base64 bytes. The existing 30-second deadline, cancellation,
canvas release and worker termination remain in force. Over-budget or undecodable
images fail with actionable lower-resolution/extracted-copy guidance, including
native-only reads, rather than returning an apparently complete blank render.

## Evidence

Private input and captures stayed local, outside the repository. No private
document, title, identifiers, extracted text, renders or request logs are included
here. All browser network requests were restricted to extension resources and
the local fixture server. No external model or OCR endpoint was used.

- Before the fix, actual extension Chromium page 2 had **zero** dark pixels in
  its central 70%, despite native text being extracted.
- After the fix, all 15 pages returned native text and body-bearing images.
  Pages 2–15 each reported image content despite native headers/footers.
  Page 2's private render was inspected visually: the diagram and its larger
  labels were legible; this is not an OCR transcription/accuracy claim.
- Both production main-PDF and attached-file adapters were exercised with the
  actual local bytes, all 15 pages each, in 16 bounded calls. Every outbound JPEG
  matched the corresponding directly rendered page bytes. Each central-body
  region contained at least 21,563 dark pixels; all output bounds held.
  The slowest two-page call was 3.30 seconds, below the 30-second deadline.
  Six further main/file calls verified native pagination (`nextPage:9`, then
  `null`) and honest image-content/switch-to-vision feedback with no image blocks
  in a text-only profile.
  Pixels prove the body is not omitted, not semantic interpretation or perfect
  reproduction of every tiny feature. No live-model reasoning was tested.

New regressions extend `test-pdf-visual.mjs` using generated, public-safe 1-bit
CCITT stripes and native headers, not private data or enormous committed fixtures:

- A 49,152,000-pixel scan compresses to a 158,066-byte PDF, reproducing the old
  pixel-limit failure without RGB allocation. Native metadata detects the image;
  rendered body samples independently contain black and white stripes.
- The largest whole row under the limit (67,107,840 pixels) succeeds; the next
  row exceeds the limit and explicitly fails. Two distinct 49MP images and a
  full-size soft mask exceed the aggregate budget and fail. Repeated cached
  XObjects do not falsely consume twelve full decode budgets.
- Images inside transparency forms remain detectable; separate forms share the
  aggregate limit. Hostile CCITT decode parameters cannot bypass dictionary
  dimension limits.
- Optimized repeated inline diagrams retain image hints. Invalid inline images
  fail rather than becoming a successful blank page. Both production adapters
  carry the high-resolution synthetic image's exact bytes and page labels.
- Stop, removal, ownership loss and external cancellation are also exercised
  during the new inspection-worker stage, with worker termination asserted.
- Existing checks continue to cover 15-page main/file pagination, native captions,
  text-only model feedback, output limits, Code Mode restrictions, Stop, source
  removal, ownership/navigation changes, canvas cleanup and the real timeout.

The installed PDF.js source and shipped fallback APIs were inspected locally.
Public upstream release/issue lookup was unavailable in the isolated environment;
the pinned dependency was not upgraded.

## Final validation

The existing release sequence passed against the final packaged runtime:
`npm run package`, `test:distribution`, `test:permissions`, `test:panel-state`,
`test:identity`, and `test:fixtures` (browser controls, conversations, PDF,
research, companion and attachments). The extended PDF suite includes the new
generated regressions above; its full run, including the intentional 30-second
timeout, took approximately 50 seconds. `git diff --check` passed.

Live-provider and Windows-native integration checks were not run. Local fixture
transport verifies bytes and labels, not live-model understanding. Composer
geometry, HTML/CSS and Code Mode restrictions were not changed.
