# Changelog

## 0.1.1

Depends on undohaven-core 0.1.16. No OpenCode behavior change in this release.

## 0.1.0

- First release. Tools `undohaven_snapshot`, `undohaven_list`, `undohaven_undo`.
- Automatic snapshot at the first message of a session and before a tool call edits OpenCode config.
- Loads in OpenCode 1.x (`{ id, server }`) and 2.x (`{ id, setup }`) from one default export.
- Local, encrypted, per-project store outside the OpenCode config directory. Identical states are not stored twice. Undo saves a `pre-undo` snapshot first.
