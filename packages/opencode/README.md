# opencode-undohaven

Encrypted snapshots and one-step undo for your OpenCode setup: agents, commands, plugins, `opencode.json` and `AGENTS.md`.

Unofficial third-party plugin, not affiliated with OpenCode or Anomaly.

OpenCode's own `/undo` reverts code changes in a session. This plugin covers the other half: the configuration that decides how OpenCode behaves. When an agent rewrites `.opencode/agent/*.md`, breaks `opencode.json`, or a plugin experiment goes wrong, you can roll the config back.

## Install

OpenCode 1.x, in `~/.config/opencode/opencode.json` or the project `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-undohaven"]
}
```

OpenCode 2.x uses the `plugins` key, or the CLI:

```sh
opencode plugin add opencode-undohaven
```

Node.js >= 22.19 if you run it outside OpenCode.

## What it does

The plugin adds three tools the model (or you, by asking) can call:

| Tool | What it does |
| --- | --- |
| `undohaven_snapshot` | Save a snapshot now. Skipped if nothing changed since the last one. |
| `undohaven_list` | List snapshots for this project, oldest first. |
| `undohaven_undo` | Restore the latest snapshot that differs from what is on disk, or the `id` you pass. The current state is saved first as a `pre-undo` snapshot, so an undo can be undone. |

It also snapshots automatically:

- at the first message of each session;
- before `write`, `edit`, `patch`, `apply_patch`, `multiedit` or `bash` touches OpenCode config.

A failed automatic snapshot is logged and never blocks the tool call.

### What is in a snapshot

- the global config directory (`~/.config/opencode`, or `OPENCODE_CONFIG_DIR`);
- the project `.opencode/` directory;
- `opencode.json`, `opencode.jsonc` and `AGENTS.md` at the project root.

Left out: `.env*`, `auth.json`, `secrets.json`, `*.pem`, `*.key`, SSH private keys, `node_modules`, `.git`, symlinks, model weights and files over 64 MB. Restoring writes the snapshot's files back. Files created after the snapshot are left in place.

## Storage and encryption

Snapshots are local. They go to `~/.local/share/opencode-undohaven` (`$XDG_DATA_HOME`, or set `UNDOHAVEN_OPENCODE_HOME`). They are content-chunked and encrypted with [`undohaven-core`](https://www.npmjs.com/package/undohaven-core) (AES-256-GCM, Argon2id-wrapped key). No account is needed. On first use the plugin writes a random passphrase to `local-passphrase` (mode 0600) in that directory. Set `UNDOHAVEN_PASSPHRASE` to use your own instead.

Nothing leaves the machine unless that data directory already holds an UndoHaven Pro login. Set `UNDOHAVEN_CLOUD=0` to keep everything local even then.

## Options

OpenCode 2.x passes options from a `{ "package": "opencode-undohaven", "options": { ... } }` entry; OpenCode 1.x passes them from `["opencode-undohaven", { ... }]`.

| Option | Default | |
| --- | --- | --- |
| `snapshotOnPrompt` | `true` | Snapshot at the first message of a session |
| `snapshotBeforeTool` | `true` | Snapshot before a config-touching tool call |
| `riskyTools` | `["write","edit","patch","apply_patch","multiedit","bash"]` | Tools that are checked |
| `dataDir` | see above | Snapshot store |

## Development

```sh
npm test                     # unit tests, hooks for OpenCode 1.x and 2.x
./test/e2e-opencode1.sh      # real OpenCode 1.x: load, snapshot, break, undo
```

Part of [UndoHaven](https://undohaven.com). Source: https://github.com/Antipas/undohaven/tree/main/packages/opencode

## License

MIT
