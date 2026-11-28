# undohaven

![dsh-plugin](https://img.shields.io/badge/dsh--plugin-181717)

Unofficial third-party command line for encrypted snapshots, rollback, and moving a dsh home. Compatible with dsh. Not an official dsh product.

The default snapshot stays on this machine. `undohaven snapshot` needs a passphrase and does not need an account. `undohaven restore --to SNAPSHOT_ID` writes that snapshot back after dsh has quit.

```bash
npx undohaven init
npm i -g undohaven
export UNDOHAVEN_PASSPHRASE='at least 8 characters'
undohaven snapshot
undohaven s3 keys create --bucket undohaven
undohaven list
undohaven restore --to SNAPSHOT_ID --scope all
undohaven restore --to SNAPSHOT_ID --scope tasks
undohaven restore --to SNAPSHOT_ID --scope session --session SESSION_ID
```

`--scope tasks` puts scheduled tasks from the snapshot back and leaves tasks that were created later. `--scope session` writes that one session back and lists it again. Other sessions stay as they are.

If dsh will not start, `undohaven rescue` lists local snapshots and `undohaven rescue --to SNAPSHOT_ID` writes that profile's `package.json`, `pnpm-lock.yaml`, and `cordis.patch.yml` back. It does not need dsh to be running. Quit dsh first if it is still up.

`npx undohaven doctor` checks the profile when dsh itself will not start. The free command is read-only. `undohaven doctor repair` and `undohaven doctor undo` are part of Pro: repair encrypts a snapshot of the profile before it writes. See `docs/doctor.md`.

`undohaven guard history <plugin>` lists every recorded point for that plugin. `undohaven guard rollback <plugin> --to <snapshot-or-version>` puts that one package spec back. Pro is required for rollback. A scan or diff prints the plugin's declared capabilities, including `dshhub.permissions.network`, and what changed since the previous version. UndoHaven is an unofficial third-party tool compatible with dsh. It is not affiliated with dsh's authors.

Losing both the passphrase and the recovery code means the encrypted copy cannot be opened. There is no reset.

Homepage: https://undohaven.com/

## dsh compatibility

Checked against dsh 0.2.2-rc.5 and the session-workspace-root change on master. `restore` and `migrate-machine` write the dsh home back as stored. `header.cwd`, session events (`working-directory/change` and `workspace-root/change`), and `storages/workspace.json` paths are not rewritten. The Host moves the workspace root. Restore drops the removed `tool-working-directory` patch entry and the `@deepseek-ai/dsh-tool-working-directory` dependency so a snapshot from before 0.2.2-rc.3 loads on 0.2.2-rc.5. Range: dsh `>=0.2.1-rc.5 <0.3.0`.

## Paid API (x402)

Unofficial third-party, compatible with dsh. An agent can pay `https://undohaven.com` per call in USDC on Base. `POST /x402/snapshot` and `GET /x402/restore/{id}` are 0.05 USDC. `POST /x402/pass` is 6 USDC for 30 days of Pro, the same as the Stripe Pro monthly price, with no discount. The route ships disabled until the operator sets the public vars. If settlement fails (e.g. facilitator nonce too low), you were not charged; retry once.

`X402_PAYER_KEY` below is the caller's key. It is not an UndoHaven secret.

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

Docs: https://undohaven.com/docs/x402
