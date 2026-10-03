// @ts-check
/**
 * dsh-hud — the quota platforms this card can show, and what each one needs.
 *
 * The card renders ONE row per subscription it discovers, and its picker (a row
 * of dots) appears only when there is more than one. Discovery has three
 * sources; this file feeds the third — the explicit `subscriptions` list — with
 * entries a person can actually choose from, instead of a blank JSON box.
 *
 * Every fact below is read out of `hud/panels/quota/host.js` rather than
 * remembered: the kind key is the `COLLECTORS` key, `baseUrl` is the default
 * that kind's own collector falls back to, and `credentials` is what `refsFor`
 * reports for it. That matters more than it looks — an explicit subscription
 * whose `baseUrl` is omitted inherits the panel's GLOBAL default
 * (`https://opencode.ai/zen/go`), so a Kimi row without one would query
 * OpenCode's gateway. Every entry here therefore names its own endpoint.
 *
 * Reference names are the panel's own where it has one (`OPENCODE_GO_API_KEY`,
 * `DEEPSEEK_API_KEY`, `DEEPSEEK_USER_TOKEN`, `QWEN_CONSOLE_COOKIE`,
 * `COMMANDCODE_API_KEY`). Where it has none, the name is OURS — and arbitrary:
 * all that matters is that the subscription's `apiKeyEnv` matches a key in the
 * credentials document, so any of them can be renamed.
 */

'use strict'

/** Shorthand for the bilingual strings the card and the QuickPick both use. */
const both = (zh, en) => ({ zh, en })

/**
 * The catalog. Order is the order the card shows them and the order the picker
 * lists them: the ones most people have first.
 *
 * @typedef {object} Platform
 * @property {string} kind      one of the panel's `COLLECTORS` keys
 * @property {string} id        default subscription id (the id is also what `inferKind` reads)
 * @property {{ zh: string, en: string }} label
 * @property {string} baseUrl   that kind's own endpoint — never left to the global default
 * @property {string} [auth]    'bearer' (default) | 'cookie' | 'raw' | 'none'
 * @property {string} [apiKeyEnv] the ref the row reads its secret from
 * @property {Array<{ ref: string, optional?: boolean, why?: { zh: string, en: string } }>} credentials
 * @property {{ zh: string, en: string }} shows    what the card renders for it
 * @property {{ zh: string, en: string }} detail   endpoint + how auth works
 */

