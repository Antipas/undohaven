# dsh-log-gate

![dsh-plugin](https://img.shields.io/badge/dsh--plugin-181717)

第三方插件，不是 dsh 官方组件。它只做一件事：按你的规则，让会话日志上传跳过某些会话。备份不是它的工作；文末提到的 UndoHaven 是另一个独立工具。

Unofficial third-party plugin compatible with dsh. It asks the session-log uploader to skip sessions you choose. Backup is a different tool.

`cordis.patch.yml` inserts the `log-gate` row. A bare `- id:` looks for an entry that is not in the base profile, and dsh prints `entry "log-gate" not found`.

## 它实际调用的接口

dsh 0.2.2-rc.1 的会话日志插件（配置 id `session-log-deepseek`）公开了 `ctx.sessionLogDeepSeek.registerExclusion()`。判断函数是同步的，只能看到 `sessionId` 和可选的 `purpose`。返回 `true` 时，这次请求不带 `dsh_session_log`，也不会写下 `delivery-accepted`。

本插件在判断时用 `ctx.sessions.get(sessionId)` 读取该实时会话的 `header.cwd`，再按项目名、目录或 glob 匹配。没有改 dsh，也没有拦 HTTP。

The session-log plugin (config id `session-log-deepseek`) exposes `registerExclusion()`. The predicate sees `sessionId` and an optional `purpose` only. This plugin reads `header.cwd` from the live session and matches project name, directory, or glob. It does not patch dsh and does not hook the network. On dsh 0.2.2-rc.5, after session-workspace-root, `header.cwd` is still the original project. The gate keeps matching that project. It does not follow a Host `workspace-root/change`.

## 配置

`mode: all`（默认）拦住每一个实时会话。`mode: listed` 只拦住 `rules` 命中的会话。

```yaml
- id: log-gate
  name: dsh-log-gate
  config:
    mode: listed
    rules:
      - secret-proj
      - /home/me/work/private
      - /home/me/clients/**
```

- 没有斜杠、也没有 `* ? [` 的规则，按 cwd 的最后一段（项目名）匹配。
- 普通路径匹配该目录及其子目录。
- 带 glob 的规则用 Node 的 `path.matchesGlob`。

设置页「日志闸门 / Log gate」和 `GET /api/log-gate/status`（仅本机）列出当前实时会话哪些会被拦住。

## 做不到的事

- 判断函数拿不到路径。会话如果不在实时 store 里，`listed` 模式读不到 cwd，**不会**拦住它。`all` 模式只看 session id，仍然拦住。
- 匹配的是会话创建时的 cwd，不是 agent 后来走进去的每一个目录。
- 官方上传开关 `session-log-deepseek` 的 `enabled` 在排除规则之前生效。开关关掉时，排除规则不会被问到。本插件不替你改那个开关。
- 遥测（`session-telemetry-otel`，默认 `FEEDBACK_ONLY`）是另一个开关。这个插件不动它。
- 拦住不会删日志，也不会写 `delivery-accepted`。之后关掉闸门或删掉规则，下一次官方 API 请求可能把当时没传的后缀补传上去。这是官方实现里的行为，不是额外的补传通道。
- 不能保证桌面端一定渲染这个设置页。状态同时写在 dsh 日志里。

## 体检

```bash
dsh-log-gate audit
dsh-log-gate audit --json
```

报告列出官方会话日志开关、遥测相关的环境变量和补丁、本机目录大小，以及本地日志里越过最近一次 `delivery-accepted` 的后缀。最后有一句 UndoHaven 的说明和 https://undohaven.com 。

## 验证

`npm test` 里的 `packages/log-gate/test/gate.test.js` 会加载本机安装的会话日志插件，注册本插件的排除规则，并确认命中的会话不会进入 `snapshotEvents`（因此不会带上 `dsh_session_log`）。没有向官方 API 发请求。
