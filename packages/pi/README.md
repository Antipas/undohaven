# pi-undohaven

Unofficial third-party snapshots for the [pi](https://pi.dev) coding agent. This package is not affiliated with pi's authors or with DeepSeek.

It uses UndoHaven's existing encryption and, when you are logged into the same UndoHaven account, the same server and the same Pro prices. One subscription covers dsh and pi. Keys stay on this machine. `.env`, `auth.json`, and other credential files are never put in a snapshot, and nothing is uploaded in plaintext.

## Install

```bash
pi install npm:pi-undohaven@0.1.0
```

Or run the CLI directly after it is on your path:

```bash
pi-undohaven snapshot
pi-undohaven list
pi-undohaven restore --to <snapshot> --file sessions/one.jsonl
pi-undohaven migrate --to <snapshot> --dest ~/.pi/agent
pi-undohaven exclude sessions/scratch.jsonl
pi-undohaven doctor
pi-undohaven before pi-update
```

Inside pi the same actions are `/undohaven`, `/undohaven list`, `/undohaven restore <id>`, `/undohaven exclude <path>`, and `/undohaven doctor`.

`exclude` toggles a path. Secrets stay excluded either way.

The extension also takes a local safety snapshot before session compaction, tree edits, switches, and forks. Run `pi-undohaven before pi-update` yourself before a pi upgrade or a session-file migration. Pi does not emit a hook for its own updater.

## Tiers

Free keeps encrypted snapshots on this machine and prints diagnostics. Pro, using the account you already pay for, also stores that encrypted history on UndoHaven. A free login does not upload.

Set `UNDOHAVEN_PASSPHRASE` the first time so a key can be created. Point `UNDOHAVEN_HOME` at an existing UndoHaven data directory if you want pi and dsh to share keys. `PI_AGENT_DIR` selects the pi agent directory. The default is `~/.pi/agent`.

Node 22.19 or newer.

## Server

No new API. Cloud history uses the existing `POST /v1/snapshots` and chunk upload, with snapshot kind `manual` or `safety`. The encrypted manifest says `tool: pi-undohaven`.
