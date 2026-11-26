# Changelog

## 0.1.16

Guard can refuse a recursive delete of a drive root, a home directory, or `.dsh`, and it checks that the assembled path still matches the original target. Other recursive deletes get an encrypted extra copy first. A directory over 500 MB is inventoried until someone confirms. `realignPlugins` snapshots, then updates runtime-locked plugin specs, and writes those specs back if the install fails.

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
