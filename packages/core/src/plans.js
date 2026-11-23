/** Plan limits and displayed prices. Server enforcement imports this module. */

export const GIB = 1024 * 1024 * 1024
export const TRIAL_DAYS = 14

export const PLANS = {
  free: {
    id: 'free',
    storageBytes: 1 * GIB,
    historyDays: 7,
    keepPreUpgrade: false,
    devices: 1,
    machineMigration: false,
    credentialBackup: false,
    crossMajorDowngrade: false,
    byoStorage: false,
    guardRealtime: false,
  },
  pro: {
    id: 'pro',
    storageBytes: 50 * GIB,
    historyDays: 90,
    keepPreUpgrade: true,
    devices: 3,
    machineMigration: true,
    credentialBackup: true,
    crossMajorDowngrade: true,
    byoStorage: true,
    guardRealtime: true,
  },
}

/**
 * Stripe amounts are in the smallest currency unit.
 * Yearly is the highlighted default. CNY passes are one-time Checkout
 * payments for a later Alipay / WeChat Pay path.
 */
export const PRICES = {
  pro_month_usd: {
    kind: 'pro_month_usd',
    mode: 'subscription',
    interval: 'month',
    amount: 600,
    currency: 'usd',
    highlighted: false,
    en: 'Pro $6 / month',
    zh: '专业版 $6 / 月',
  },
  pro_year_usd: {
    kind: 'pro_year_usd',
    mode: 'subscription',
    interval: 'year',
    amount: 4800,
    currency: 'usd',
    highlighted: true,
    en: 'Pro $48 / year',
    zh: '专业版 $48 / 年',
  },
  pro_month_cny: {
    kind: 'pro_month_cny',
    mode: 'subscription',
    interval: 'month',
    amount: 1500,
    currency: 'cny',
    highlighted: false,
    en: 'Pro ¥15 / month',
    zh: '专业版 ¥15 / 月',
  },
  pro_year_cny: {
    kind: 'pro_year_cny',
    mode: 'subscription',
    interval: 'year',
    amount: 12800,
    currency: 'cny',
    highlighted: true,
    en: 'Pro ¥128 / year',
    zh: '专业版 ¥128 / 年',
  },
  pass_quarter_cny: {
    kind: 'pass_quarter_cny',
    mode: 'payment',
    interval: null,
    amount: 4500,
    currency: 'cny',
    days: 90,
    highlighted: false,
    en: 'Quarter pass ¥45',
    zh: '季度通行证 ¥45',
  },
  pass_year_cny: {
    kind: 'pass_year_cny',
    mode: 'payment',
    interval: null,
    amount: 12800,
    currency: 'cny',
    days: 365,
    highlighted: false,
    en: 'Year pass ¥128',
    zh: '年度通行证 ¥128',
  },
}

export const PRICE_ENV = {
  pro_month_usd: 'STRIPE_PRICE_PRO_MONTH_USD',
  pro_year_usd: 'STRIPE_PRICE_PRO_YEAR_USD',
  pro_month_cny: 'STRIPE_PRICE_PRO_MONTH_CNY',
  pro_year_cny: 'STRIPE_PRICE_PRO_YEAR_CNY',
  pass_quarter_cny: 'STRIPE_PRICE_PASS_QUARTER_CNY',
  pass_year_cny: 'STRIPE_PRICE_PASS_YEAR_CNY',
}

export function planByName(name) {
  return PLANS[name] ?? PLANS.free
}

export function pricesFor(currency) {
  const code = currency === 'cny' ? 'cny' : 'usd'
  return Object.values(PRICES).filter((price) => price.currency === code)
}

/**
 * 0.x versions use 0.minor as the line (0.2 vs 0.3). 1+ uses the major.
 * @param {string} version
 */
export function versionLine(version) {
  const match = /^(\d+)\.(\d+)/.exec(String(version || ''))
  if (!match) return null
  return match[1] === '0' ? `0.${match[2]}` : match[1]
}

function lineValue(line) {
  const [major, minor = '0'] = line.split('.')
  return Number(major) * 1000 + Number(minor)
}

/** True when restoring `snapshotVersion` would move the installed line backwards. */
export function isCrossMajorDowngrade(snapshotVersion, currentVersion) {
  const from = versionLine(snapshotVersion)
  const to = versionLine(currentVersion)
  if (!from || !to || from === to) return false
  return lineValue(from) < lineValue(to)
}

/**
 * Effective plan from a subscriptions row.
 * Trial, active, past_due, and unexpired passes count as Pro.
 * @param {object | null | undefined} row
 * @param {number} [now]
 */
export function effectivePlan(row, now = Date.now()) {
  if (!row) return 'free'
  const status = row.status || 'none'
  const periodEnd = Number(row.period_end || 0)
  const liveStatus = status === 'active' || status === 'trialing' || status === 'past_due'
  if (liveStatus && (periodEnd === 0 || periodEnd > now)) return 'pro'
  if (periodEnd > now && (row.source === 'pass' || row.plan === 'pro' || row.source === 'trial')) return 'pro'
  return 'free'
}

export function trialExpired(row, now = Date.now()) {
  if (!row || row.source !== 'trial') return false
  return Number(row.period_end || 0) <= now
}