/** @type {Platform[]} */
const PLATFORMS = [
  {
    kind: 'opencode-go',
    id: 'opencode-go',
    label: both('OpenCode GO', 'OpenCode GO'),
    baseUrl: 'https://opencode.ai/zen/go',
    apiKeyEnv: 'OPENCODE_GO_API_KEY',
    credentials: [{ ref: 'OPENCODE_GO_API_KEY', why: both('网关 API Key', 'gateway API key') }],
    shows: both('5 小时 / 周 / 月 三个限额窗口', '5-hour, weekly and monthly windows'),
    detail: both(
      'GET {base}/v1/usage → rolling / weekly / monthly 百分比。\n装了 opencode CLI 的话，也能从 ~/.opencode/auth.json 直接读登录态。',
      'GET {base}/v1/usage → rolling / weekly / monthly percentages.\nWith the opencode CLI installed, its ~/.opencode/auth.json login is read too.',
    ),
  },
  {
    kind: 'deepseek',
    id: 'deepseek-official',
    label: both('DeepSeek 官方', 'DeepSeek official'),
    baseUrl: 'https://api.deepseek.com',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    credentials: [
      { ref: 'DEEPSEEK_API_KEY', why: both('余额接口', 'the balance endpoint') },
      { ref: 'DEEPSEEK_USER_TOKEN', optional: true, why: both('可选：解锁近 30 天用量曲线', 'optional: unlocks the 30-day usage curve') },
    ],
    shows: both('账户余额（预付费），配了 user token 还会画近 30 天曲线', 'prepaid balance, plus a 30-day curve when a user token is set'),
    detail: both(
      'GET https://api.deepseek.com/user/balance → 余额。\n可选的 DEEPSEEK_USER_TOKEN 解锁平台私有的用量导出（ZIP→CSV）曲线。\n一般不用手动加：官方源会被自动发现。',
      'GET https://api.deepseek.com/user/balance → balances.\nThe optional DEEPSEEK_USER_TOKEN unlocks the platform\'s private usage export (ZIP→CSV) curve.\nUsually no need to add this by hand: the official source is discovered automatically.',
    ),
  },
  {
    kind: 'zai',
    id: 'zai',
    label: both('智谱 GLM Coding Plan', 'Zhipu GLM Coding Plan'),
    baseUrl: 'https://api.z.ai',
    apiKeyEnv: 'ZAI_API_KEY',
    credentials: [{ ref: 'ZAI_API_KEY', why: both('z.ai 用 Bearer；国内站用原始 key', 'Bearer on z.ai; the raw key on the China station') }],
    shows: both('5 小时 / 周 / 月 限额 + 套餐名', '5-hour / weekly / monthly limits, plus the plan name'),
    detail: both(
      'GET {base}/api/monitor/usage/quota/limit → TOKENS_LIMIT unit 3(5h) / unit 6(周) / TIME_LIMIT(月)。\n套餐名另取 /api/biz/subscription/list。\n国内站：把 id 改成 bigmodel 或 zhipu 开头，采集器会自动切到 https://open.bigmodel.cn 并用原始 key 做 Authorization。',
      'GET {base}/api/monitor/usage/quota/limit → TOKENS_LIMIT unit 3 (5h) / unit 6 (weekly) / TIME_LIMIT (monthly).\nThe plan name comes from /api/biz/subscription/list.\nChina station: start the id with "bigmodel" or "zhipu" and the collector switches to https://open.bigmodel.cn, authenticating with the raw key.',
    ),
  },
  {
    kind: 'commandcode',
    id: 'commandcode',
    label: both('Command Code', 'Command Code'),
    baseUrl: 'https://api.commandcode.ai',
    apiKeyEnv: 'COMMANDCODE_API_KEY',
    credentials: [
      { ref: 'COMMANDCODE_API_KEY', optional: true, why: both('可选：没配就读 ~/.commandcode/auth.json', 'optional: falls back to ~/.commandcode/auth.json') },
    ],
    shows: both('5 小时 / 周 / 月 限额', '5-hour / weekly / monthly limits'),
    detail: both(
      'GET {base}/alpha/billing/credits。\n登录过 commandcode CLI 的话不用配任何凭据。',
      'GET {base}/alpha/billing/credits.\nIf you have logged in with the commandcode CLI, no credential is needed at all.',
    ),
  },
  {
    kind: 'moonshot',
    id: 'moonshot',
    label: both('Kimi / Moonshot', 'Kimi / Moonshot'),
    baseUrl: 'https://api.moonshot.ai',
    apiKeyEnv: 'MOONSHOT_API_KEY',
    credentials: [{ ref: 'MOONSHOT_API_KEY', why: both('余额接口', 'the balance endpoint') }],
    shows: both('余额（可用 / 代金券 / 现金）', 'balance (available / voucher / cash)'),
    detail: both(
      'GET {base}/v1/users/me/balance → available / voucher / cash。\n国内站：把 id 以 .cn 结尾或写成 moonshot.cn，采集器会切到 https://api.moonshot.cn。',
      'GET {base}/v1/users/me/balance → available / voucher / cash.\nChina station: end the id with ".cn" (or use moonshot.cn) and the collector switches to https://api.moonshot.cn.',
    ),
  },
  {
    kind: 'grok',
    id: 'grok',
    label: both('xAI Grok', 'xAI Grok'),
    baseUrl: 'https://cli-chat-proxy.grok.com',
    apiKeyEnv: 'GROK_API_KEY',
    credentials: [
      { ref: 'GROK_API_KEY', optional: true, why: both('可选：没配就读 ~/.grok/auth.json', 'optional: falls back to ~/.grok/auth.json') },
    ],
    shows: both('月限额 + 套餐档位', 'monthly limit, plus the subscription tier'),
    detail: both(
      'GET {base}/v1/billing → config.{monthlyLimit,used}.val；GET /v1/settings → 套餐档位。\nAuth 是 Bearer + X-XAI-Token-Auth: xai-grok-cli。grok login 之后不需要手动配 key。',
      'GET {base}/v1/billing → config.{monthlyLimit,used}.val; GET /v1/settings → the tier label.\nAuth is Bearer plus X-XAI-Token-Auth: xai-grok-cli. After `grok login` no key is needed.',
    ),
  },
  {
    kind: 'qwen',
    id: 'qwen-token-plan-cn',
    label: both('千问 Token Plan', 'Qwen Token Plan'),
    baseUrl: '',
    apiKeyEnv: 'QWEN_TOKEN_PLAN_CN_API_KEY',
    credentials: [
      { ref: 'QWEN_CONSOLE_COOKIE', optional: true, why: both('可选：控制台 Cookie，补上月度窗口', 'optional: console cookie, adds the monthly window') },
    ],
    shows: both('月限额（CLI 与控制台双路兜底）', 'the monthly window, from the CLI and the console'),
    detail: both(
      '控制台网关 https://cs-data.qianwenai.com/... 与官方 CLI 两条路一起取，月度窗口以控制台为准，CLI 补充 5 小时 / 周窗口。\n不需要 API Key：装了千问官方 CLI（设备流登录）就能出数；再粘一个控制台 Cookie 可以拿到个人版月度用量。',
      'Reads the console gateway (https://cs-data.qianwenai.com/...) and the official CLI together; the console is authoritative for the monthly window and the CLI contributes 5-hour / weekly ones.\nNo API key needed: the official Qwen CLI (device-flow login) is enough, and a console cookie adds the personal monthly usage.',
    ),
  },
  {
    kind: 'mimo',
    id: 'mimo',
    label: both('小米 MiMo', 'Xiaomi MiMo'),
    baseUrl: 'https://platform.xiaomimimo.com/api/v1',
    auth: 'cookie',
    apiKeyEnv: 'MIMO_CONSOLE_COOKIE',
    credentials: [{ ref: 'MIMO_CONSOLE_COOKIE', why: both('控制台会话 Cookie', 'the console session cookie') }],
    shows: both('月限额', 'the monthly window'),
    detail: both(
      '平台控制台接口，认证方式是 Cookie。\n在卡片里粘贴整条 Copy as cURL 也可以，卡片会自己把 Cookie 抠出来。',
      'A platform-console endpoint authenticated by cookie.\nPasting a whole "Copy as cURL" into the card works too — the card extracts the cookie itself.',
    ),
  },
  {
    kind: 'openrouter',
    id: 'openrouter',
    label: both('OpenRouter', 'OpenRouter'),
    baseUrl: 'https://openrouter.ai',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    credentials: [{ ref: 'OPENROUTER_API_KEY', why: both('credits 接口', 'the credits endpoint') }],
    shows: both('剩余额度（credits）', 'remaining credits'),
    detail: both('GET /api/v1/credits → 总额度与已用。', 'GET /api/v1/credits → total and used credits.'),
  },
  {
    kind: 'siliconflow',
    id: 'siliconflow',
    label: both('SiliconFlow 硅基流动', 'SiliconFlow'),
    baseUrl: 'https://api.siliconflow.cn',
    apiKeyEnv: 'SILICONFLOW_API_KEY',
    credentials: [{ ref: 'SILICONFLOW_API_KEY', why: both('余额接口', 'the balance endpoint') }],
    shows: both('账户余额', 'account balance'),
    detail: both('GET {base}/v1/user/info → 余额。', 'GET {base}/v1/user/info → the balance.'),
  },
]

