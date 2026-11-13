# dsh-undohaven

Unofficial third-party dsh plugin. Compatible with dsh. It is not an official dsh component.

It takes encrypted snapshots on start, on a timer, and when the plugin is disposed. When the installed dsh base package changes version, the previous snapshot is pinned as a pre-upgrade snapshot. The settings tab can show status, take a snapshot, and print the restore command. Restore itself runs from the `undohaven` CLI after dsh has quit.

```bash
dsh plugin --profile web add dsh-undohaven
```

The launcher forwards `add` to pnpm in that profile. Homepage: https://undohaven.com/
