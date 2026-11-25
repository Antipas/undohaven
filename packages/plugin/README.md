# dsh-undohaven

![dsh-plugin](https://img.shields.io/badge/dsh--plugin-181717)

Unofficial third-party dsh plugin. Compatible with dsh. It is not an official dsh component.

It takes encrypted snapshots on start, on a timer, and when the plugin is disposed. While dsh is running it also watches `storages/*.json` and keeps the previous copy locally before the file is overwritten or deleted, so an archive that removes scheduled tasks still has a copy. It does not wait for a session-stop event. When the installed dsh version changes, startup also stores a snapshot of those storage files. The settings tab can show status, take a snapshot, and print a restore command for everything, for scheduled tasks only (`undohaven restore --to <id> --scope tasks`), or for one session (`undohaven restore --to <id> --scope session --session <id>`). It also lists a broken plugin tree: a dependency still named in `package.json` whose directory is gone. That is the state the plugin page shows as `包不可用` / `cannot resolve profile bundle` after a Windows update fails with `ERR_PNPM_EPERM` (`EPERM: operation not permitted, rename`, `无法移除`). The tab prints `undohaven guard repair` instead of writing files while this host is running. `undohaven guard update` and `undohaven guard uninstall` snapshot the profile first, stop a host that has a native module mapped, run pnpm outside the host, and roll back if it fails. Those commands are Guard on Pro, not a separate product. Restore itself runs from the `undohaven` CLI after dsh has quit.

`profile "desktop" is managed exclusively by the Electron application`, so the CLI calls pnpm in the profile directory. Related reports: an empty `resources\runtime` (`Cannot find module` `pnpm.mjs`, `MODULE_NOT_FOUND`, `更新失败`, `operation-error`, `already-installed`) and `gateway/service-unavailable: typert gateway: session/create: active Service "sessionController" is unavailable`. UndoHaven is an unofficial third-party tool compatible with dsh. It is not affiliated with DeepSeek. https://github.com/deepseek-ai/deepseek-harness/discussions/14260 https://github.com/deepseek-ai/deepseek-harness/discussions/14216 https://github.com/deepseek-ai/deepseek-harness/discussions/14264

Free keeps those copies on this machine. Pro, on the same account and the same prices, uploads them with the existing snapshot timer. `.env` and `.credentials.yaml` stay out unless you turn credential backup on. `auth.json`, `*.key`, `*.pem`, and private keys named `id_rsa` or `id_ed25519` are never included. `includesCredentials` defaults to false.

```bash
dsh plugin --profile web add dsh-undohaven
```

`cordis.patch.yml` inserts the `undohaven` row. A bare `- id:` looks for an entry that is not in the base profile, and dsh prints `entry "undohaven" not found`.

The launcher forwards `add` to pnpm in that profile. Homepage: https://undohaven.com/

## Capabilities a trust scan will see

UndoHaven is an unofficial third party, compatible with dsh, and not affiliated with DeepSeek.

- **Network.** Settings calls are same-origin paths under `/api/undohaven/`. The trust scan does not list those as outbound network. The only external host literal is `https://undohaven.com/pricing?utm_source=plugin`, a link in the settings tab. The server side, through `undohaven-core`, talks only to the API base you set, which the product uses as `https://undohaven.com`.
- **Environment.** The plugin reads the process environment only to resolve `DSH_HOME`, the agents home, and `UNDOHAVEN_HOME` / `UNDOHAVEN_DATA`. It does not read credential environment variables.
- **Files.** It reads and writes the dsh home that snapshots already cover (sessions, profile package files, skills) and the local UndoHaven data directory. The route token is `route-token` in that data directory, mode `0600`. A browser call must send it in `x-undohaven-token`, and the `Origin` must be the loopback dsh host.
- **Settings injection.** It registers one settings tab through `settings.plugins.tab`. It does not inject a system prompt and it does not override a `@deepseek-ai` bundle. `cordis.patch.yml` only inserts the `undohaven` row.

`engines.dsh` is `>=0.2.1-rc.5 <0.3.0`. Checked against dsh 0.2.2-rc.5 and session-workspace-root. The plugin does not call the removed `working_directory` tool. Restore from the CLI drops a leftover `tool-working-directory` patch entry and leaves session bytes, including `workspace-root/change`, unchanged. The Host moves the workspace root.
