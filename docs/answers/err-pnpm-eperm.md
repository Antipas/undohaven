# Windows plugin update fails with ERR_PNPM_EPERM

UndoHaven is an unofficial third-party tool compatible with dsh. It is not affiliated with DeepSeek. This page quotes public reports and links to them. It does not copy plugin code.

Discussion #14260 says that on Windows, updating or uninstalling any plugin from the plugin page fails:

```
无法移除 0.46.0
[ERR_PNPM_EPERM] [importPackage ...\node_modules\@node-rs\jieba-win32-x64-msvc]
EPERM: operation not permitted, rename
  '...\jieba-win32-x64-msvc_tmp_6772_14'
  -> '...\jieba-win32-x64-msvc'
```

pnpm renames a temp directory onto the package directory. Windows `MoveFileEx` cannot replace a non-empty directory, and that directory stays because the host has the native module mapped. The report names `@node-rs/jieba`, loaded at startup by `dsh-prime-memory`. The install aborts, nothing rolls back, and `package.json` still points at a directory that is gone. The plugin page then shows `包不可用` / `cannot resolve profile bundle`.

`dsh plugin --profile desktop install` is not available there. The message is `profile "desktop" is managed exclusively by the Electron application`.

Discussion #14216 says a desktop update leaves `resources\runtime` empty, so install, update, and uninstall all fail. The log is `Cannot find module '...\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs'` with `MODULE_NOT_FOUND`. The UI says `更新失败`. The operation log says `operation-error`, and it can loop on `already-installed`.

Discussion #14264 says new sessions fail after an upgrade:

```
gateway/service-unavailable: typert gateway: session/create: active Service "sessionController" is unavailable
```

The report had already tried session recovery and a doctor that found plugins listed in config and missing from `node_modules`. A missing directory is one of the states described there. `sessionController" is unavailable` is the tail of that error.

## What Guard does

These commands are part of UndoHaven Guard on Pro. They are not a separate price.

1. Quit is handled by the command when the host is holding the native module. You can also quit dsh yourself.
2. `undohaven guard update <plugin> --profile desktop` snapshots the profile, stops the host if a native module is mapped, runs the update outside the host, and starts it again. A failure, including `ERR_PNPM_EPERM`, rolls the snapshot back.
3. `undohaven guard uninstall <plugin> --profile desktop` is the same wrapper for remove.
4. `undohaven guard tree` lists a dependency whose directory is gone. The plugin page text for that state is `包不可用` / `cannot resolve profile bundle`.
5. `undohaven guard repair` writes the latest good snapshot of that profile back.

`undohaven guard tree` works without Pro. The snapshot, the rollback, and `guard repair` are Pro, on the same plan as the rest of Guard.

Set `UNDOHAVEN_DSH_RESTART` to the desktop executable if you want Guard to start the host after the update. On Windows, Guard stops `dsh.exe` (or the image in `UNDOHAVEN_DSH_PROCESS`). Set `UNDOHAVEN_DSH_RUNTIME` to the desktop `resources\runtime` directory if you want `undohaven doctor` to notice a missing `pnpm.mjs`.

## Without UndoHaven

The #14260 report's own workaround is to quit the host and run pnpm from the profile directory, or to move the native-module directory aside and retry. The #14216 report copies a good runtime tree back into `resources\runtime\primary-runtime`. Those are the reporters' workarounds, not a patch from this project.

https://github.com/deepseek-ai/deepseek-harness/discussions/14260

https://github.com/deepseek-ai/deepseek-harness/discussions/14216

https://github.com/deepseek-ai/deepseek-harness/discussions/14264
