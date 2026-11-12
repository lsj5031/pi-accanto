# Data and privacy

Pi Accanto runs as a browser extension. It has no project-operated backend,
account system or configured analytics exporter. Your chosen model and search
services are separate recipients with their own retention and privacy policies.
Do not use sensitive pages unless you are comfortable sending relevant content
to those services.

## What leaves the browser

### Portable backups

An explicit extension-tab action saves backups locally. No backup service,
external upload or automatic version check is used; the latest-release link opens
GitHub only when clicked. Backups select history text/native images, readable
tool text, names/citations and selected local file bytes. Stored model/search
keys, connection settings, headers, endpoint credentials, live tasks, leases and
browser document/session identities are excluded structurally.

This does **not** make content secret-free: messages, tool outputs, files and URLs
can include secrets or private query parameters. JSON backups are unencrypted.
Protect them like the originals; never attach private backups to public issues.

Validated restores add fresh, read-only local archives atomically. Existing chats
are unchanged. No tasks, tool calls, live tabs or network requests are revived.
Repeated imports create separate copies. Resetting a live chat does not erase
archives or downloaded files. Clear extension storage/remove the extension to
delete all local archives; delete backup downloads separately. Source bytes can
be saved locally and explicitly attached to a new live chat.

### Provider requests

| Action | Recipient | Data |
| --- | --- | --- |
| Connect a model | Your configured API server | A model-catalog request with that server's API key: `/models` for OpenAI formats, `/v1/models/{id}` for Anthropic, or `/models/{id}` for Gemini. No chat message is sent by this check. |
| Send a page-chat message | Your configured API server | Your question, relevant task history, the attached page's title/URL and a fresh bounded HTML excerpt. |
| Read/search a page or PDF | Your configured API server, when tool results enter the conversation | Extracted text, page references, URLs, requested PDF page images for vision, and requested field values. Tools exclude password inputs; explicit HTML inspection can include ordinary input/textarea values. |
| Search the web | Exa by default, or your selected TinyFish/Brave service | The model's deliberate search query and the selected provider's key if applicable. The whole page is not automatically sent to the search service; review requests carefully because the model can include facts from the conversation in a query. |
| Read a search result | The source website, then your model as a tool result | A direct request to an exact URL returned by search in the current task. Existing Chrome website permissions, including all-site access, allow reads without additional per-result approval. Missing host access requires a user-granted Chrome permission. Source reads omit cookies and reject redirects. Your IP and normal request metadata remain visible to the website. |
| Read an online PDF | The document's server, then your model as text or requested page images | A direct PDF request that can use your browser's authentication/cookies. Extraction and rendering use bundled PDF.js locally. Native text is the default; explicit visual reads send at most two labeled page images, each ≤1600px per edge, 2 megapixels and 1,500,000 base64 bytes. No cloud OCR service is used. |
| Attach files | This device initially; your model on subsequent requests | Original files are stored locally per conversation. Questions include selected-source metadata (names, kind, size, states), not every file. Read tools send bounded text/PDF excerpts or actual image bytes when requested. Existing conversation history can resend earlier excerpts/images. |
| Choose an additional browser tab | This device initially; your model on subsequent requests | The picker lists local titles/URLs without reading page text. Only the explicitly chosen tab’s metadata enters the source catalog. Requested reads send bounded visible text and its URL, excluding fields/hidden content. Chrome host access is required. No attachment tool fetches arbitrary URLs. |
| Open search in browser | Your browser and DuckDuckGo | The query in a new search tab's URL. That tab is not automatically attached to the conversation. |

Web research mode has no automatically attached-page excerpt. Browser permissions
alone do not add every tab to a task. Only the model-only edit tool can replace
a focused ordinary field after a request; the extension has no submit/send/pay
tool. Code Mode exposes approved reading/search tools, not raw browser APIs,
network access, credentials or editing. These boundaries do not make model
answers reliable or page content trustworthy.

