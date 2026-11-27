# UndoHaven

Unofficial third-party, compatible with dsh, not affiliated with DeepSeek.

Encrypted snapshots, rollback, and machine migration for dsh.

## Install

```bash
dsh plugin --profile web add dsh-undohaven
```

```bash
dsh plugin --profile web add dsh-log-gate
```

```bash
npm i -g undohaven
```

`pi-undohaven` is a separate package for the pi coding agent. It is an unofficial third-party package, not affiliated with pi's authors or with DeepSeek. Node >= 22.19.

```bash
pi install npm:pi-undohaven
```

`opencode-undohaven` is a plugin for OpenCode 1.x and 2.x: encrypted local snapshots of the OpenCode config, `.opencode/` and project `opencode.json`/`AGENTS.md`, with `undohaven_snapshot`, `undohaven_list` and `undohaven_undo` tools. It is an unofficial third-party plugin, not affiliated with OpenCode. Add `"plugin": ["opencode-undohaven"]` to `opencode.json` (OpenCode 2.x: `opencode plugin add opencode-undohaven`). See `packages/opencode`.

`dsh.bundle` lives in `packages/plugin` (`dsh-undohaven`) and `packages/log-gate` (`dsh-log-gate`). The repository root also declares `dsh.bundle`, pointing at the main plugin in `packages/plugin`, so directory scanners and `dsh plugin --profile web add github:Antipas/undohaven` resolve to UndoHaven. Prefer the npm package names above. This monorepo cannot expose two root bundles; install `dsh-log-gate` and `pi-undohaven` from npm.

## Packages

Versions in this tree:

- `packages/core` — `undohaven-core` 0.1.16
- `packages/cli` — `undohaven` 0.1.15 (`npx undohaven` also works)
- `packages/plugin` — `dsh-undohaven` 0.1.13
- `packages/pi` — `pi-undohaven` 0.1.3
- `packages/opencode` — `opencode-undohaven` 0.1.1
- `packages/log-gate` — `dsh-log-gate` 0.1.7

`npx undohaven init` creates a local key and the first encrypted snapshot. Local snapshots need no account; keys stay on the machine. Compatibility declared in the dsh plugin packages: dsh `>=0.2.1-rc.5 <0.3.0`, Node.js `>=24.9`. `undohaven-core` and `pi-undohaven` also run on Node >= 22.19.

When dsh will not start, `undohaven rescue` lists local snapshots and `undohaven rescue --to <id>` writes that profile's `package.json`, `pnpm-lock.yaml`, and `cordis.patch.yml` back. `undohaven guard history <plugin>` lists recorded points. Pro can run `undohaven guard rollback <plugin> --to <snapshot-or-version>` to put one package spec back.

Pro Guard can also try a session that keeps failing with the same 400. `undohaven guard repair --session <id>` takes an encrypted snapshot of that session first. `undohaven guard undo` puts it back in one step. If the startup recovery button leaves `cordis.patch.yml` as `[]` beside a `.bak-*` file, startup asks before restoring: host settings come back, and third-party plugin rows stay disabled until you turn each one on. Copy for a later site page is in `docs/session-repair.md`. This is not a separate product.

A bring-your-own index stores only the snapshot id, time, encrypted manifest, and chunk ids. Plugin specs stay inside the encrypted manifest. The server can see the account id, optional display name, device id, device label, snapshot time, snapshot kind, dsh version, the credential flag, padded byte total, chunk count, manifest size, and HMAC chunk ids. It cannot see paths or per-file sizes (`packages/core/src/crypto.js`, `packages/core/src/byo.js`).

`auth.json`, `*.key`, `*.pem`, and private keys named `id_rsa` or `id_ed25519` are never included in a dsh snapshot. `.env` and `.credentials.yaml` stay out unless credential backup is turned on.

Homepage: https://undohaven.com  
log-gate: https://undohaven.com/log-gate

## License

MIT
