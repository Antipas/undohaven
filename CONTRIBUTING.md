# Contributing

UndoHaven is an unofficial third-party tool compatible with dsh.

The public repository is meant to contain the client: `packages/core`, `packages/cli`, `packages/plugin` (`dsh-undohaven`), and `packages/log-gate`. The Worker, account ids, and deploy secrets stay out of that export.

Replace `owner` in `repo.config.json`, then run:

```bash
node scripts/apply-repo-owner.mjs
```

That writes `homepage`, `repository`, and `bugs` into the four package.json files. npm reads those files directly, so the token has to land there before publish.

Issues: https://github.com/OWNER/undohaven/issues once the owner is filled in. Email: support@undohaven.com
