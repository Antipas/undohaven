<!--
SITE COPY — not deployed from this repo.
Publish later on the public site (for example /doctor and /zh/doctor).
Do not deploy a Worker from this change.
This page is an unofficial third-party note. It is not a harness product page.
-->

# Startup checkup

Unofficial third-party tool, compatible with dsh. Not affiliated with the harness authors.

When the desktop app cannot open, a plugin installed inside it cannot run either. `npx undohaven doctor` and `undohaven doctor` run outside the app and read the profile on disk. The free checkup only reports. It does not change files. Repair is part of UndoHaven Pro / Guard, not a separate product and not a separate price. Repair encrypts a snapshot of the profile before it writes. `undohaven doctor undo` puts that profile back.

```bash
npx undohaven doctor
undohaven doctor repair
undohaven doctor undo
```

Quit the app before repair. These notes quote the reports. They are one more way to try, not a promise that the app will open.

## New sessions fail after an auto-update

Report: [harness discussion 14408](https://github.com/deepseek-ai/deepseek-harness/discussions/14408)

After each desktop auto-update, creating a session kept failing with:

```
active Service "sessionController" is unavailable
```

Restarting did not help. The desktop profile had pinned two official bundles to the previous release:

- `@deepseek-ai/dsh-experimental-session-search`
- `@deepseek-ai/dsh-experimental-terminal-bundle`

The app's `dsh/desktop-runtime.json` (`release.version`, inside `resources/app.asar`) had moved on. `profiles/desktop/node_modules/.ignored/` still held half-extracted `*_tmp_*` directories from the interrupted sync.

The checkup compares those pinned versions and the installed package versions with `release.version`. Pro repair writes the shipped version into both pins, deletes the `*_tmp_*` directories under `node_modules/.ignored`, and, when the app's bundled pnpm is on disk, reinstalls that profile. Pass `--runtime` or `--app-root` if the checkup cannot see the installed app. `--no-install` updates the pins and skips pnpm.

## Startup crash on a profile package.json

Report: [harness discussion 14459](https://github.com/deepseek-ai/deepseek-harness/discussions/14459)

The host crashed in `readProfileManifest` with:

```
Unexpected token '﻿', "﻿{
  "name"... is not valid JSON
```

The first three bytes were a UTF-8 BOM (`EF BB BF`). `JSON.parse` was called on the raw text. The checkup reports that BOM on `package.json` and on `cordis.patch.yml`. Pro repair removes those three bytes. A UTF-16 BOM is reported and left alone.

The same checkup reports an empty template standing in for the real config, and a sibling `.bak-*` file. The official "disable plugins / backup profile / restart" button renames `cordis.patch.yml` to `cordis.patch.yml.bak-<ms>` and the next launch writes `[]`. See [harness discussion 14400](https://github.com/deepseek-ai/deepseek-harness/discussions/14400). Pro repair copies the newest backup back. Host rows come back. Third-party plugin rows stay disabled until you turn each one on. A `.bak-*` next to a file that still parses is listed and not deleted.

`undohaven upgrade` is the pre-upgrade snapshot for a runtime install. This tree has no `undohaven guard preflight`. Plugin realignment after a runtime change is `undohaven guard align` on a separate change that is not merged here. Doctor does not call it.

## A failed tool, or an old plugin message, sticks until restart

Report: [harness discussion 14411](https://github.com/deepseek-ai/deepseek-harness/discussions/14411)

A tool failure, and a third-party message that still uses the old `source: { kind: "plugin" }` shape, both end the turn with:

```
SessionFormatError: format v4 message requires a producer-owned source kind
```

The comment on that report says the same throw happens for plugin messages that still use that shape. Nothing is written to the session file. The session works again after a restart, and the failure comes back if the same message is sent again. Doctor tells you to restart. It does not rewrite the log.

## What undo puts back

Repair stores an encrypted copy of the profile directory, except `node_modules`, `.ignored`, and secret files (`.env`, credentials, and private keys). Undo writes those files back. Directories that repair deleted under `node_modules/.ignored` stay deleted.

dsh-checkpoint saves a local Git snapshot of the workspace before a turn. That copy is not encrypted, it stays on this machine, and it does not move with you to another computer. The doctor snapshot is an encrypted copy of the profile so the repair itself can be undone.
