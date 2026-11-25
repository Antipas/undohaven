# Windows 上插件更新失败：ERR_PNPM_EPERM

UndoHaven（后悔药）是兼容 dsh 的非官方第三方工具，与 DeepSeek 没有隶属关系。这一页只引用公开报告并链回原帖，不复制插件代码。

讨论 #14260 说，在 Windows 上从插件页更新或卸载任何插件都会失败：

```
无法移除 0.46.0
[ERR_PNPM_EPERM] [importPackage ...\node_modules\@node-rs\jieba-win32-x64-msvc]
EPERM: operation not permitted, rename
  '...\jieba-win32-x64-msvc_tmp_6772_14'
  -> '...\jieba-win32-x64-msvc'
```

pnpm 把临时目录 rename 到包目录上。Windows 的 `MoveFileEx` 不能覆盖非空目录，而这个目录一直在，是因为宿主进程映射着那个原生模块。报告里写的是 `dsh-prime-memory` 启动时载入的 `@node-rs/jieba`。安装中断，没有回滚，`package.json` 仍指向一个已经不存在的目录。插件页接着显示「包不可用 / cannot resolve profile bundle」。

那里不能用 `dsh plugin --profile desktop install`。回答是 `profile "desktop" is managed exclusively by the Electron application`。

讨论 #14216 说桌面端更新后 `resources\runtime` 是空的，安装、更新、卸载全部失败。日志是 `Cannot find module '...\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs'`，代码 `MODULE_NOT_FOUND`。界面是「更新失败」。操作日志是 `operation-error`，有时会在 `already-installed` 上打转。

讨论 #14264 说升级之后不能新建会话：

```
gateway/service-unavailable: typert gateway: session/create: active Service "sessionController" is unavailable
```

报告里已经试过会话恢复，doctor 也看到配置里有、`node_modules` 里没有的插件。缺目录是那篇里写到的一种状态。`sessionController" is unavailable` 是这句错误的后半段。

## Guard 做什么

下面这些命令属于专业版里的 UndoHaven Guard，不单独计价。

1. 宿主如果正占用要被替换的原生模块，命令会先停掉它。你也可以自己退出 dsh。
2. `undohaven guard update <plugin> --profile desktop` 先给 profile 拍快照，需要时停掉宿主，在宿主外面做更新，再启动。失败（包括 `ERR_PNPM_EPERM`）会把快照写回去。
3. `undohaven guard uninstall <plugin> --profile desktop` 是卸载的同一层包装。
4. `undohaven guard tree` 列出「依赖还在 `package.json` 里、目录没了」的包。插件页上的字是「包不可用 / cannot resolve profile bundle」。
5. `undohaven guard repair` 把该 profile 最近一份好快照写回去。

`undohaven guard tree` 不需要专业版。快照、回滚和 `guard repair` 要专业版，和 Guard 的其他能力是同一个套餐。

希望更新结束后由 Guard 把宿主拉起来，就把桌面程序的路径放进 `UNDOHAVEN_DSH_RESTART`。Windows 上 Guard 结束的是 `dsh.exe`（或 `UNDOHAVEN_DSH_PROCESS` 里的映像名）。把桌面端的 `resources\runtime` 路径放进 `UNDOHAVEN_DSH_RUNTIME` 后，`undohaven doctor` 会在缺少 `pnpm.mjs` 时报告。

## 不用 UndoHaven 时

#14260 作者自己的绕过是退出宿主后在 profile 目录跑 pnpm，或先把挡路的原生模块目录挪走再重试。#14216 是把一份完好的 runtime 拷回 `resources\runtime\primary-runtime`。那是报告里的绕过，不是这个项目打的补丁。

https://github.com/deepseek-ai/deepseek-harness/discussions/14260

https://github.com/deepseek-ai/deepseek-harness/discussions/14216

https://github.com/deepseek-ai/deepseek-harness/discussions/14264