## What stays on this device

- Chrome local storage holds model API format, endpoint/model ID and the conversation catalog.
  It also remembers which websites you hid the companion on.
- Per-conversation IndexedDB stores chat messages, inspected content, tool results,
  source excerpts, requested PDF page images, generated scripts and durable task state. These are persistent
  data, including content read from private pages. They are not encrypted by Pi
  Accanto. Browser-profile access and backups may expose them.
- A separate conversation-specific IndexedDB source store holds selected original
  file blobs and source metadata. Ready files survive reloads, ownership handoff
  and model changes. Imports interrupted by closing/reloading a panel may need
  selecting again; Stop cancels active imports and reads. Additional tabs retain
  only identity/metadata, not a persistent page snapshot. Their document and
  browser-session identities prevent silently reusing tab IDs after restart.
- Remembered model/search keys live in extension-local Chrome storage on this
  device. With **Remember API key on this device** unchecked, keys instead live
  in `chrome.storage.session` for the browser session. They are not intentionally
  placed in chat history.
  Changing model endpoints or API formats requires an explicitly scoped credential. Never paste
  a key into chat: that would become conversation content.
- Main-page and additional-tab references include browser-session identifiers;
  persisted IDs are not trusted across browser restarts.
  Search-result eligibility and active sandbox state are task-scoped;
  Chrome host grants can persist until revoked and are reused for source reads.
- Unsent composer drafts are stored per conversation in `chrome.storage.session`
  so reloads and panel handoffs do not discard them. They remain on this device
  for the current browser session and are not sent to the model until you send.
  Clearing the composer or choosing **Reset chat** clears that conversation's draft.
- Chrome permissions, browser history, downloads and clipboard contents are
  managed by the browser/OS. Copying an answer puts it on the system clipboard.

Closing a tab/panel or choosing **Reset chat** does not erase saved history. Task
boundaries limit model context; they are not data-deletion controls.
Reset and explicit page/web context changes also remove additional-source
originals and metadata, but do not erase excerpts/images from earlier messages.

The companion appears on granted HTTP(S) websites. Its idle button does not load
an agent or read page text. Opening it creates an extension-owned frame verified
against the isolated content script's exact window. Model/search keys are entered
in a separate extension tab; no credential or agent-tool API is exposed to the
website. Minimizing leaves the frame and any current reply running. Navigating
or reloading the page destroys that runtime; use **Open in a tab** for longer work.

## Removing access and data

- Remove a source using its **×** button to delete its original blob/metadata and
  prevent subsequent tool reads, including an in-flight read that has not
  returned. This cannot retract tool results/messages already recorded or data
  already sent to providers, and is not forensic erasure of browser/OS backups.
  Imported files are not uploaded to a separate file-hosting or OCR service.
- Revoke host permissions from Chrome's extension details/site-access settings.
  **Remove all-site access** returns to narrower service/site grants and can ask
  for confirmation to keep model/search services working.
- **Hide on this site** removes the companion from that origin without revoking
  its Chrome host grant or erasing history. Restore hidden companions in Settings.
- Use **Forget key** for the selected optional search provider, or restart the
  browser to end session credentials. Rotate/revoke a compromised key at its
  provider; clearing a browser copy does not revoke it remotely.
- To remove all extension-local conversations and settings, close its panels and
  agent tabs and uninstall Pi Accanto. Reinstalling starts a fresh installation.
  This does not erase browser/OS backups, screenshots, exported files, clipboard
  history or copies already received by a model/search provider.

## Contributor diagnostics

Fixture tests use disposable pages/profiles and synthetic credentials. Opt-in
live tests can contact external services and save prompts, model response
streams, source excerpts, URLs and screenshots under `test-results/` (or
`ACCANTO_ARTIFACT_DIR`). Reports intentionally omit authorization headers but
should still be treated as sensitive. Review/redact them before sharing; do not
commit live artifacts or credentials.
