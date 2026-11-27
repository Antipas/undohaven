# Changelog

## 0.1.16

Guard can repair a session that keeps returning the same 400. Known cases are a lone UTF-16 surrogate, an interrupted reasoning-only assistant message, and a literal image token. Anything else rolls the log back to the event before that message. The session is encrypted into a snapshot first, and that snapshot can be restored in one step. A wiped `cordis.patch.yml` (empty `[]` beside a `.bak-*` file) is reported on startup. Each real change to that file keeps an encrypted version so one entry can be put back. Host rows from the backup are restored; third-party rows stay disabled.

## 0.1.15

A bring-your-own index stores only the snapshot id, time, encrypted manifest, and chunk ids. Plugin specs and the other metadata sit inside the manifest, which is padded to 64 KiB. The byte total sent with a snapshot is that padded size. Older unpadded manifests and older full index records still open.

## 0.1.14

Snapshots skip symlinks, junctions, model-weight files, and files over 64 MB. Guard keeps a per-plugin history and reads declared `dshhub.permissions.network` domains.

## 0.1.13

Before a `storages/*.json` file changes, the previous bytes are kept as a local snapshot. A dsh version change also takes a storage-only snapshot at startup. Restore can merge scheduled tasks, or write one session back, without `includesCredentials`.

## 0.1.12

`undohaven-core` runs on Node >= 22.19. File snapshots share the same encryption as dsh snapshots.

## 0.1.11

Chinese upgrade prompts link to `https://undohaven.com/zh/pricing`. English prompts stay on `https://undohaven.com/pricing`.

## 0.1.10

UndoHaven Guard: baseline hashes, capability diff via dsh-trust-check 0.2.6 (MIT), pre-change snapshots for Pro, and rollback of the plugin spec plus the dsh config directory. Rollback cannot remove OS-level persistence.

## 0.1.9

Upgrade prompts for a successful rollback, cloud quota, and a second device now include `https://undohaven.com/pricing?utm_source=cli`.

## 0.1.8

Restore compatibility with dsh 0.2.2-rc.5: session bytes stay intact, and the removed `working_directory` model tool is stripped on restore.