/** Every kind the panel can collect, whether or not this catalog offers it. */
const VENDOR_KINDS = [
  'opencode-go', 'zai', 'deepseek', 'moonshot', 'grok', 'mimo',
  'openrouter', 'siliconflow', 'qwen', 'commandcode', 'custom', 'custom2',
]

const byKind = new Map(PLATFORMS.map((platform) => [platform.kind, platform]))

/**
 * The `subscriptions` entry for a platform — exactly the fields the panel reads
 * (`hud/panels/quota/host.js`, the `cfg.subscriptions` loop).
 * @param {Platform} platform
 */
function subscriptionFor(platform) {
  /** @type {Record<string, unknown>} */
  const entry = {
    id: platform.id,
    // The card shows `label`, so give it a readable one rather than the id.
    label: platform.label.zh,
    kind: platform.kind,
    apiKeyEnv: platform.apiKeyEnv ?? '',
    auth: platform.auth ?? 'bearer',
  }
  // Only when the platform HAS an endpoint of its own. Omitting it would let
  // the panel's global default (`https://opencode.ai/zen/go`) through, which is
  // exactly the trap this field exists to avoid.
  if (platform.baseUrl !== '') entry.baseUrl = platform.baseUrl
  return entry
}

/** The platforms a `subscriptions` list currently selects, in catalog order. */
function selectedKinds(subscriptions) {
  if (!Array.isArray(subscriptions)) return []
  const kinds = subscriptions.map((entry) => (entry && typeof entry === 'object' ? String(entry.kind ?? '') : ''))
  return PLATFORMS.filter((platform) => kinds.includes(platform.kind)).map((platform) => platform.kind)
}

