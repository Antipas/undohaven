# Guard

UndoHaven is an unofficial third-party tool compatible with dsh. It is not affiliated with DeepSeek.

`undohaven guard scan` records a baseline. Free includes that baseline and a weekly blocklist. A scan or diff shows the plugin's declared `dshhub.permissions.network` domains and what changed since the previous version. Pro can list every recorded point with `undohaven guard history <plugin>` and roll one package spec back with `undohaven guard rollback <plugin> --to <snapshot-or-version>`.

Pro also snapshots a profile before a plugin update or uninstall:

```bash
undohaven guard update <plugin> --profile desktop --version x.y.z
undohaven guard uninstall <plugin> --profile desktop
```

The snapshot keeps that profile's `package.json`, `pnpm-lock.yaml`, `cordis.patch.yml`, and the plugin directory. If the host has a native module mapped, Guard stops the host, runs pnpm in the profile directory, and starts the host again (`UNDOHAVEN_DSH_RESTART` is the executable to start; on Windows the stop command is `taskkill` of `dsh.exe`, or `UNDOHAVEN_DSH_PROCESS`). If pnpm fails, Guard writes that snapshot back.

`undohaven guard tree` is free. It lists a dependency that is still in `package.json` when the directory is gone. `undohaven guard repair` is Pro. It restores the latest good snapshot of that profile.

The strings those commands are written against, quoted from public reports:

- `ERR_PNPM_EPERM`
- `EPERM: operation not permitted, rename`
- `无法移除`
- `包不可用`
- `cannot resolve profile bundle`
- `profile "desktop" is managed exclusively by the Electron application`
- `Cannot find module`
- `MODULE_NOT_FOUND`
- `resources\runtime`
- `更新失败`
- `operation-error`
- `already-installed`
- `gateway/service-unavailable: typert gateway: session/create: active Service "sessionController" is unavailable`

https://github.com/deepseek-ai/deepseek-harness/discussions/14260

https://github.com/deepseek-ai/deepseek-harness/discussions/14216

https://github.com/deepseek-ai/deepseek-harness/discussions/14264

Snapshots do not follow symlinks or junctions, skip model-weight files, and skip files larger than 64 MB. Rollback cannot remove OS-level persistence.

This is Guard on the existing Pro plan. It is not a separate product.
