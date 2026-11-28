# Changelog

## Unreleased

`undohaven doctor` reports a read-only startup checkup. `undohaven doctor repair` and `undohaven doctor undo` are the Pro repair. The version is unchanged.

## 0.1.14

Plugin restore reads the plugin list from the encrypted manifest when the local record no longer carries it. Depends on undohaven-core 0.1.15.

## 0.1.13

`undohaven rescue` lists snapshots and restores a profile when dsh will not start. `undohaven guard history` and `guard rollback --to` pick any earlier plugin point. Install and update scans show declared capabilities and the diff. Depends on undohaven-core 0.1.14.

## 0.1.12

`undohaven restore --scope tasks` puts scheduled tasks back. `--scope session --session <id>` restores one session. Depends on undohaven-core 0.1.13.

## 0.1.11

Paid prompts use `https://undohaven.com/zh/pricing` in Chinese and `https://undohaven.com/pricing` in English.

## 0.1.10

`undohaven guard scan|diff|rollback|block`. Free gets the baseline and the weekly blocklist. Pro gets pre-change snapshots, diff, and rollback. `dsh-trust-check` 0.2.6 is a direct dependency (MIT).

## 0.1.9

Paid and upgrade prompts, including bring-your-own storage, now link to `https://undohaven.com/pricing?utm_source=cli`.

## 0.1.8

Repository URLs point at github.com/Antipas/undohaven. Restore follows dsh 0.2.2-rc.5 session workspace roots.
