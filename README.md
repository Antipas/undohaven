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

`dsh.bundle` lives in `packages/plugin` (`dsh-undohaven`) and `packages/log-gate` (`dsh-log-gate`). The repository root also declares `dsh.bundle`, pointing at the main plugin in `packages/plugin`, so directory scanners and `dsh plugin --profile web add github:Antipas/undohaven` resolve to UndoHaven. Prefer the npm package names above. This monorepo cannot expose two root bundles; install `dsh-log-gate` from npm.

## Packages

Published npm versions in this tree:

- `packages/core` — `undohaven-core` 0.1.6
- `packages/cli` — `undohaven` 0.1.6 (`npx undohaven` also works)
- `packages/plugin` — `dsh-undohaven` 0.1.5
- `packages/log-gate` — `dsh-log-gate` 0.1.3

`npx undohaven init` creates a local key and the first encrypted snapshot. Local snapshots need no account; keys stay on the machine. Compatibility declared in the plugin packages: dsh `>=0.2.1-rc.5 <0.3.0`, Node.js `>=24.9`.

Homepage: https://undohaven.com  
log-gate: https://undohaven.com/log-gate

## License

MIT
