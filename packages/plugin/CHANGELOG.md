# Changelog

## 0.1.12

`auth.json`, `*.key`, `*.pem`, and `id_rsa` / `id_ed25519` are never part of a snapshot. `.env` and `.credentials.yaml` stay out unless credential backup is turned on. Depends on undohaven-core 0.1.15.

## 0.1.11

Depends on undohaven-core 0.1.14. No plugin behavior change in this release.

## 0.1.10

The plugin watches `storages/*.json` while dsh is running and keeps the previous copy locally. The settings tab can restore only scheduled tasks, or one session. Pro uploads those local copies on the existing snapshot timer. `undohaven-core` is pinned to 0.1.13.

## 0.1.9

The settings tab links English Pro to `https://undohaven.com/pricing` and 专业版 to `https://undohaven.com/zh/pricing`.

## 0.1.8

Loopback routes require a per-install `0600` token and a same-host Origin. Guard baselines installed plugins on startup. Pro accounts also pin a pre-change snapshot. `undohaven-core` is pinned to 0.1.10.

## 0.1.7

The settings tab links Pro and any upgrade prompt to `https://undohaven.com/pricing?utm_source=plugin`.

## 0.1.6

`cordis.patch.yml` uses `insert:` so `dsh plugin add` loads the plugin layer.
