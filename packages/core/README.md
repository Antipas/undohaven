# undohaven-core

![dsh-plugin](https://img.shields.io/badge/dsh--plugin-181717)

Library behind the `undohaven` CLI and the `dsh-undohaven` plugin. Unofficial third-party code, compatible with dsh. Not an official dsh package.

It chunks a dsh home, encrypts the chunks on the machine, and restores them. The passphrase never leaves the process. Publish and install the `undohaven` package if you want the command; this package is the engine those commands import.

Homepage: https://undohaven.com/

## Paid API (x402)

This package does not pay and does not hold a key. Agents that want the hosted pay-per-call API use `@x402/fetch` against `https://undohaven.com`. UndoHaven is an unofficial third-party, compatible with dsh.

`POST /x402/snapshot` and `GET /x402/restore/{id}` are 0.05 USDC. `POST /x402/pass` is 6 USDC for 30 days of Pro, including hosted S3. That is the Stripe Pro monthly price, with no discount.

`X402_PAYER_KEY` is the caller's key, not a service secret.

```js
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch'
import { ExactEvmScheme } from '@x402/evm'
import { privateKeyToAccount } from 'viem/accounts'

const account = privateKeyToAccount(process.env.X402_PAYER_KEY)
const paidFetch = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: 'eip155:84532', client: new ExactEvmScheme(account) }],
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
