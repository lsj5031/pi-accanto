# Changelog

## 0.4.0

### Interface polish

- Dark mode follows the system setting, in the panel and the companion button.
- The empty chat is centred instead of clipped, long replies are capped at a
  readable measure, and reader copy and status text meet contrast guidance.
- The transcript is no longer one live region; speaker labels are announced and
  completion is announced once.
- Model errors lead with the cause and the next step. A reply that streamed
  before the failure stays readable above the error instead of vanishing.
- Saved chats show when they were last used and a one-line preview, most
  recently used first. **Reset chat** asks for a second click because it clears
  additional sources.
- The page chip now reads **This page · …**; history entries no longer share its
  label. The "leaving this page stops replies" notice appears only while a reply
  runs or a draft exists, and offers the tab hand-off only before sending.
- The empty page offers **解释一下** beside **Summarize**. The launcher has a
  hover close button, and **Forget key** is no longer styled as a primary action.

## 0.3.0

- Direct GitHub Releases ZIP downloads, SHA-256 checksums and a manual update link.
- Portable local conversation backups with selected PDF, text and image bytes.
  Restore creates read-only archived chats with readable history and downloadable
  sources, never resumable tasks or live tab bindings. Credentials and model/search
  settings are excluded structurally; private content may still contain secrets.
- Stable unpacked extension identity retained. Back up before updating in the same
  permanent folder, stop work, reload the extension and refresh pages. Session-only
  keys need reentry. Schemas may evolve; downgrades are unsupported.
