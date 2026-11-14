# Changelog

## Unreleased

- Experimental Firefox desktop 153+ build and unsigned temporary-install package,
  with separate Gecko identity and unchanged Chrome artifacts.
- Firefox uses an authenticated companion-to-tab fallback. Full embedded chat is
  blocked by Firefox iframe API/storage isolation; native PDF tabs require explicit
  PDF-file attachment. Neither signed distribution nor ESR support is qualified.
- Fail-closed document identity/injection checks, companion navigation revocation,
  Firefox shortcut settings and gesture-safe service-permission restoration.

## 0.3.0

- Direct GitHub Releases ZIP downloads, SHA-256 checksums and a manual update link.
- Portable local conversation backups with selected PDF, text and image bytes.
  Restore creates read-only archived chats with readable history and downloadable
  sources, never resumable tasks or live tab bindings. Credentials and model/search
  settings are excluded structurally; private content may still contain secrets.
- Stable unpacked extension identity retained. Back up before updating in the same
  permanent folder, stop work, reload the extension and refresh pages. Session-only
  keys need reentry. Schemas may evolve; downgrades are unsupported.
