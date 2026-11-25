# Update gate

This is the landing-page section for https://undohaven.com/ and https://undohaven.com/zh/. The Worker that serves those pages is not in this public tree. The sentences below are the copy, in the same voice as the live page.

UndoHaven is an unofficial third-party tool compatible with dsh. It is not affiliated with DeepSeek.

## English

UndoHaven Guard baselines installed dsh plugins. Free keeps that baseline and a blocklist refreshed weekly. Pro takes a snapshot before a plugin version or file hash changes, shows the new capabilities, and can roll that plugin's package spec and the dsh config directory back.

Pro also wraps the update itself. `undohaven guard update <plugin>` snapshots the profile `package.json`, the lockfile, `cordis.patch.yml`, and that plugin's directory before pnpm runs. On Windows, if the host has a native module mapped (a reported case is `@node-rs/jieba`, loaded at startup by `dsh-prime-memory`), the plugin page fails with `ERR_PNPM_EPERM` and `EPERM: operation not permitted, rename`. The UI says `无法移除`. Guard stops that host, runs the update outside it, and starts the host again. If the update fails, Guard writes the snapshot back immediately.

After a failed update the page shows `包不可用` / `cannot resolve profile bundle`: `package.json` still lists the package, and the directory is gone. `undohaven guard tree` reports that broken tree. `undohaven guard repair` restores the latest good snapshot. There is no separate price for this. It is Guard on Pro.

The same reports also show an empty desktop `resources\runtime` (`Cannot find module` `...\pnpm.mjs`, `MODULE_NOT_FOUND`, UI `更新失败`, log `operation-error`, sometimes looping on `already-installed`) and, after an upgrade, `gateway/service-unavailable: typert gateway: session/create: active Service "sessionController" is unavailable`. A missing plugin directory is one cause those threads describe. `dsh plugin --profile desktop` answers `profile "desktop" is managed exclusively by the Electron application`, so Guard runs pnpm in the profile directory instead.

Public reports: https://github.com/deepseek-ai/deepseek-harness/discussions/14260 https://github.com/deepseek-ai/deepseek-harness/discussions/14216 https://github.com/deepseek-ai/deepseek-harness/discussions/14264

The blocklist includes GHSA-c7hg-7rf4-q54h (dsh-plugin-blender-3d 0.2.1). Rollback cannot remove OS-level persistence.

## 中文

UndoHaven Guard 给已安装的 dsh 插件做基线。免费版保留本机基线，拦截名单每周更新。专业版在插件版本或文件变化前打一份快照，并给出新增能力的差异和一键回滚。回滚恢复的是插件的包声明和 dsh 配置目录，不能清掉操作系统级的驻留。

专业版同时包住更新这一步。`undohaven guard update <plugin>` 会在 pnpm 之前给 profile 的 `package.json`、lockfile、`cordis.patch.yml` 和该插件目录拍一份快照。Windows 上如果宿主已经加载了要被换掉的原生模块（公开报告里是 `dsh-prime-memory` 启动时载入的 `@node-rs/jieba`），插件页会失败，原文是 `ERR_PNPM_EPERM` 和 `EPERM: operation not permitted, rename`，界面写着 `无法移除`。Guard 先停掉宿主，在宿主外面做这次更新，再把宿主拉起来。更新失败就立刻把快照写回去。

失败之后插件页显示「包不可用 / cannot resolve profile bundle」：`package.json` 里还有这行依赖，目录却没了。`undohaven guard tree` 列出这种破树。`undohaven guard repair` 从最近一份好快照恢复。这不是单独的价格，是专业版里的 Guard。

同几份公开报告里还有：桌面端 `resources\runtime` 是空的（`Cannot find module` `...\pnpm.mjs`，`MODULE_NOT_FOUND`，界面「更新失败」，日志 `operation-error`，有时在 `already-installed` 上打转）；升级后 `gateway/service-unavailable: typert gateway: session/create: active Service "sessionController" is unavailable`。缺掉的插件目录是这些帖子里写到的一种原因。`dsh plugin --profile desktop` 会回答 `profile "desktop" is managed exclusively by the Electron application`，所以 Guard 直接在 profile 目录里跑 pnpm。

公开讨论：https://github.com/deepseek-ai/deepseek-harness/discussions/14260 https://github.com/deepseek-ai/deepseek-harness/discussions/14216 https://github.com/deepseek-ai/deepseek-harness/discussions/14264

名单包含 GHSA-c7hg-7rf4-q54h（dsh-plugin-blender-3d 0.2.1）。

UndoHaven（后悔药）是兼容 dsh 的非官方第三方工具，与 DeepSeek 没有隶属关系。