/** Every credential ref the catalog may ask for, with why. */
function credentialRefs(platforms = PLATFORMS) {
  const out = new Map()
  for (const platform of platforms) {
    for (const credential of platform.credentials) {
      if (!out.has(credential.ref)) out.set(credential.ref, { ref: credential.ref, optional: credential.optional === true, why: credential.why, platform: platform.label.zh })
    }
  }
  return [...out.values()]
}

/**
 * The credential refs that belong ONLY to platforms the user did not choose.
 *
 * This exists because the panel discovers some rows on its own — the built-in
 * DeepSeek source appears whenever `DEEPSEEK_API_KEY` resolves, and there is no
 * configuration field that removes a row once discovered. What the port DOES
 * own is `ctx.credentials`, which is exactly what that discovery asks. So a
 * credential whose platform is not on the list is simply not visible to the
 * panels, and the row it would have created never appears.
 *
 * A ref is hidden only when EVERY platform that uses it is unselected, so a
 * shared or unrecognised ref is never taken away by accident.
 *
 * `keep` is the exception, and it is not optional in practice: when the panel
 * discovers NOTHING it always renders one fallback row of its own, from its
 * `apiKeyEnv`. Hiding that credential cannot remove the row — it can only make
 * it render "credential not configured" for a credential the user has. The
 * fallback ref therefore always stays visible.
 *
 * @param {string[]} selected platform kinds the user chose
 * @param {string} [keep] a ref the panel's own fallback row depends on
 * @returns {Set<string>}
 */
function hiddenRefs(selected, keep = '') {
  const chosen = new Set(selected)
  /** @type {Map<string, { chosen: number, total: number }>} */
  const owners = new Map()
  for (const platform of PLATFORMS) {
    const refs = [platform.apiKeyEnv, ...platform.credentials.map((credential) => credential.ref)]
    for (const ref of refs) {
      if (typeof ref !== 'string' || ref === '') continue
      const entry = owners.get(ref) ?? { chosen: 0, total: 0 }
      entry.total += 1
      if (chosen.has(platform.kind)) entry.chosen += 1
      owners.set(ref, entry)
    }
  }
  const hidden = new Set()
  for (const [ref, entry] of owners) {
    if (entry.chosen === 0 && ref !== keep) hidden.add(ref)
  }
  return hidden
}

module.exports = { PLATFORMS, VENDOR_KINDS, byKind, subscriptionFor, selectedKinds, credentialRefs, hiddenRefs }