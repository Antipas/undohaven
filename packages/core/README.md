# undohaven-core

![dsh-plugin](https://img.shields.io/badge/dsh--plugin-181717)

Library behind the `undohaven` CLI and the `dsh-undohaven` plugin. Unofficial third-party code, compatible with dsh. Not an official dsh package.

It chunks a dsh home, encrypts the chunks on the machine, and restores them. The passphrase never leaves the process. Publish and install the `undohaven` package if you want the command; this package is the engine those commands import.

Homepage: https://undohaven.com/

## dsh compatibility

The engine snapshots and restores a dsh home as bytes. Checked against dsh 0.2.2-rc.5 and session-workspace-root: session logs, `header.cwd`, and workspace paths are not rewritten. Restore drops `tool-working-directory` and `@deepseek-ai/dsh-tool-working-directory` so the profile loads on 0.2.2-rc.3 and later, and keeps the `working-directory` Host service. An older dsh that does not know `workspace-root/change` refuses a log that contains it. This package does not move the workspace root.

## Paid API (x402)

This package does not pay and does not hold a key. Agents that want the hosted pay-per-call API use `@x402/fetch` against `https://undohaven.com`. UndoHaven is an unofficial third-party, compatible with dsh.

`POST /x402/snapshot` and `GET /x402/restore/{id}` are 0.05 USDC. `POST /x402/pass` is 6 USDC for 30 days of Pro, including hosted S3. That is the Stripe Pro monthly price, with no discount. If settlement fails (e.g. facilitator nonce too low), you were not charged; retry once.

`X402_PAYER_KEY` is the caller's key, not a service secret.

```js
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch'
import { ExactEvmScheme } from '@x402/evm'
import { privateKeyToAccount } from 'viem/accounts'

const account = privateKeyToAccount(process.env.X402_PAYER_KEY)
const paidFetch = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(account) }],
})

const response = await paidFetch('https://undohaven.com/x402/snapshot', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'idempotency-key': 'snapshot-example-001',
  },
  body: JSON.stringify({
    label: 'agent-snapshot',
    files: { 'config.json': '{"model":"demo"}' },
  }),
})
```
