import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWrite } from './store.js'

export const PRICING_URL = {
  cli: 'https://undohaven.com/pricing?utm_source=cli',
  cliZh: 'https://undohaven.com/zh/pricing?utm_source=cli',
  plugin: 'https://undohaven.com/pricing?utm_source=plugin',
  pluginZh: 'https://undohaven.com/zh/pricing?utm_source=plugin',
  'log-gate': 'https://undohaven.com/pricing?utm_source=log-gate',
  logGateZh: 'https://undohaven.com/zh/pricing?utm_source=log-gate',
}

export const UPGRADE = {
  rollback: {
    zh: `第一次回滚已经成功。要把下一份快照放到这台机器外面，可以登录 UndoHaven，或用专业版接到你自己的 S3 / 文件夹。${PRICING_URL.cliZh}`,
    en: `The first rollback worked. To keep the next snapshot off this machine, log in to UndoHaven, or use Pro with your own S3 bucket or folder. ${PRICING_URL.cli}`,
  },
  quota: {
    zh: `云端容量已用过 80%。专业版是 50 GB，也可以把分块改存到你自己的桶里。${PRICING_URL.cliZh}`,
    en: `Cloud storage is past 80%. Pro is 50 GB, or point chunks at your own bucket. ${PRICING_URL.cli}`,
  },
  device: {
    zh: `第二台设备需要专业版。专业版包含 3 台设备，以及一键换电脑。${PRICING_URL.cliZh}`,
    en: `A second device needs Pro. Pro includes 3 devices and one-click machine migration. ${PRICING_URL.cli}`,
  },
}

export async function readPrompts(dataDir) {
  try {
    return JSON.parse(await readFile(join(dataDir, 'prompts.json'), 'utf8'))
  } catch {
    return {}
  }
}

export async function writePrompts(dataDir, prompts) {
  await atomicWrite(join(dataDir, 'prompts.json'), JSON.stringify(prompts, null, 2))
}
