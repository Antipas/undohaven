# undohaven

Unofficial third-party command line for encrypted snapshots, rollback, and moving a dsh home. Compatible with dsh. Not an official dsh product.

The default snapshot stays on this machine. `undohaven snapshot` needs a passphrase and does not need an account. `undohaven restore --to SNAPSHOT_ID` writes that snapshot back after dsh has quit.

```bash
npm i -g undohaven
export UNDOHAVEN_PASSPHRASE='at least 8 characters'
undohaven snapshot
undohaven list
undohaven restore --to SNAPSHOT_ID --scope all
```

Losing both the passphrase and the recovery code means the encrypted copy cannot be opened. There is no reset.

Homepage: https://undohaven.com/
