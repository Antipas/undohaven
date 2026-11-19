# dsh-undohaven

![dsh-plugin](https://img.shields.io/badge/dsh--plugin-181717)

Unofficial third-party dsh plugin. Compatible with dsh. It is not an official dsh component.

It takes encrypted snapshots on start, on a timer, and when the plugin is disposed. When the installed dsh base package changes version, the previous snapshot is pinned as a pre-upgrade snapshot. The settings tab can show status, take a snapshot, and print the restore command. Restore itself runs from the `undohaven` CLI after dsh has quit.

```bash
dsh plugin --profile web add dsh-undohaven
```

`cordis.patch.yml` inserts the `undohaven` row. A bare `- id:` looks for an entry that is not in the base profile, and dsh prints `entry "undohaven" not found`.

The launcher forwards `add` to pnpm in that profile. Homepage: https://undohaven.com/

`engines.dsh` is `>=0.2.1-rc.5 <0.3.0`. Checked against dsh 0.2.2-rc.5 and session-workspace-root. The plugin does not call the removed `working_directory` tool. Restore from the CLI drops a leftover `tool-working-directory` patch entry and leaves session bytes, including `workspace-root/change`, unchanged. The Host moves the workspace root.
