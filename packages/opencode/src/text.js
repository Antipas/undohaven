export function formatList(rows) {
  if (!rows.length) return 'No UndoHaven snapshots for OpenCode yet.'
  return rows.map((row) => `${row.id}  ${row.createdAt}  ${row.kind}`).join('\n')
}

export function formatSnapshot(snap) {
  if (snap.unchanged) return `No changes since snapshot ${snap.id} (${snap.files} files), so no new snapshot was needed.`
  return `Saved snapshot ${snap.id} (${snap.files} files${snap.cloud ? ', uploaded encrypted' : ', local only'}).`
}

export function formatUndo(result) {
  return `Restored ${result.id} (${result.files.length} files). The state before this undo is saved as ${result.backup}.`
}

export const DESCRIPTIONS = {
  snapshot: 'Save an encrypted UndoHaven snapshot of the OpenCode config (global config dir, the project .opencode dir, and project opencode.json/AGENTS.md). Use before changing agents, commands, plugins or settings.',
  list: 'List UndoHaven snapshots of the OpenCode config, oldest first, with ids.',
  undo: 'Restore the OpenCode config from an UndoHaven snapshot: the latest one, or the id you pass. The current state is saved first, so the undo can be undone.',
}
