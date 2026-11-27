<!--
SITE COPY — not deployed from this repo.
Publish later on the public site (for example /session-repair and /zh/session-repair).
Do not deploy a Worker from this change.
This page is an unofficial third-party note. It is not a harness product page.
-->

# Session repair and settings restore

Unofficial third-party tool, compatible with dsh. Not affiliated with the harness authors.

UndoHaven Pro / Guard can try to open a session that keeps failing with the same 400, and it can put profile settings back after the startup recovery button moves them aside. It does not repair every broken session. A repair always starts with an encrypted snapshot, and `undohaven guard undo` puts that session back in one step.

These notes quote the reports. They are one more way to try, not a promise that a session will open.

## A tool result cut an emoji in half

Report: [harness discussion 14391](https://github.com/deepseek-ai/deepseek-harness/discussions/14391)

The request kept failing with:

```
400 INVALID_REQUEST
Failed to parse the request body as JSON: messages[272].content[0].content[0].text:
unexpected end of hex escape at line 1 column 506363 (request_id: …)
```

The log had kept a lone UTF-16 surrogate from a tool result (`session.v4.jsonl.zstd`). Retrying hit the same column. Guard replaces that unpaired surrogate with U+FFFD and leaves the rest of the event in place.

## A cancelled turn saved only a reasoning block

Report: [harness discussion 14340](https://github.com/deepseek-ai/deepseek-harness/discussions/14340)

The next turn failed with:

```
HTTP 400 invalid_parameter_error
The content field is a required field.
```

The saved row was an `assistant/message` with `interrupted: true` and only a `reasoning` block. An empty text block would not help: the harness drops empty text, and the provider still rejects a thinking-only message. Guard removes that interrupted row. The snapshot still has it if you want it back.

## A literal image token next to a real image

Report: [harness discussion 14369](https://github.com/deepseek-ai/deepseek-harness/discussions/14369)

Every later turn died at step 1 with:

```
Image features and image tokens do not match: tokens: 766, features 765   (PI_AI_ERROR)
```

History held a real image and the literal token `<|image_pad|>` (often from a tool result that printed a tokenizer file). Guard rewrites that literal, and the related vision tokens from the same report, so they are not sent as image placeholders. The image attachment stays.

## The recovery button moved the profile

Report: [harness discussion 14400](https://github.com/deepseek-ai/deepseek-harness/discussions/14400)

The startup dialog's third button is labeled "Disable third-party plugins, back up profile patch, and restart". The report says that button runs `renameSync` on `cordis.patch.yml`, moving it to `cordis.patch.yml.bak-<ms>`, and the next launch writes the empty template `[]`. Language, theme, model, and plugin settings are gone, with no prompt and no restore.

On startup, Guard looks for that empty template beside a `.bak-*` file and asks you to restore. Host entries (language, theme, model, and other rows that are not third-party packages) are copied back. Third-party plugin rows stay disabled until you turn each one on. Restoring writes an encrypted snapshot of the empty file first.

Guard also keeps an encrypted version whenever `cordis.patch.yml` actually changes, so one entry can be put back without replacing the whole file.

```bash
undohaven guard fault --session <id> --error '<paste the 400>'
undohaven guard repair --session <id>
undohaven guard undo
undohaven guard config
undohaven guard config-restore --profile desktop
undohaven guard config-restore --profile desktop --item locale --from <snapshot>
```

Same actions from the UndoHaven settings tab: the wipe prompt is shown there, and the repair commands are the same CLI commands. This is not a separate product and not a separate price. It is part of UndoHaven Pro / Guard.
