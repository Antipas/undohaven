# Contributing

UndoHaven is an unofficial third-party tool, compatible with dsh, not affiliated with DeepSeek.

The public repository contains the client: `packages/core`, `packages/cli`, `packages/plugin` (`dsh-undohaven`), and `packages/log-gate`. The Worker, account ids, and deploy secrets stay out of this export.

The root `package.json` declares `dsh.bundle` so `github:Antipas/undohaven` installs the main plugin. Do not rename the workspace packages or add a second root bundle for `dsh-log-gate`.

If package metadata needs to be rewritten from `repo.config.json`:

```bash
node scripts/apply-repo-owner.mjs
```

Issues: https://github.com/Antipas/undohaven/issues  
Email: support@undohaven.com
