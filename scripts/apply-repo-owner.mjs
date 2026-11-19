#!/usr/bin/env node
/** Copy repo.config.json into the four public package.json files. Replace owner there, then run this. */
import { readFile, writeFile } from 'node:fs/promises'

const config = JSON.parse(await readFile(new URL('../repo.config.json', import.meta.url), 'utf8'))
const url = `git+https://github.com/${config.owner}/${config.repo}.git`
const bugs = `https://github.com/${config.owner}/${config.repo}/issues`
const packages = [
  ['packages/core/package.json', 'packages/core', config.homepage],
  ['packages/cli/package.json', 'packages/cli', config.homepage],
  ['packages/plugin/package.json', 'packages/plugin', config.homepage],
  ['packages/log-gate/package.json', 'packages/log-gate', config.logGateHomepage],
]
for (const [file, directory, homepage] of packages) {
  const pkg = JSON.parse(await readFile(file, 'utf8'))
  pkg.homepage = homepage
  pkg.repository = { type: 'git', url, directory }
  pkg.bugs = { url: bugs, email: config.supportEmail }
  await writeFile(file, `${JSON.stringify(pkg, null, 2)}\n`)
}
console.log(`repository owner is ${config.owner}`)
