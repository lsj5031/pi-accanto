# Data and privacy

Pi Accanto runs as a browser extension. It has no project-operated backend,
account system or configured analytics exporter. Your chosen model and search
services are separate recipients with their own retention and privacy policies.
Do not use sensitive pages unless you are comfortable sending relevant content
to those services.

## What leaves the browser

| Action | Recipient | Data |
| --- | --- | --- |
| Connect a model | Your configured API server | A model-catalog request with that server's API key: `/models` for OpenAI formats, `/v1/models/{id}` for Anthropic, or `/models/{id}` for Gemini. No chat message is sent by this check. |
| Send a page-chat message | Your configured API server | Your question, relevant task history, the attached page's title/URL and a fresh bounded HTML excerpt. |
| Read/search a page or PDF | Your configured API server, when tool results enter the conversation | Extracted text, page references, URLs and requested field values. Tools exclude password inputs; explicit HTML inspection can include ordinary input/textarea values. |
| Search the web | Exa by default, or your selected TinyFish/Brave service | The model's deliberate search query and the selected provider's key if applicable. The whole page is not automatically sent to the search service; review requests carefully because the model can include facts from the conversation in a query. |
| Allow and read a search result | The approved source website, then your model as a tool result | A direct request to the exact approved URL. Source reads omit cookies and reject redirects. Your IP and normal request metadata remain visible to the website. |
| Read an online PDF | The document's server, then your model as extracted text | A direct PDF request that can use your browser's authentication/cookies. Local PDF extraction uses bundled PDF.js; extracted text can still be sent to your model. |
| Open search in browser | Your browser and DuckDuckGo | The query in a new search tab's URL. That tab is not automatically attached to the conversation. |

Web research mode has no automatically attached-page excerpt. Browser permissions
alone do not add every tab to a task. Only the model-only edit tool can replace
a focused ordinary field after a request; the extension has no submit/send/pay
tool. Code Mode exposes approved reading/search tools, not raw browser APIs,
network access, credentials or editing. These boundaries do not make model
answers reliable or page content trustworthy.

## What stays on this device

- Chrome local storage holds model API format, endpoint/model ID and the conversation catalog.
- Per-conversation IndexedDB stores chat messages, inspected content, tool results,
  source excerpts, generated scripts and durable task state. These are persistent
  data, including content read from private pages. They are not encrypted by Pi
  Accanto. Browser-profile access and backups may expose them.
- Model/search keys live in `chrome.storage.session` for the browser session.
  They are not intentionally placed in chat history or persistent local storage.
  Changing model endpoints or API formats requires an explicitly scoped credential. Never paste
  a key into chat: that would become conversation content.
- Page attachments, browser-session identifiers and selected search settings are
  session state. Exact-source approvals and active sandbox state are task-scoped;
  broader Chrome host grants can persist until revoked.
- Chrome permissions, browser history, downloads and clipboard contents are
  managed by the browser/OS. Copying an answer puts it on the system clipboard.

Closing a tab/panel or choosing **New chat** does not erase saved history. Task
boundaries limit model context; they are not data-deletion controls.

## Removing access and data

- Revoke host permissions from Chrome's extension details/site-access settings.
  **Remove all-site access** returns to narrower service/site grants and can ask
  for confirmation to keep model/search services working.
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
