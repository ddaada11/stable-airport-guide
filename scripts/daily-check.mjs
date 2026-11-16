// 每日可用性检测（稳定机场仓库专用，自包含，不依赖主仓库）
// 用法：node scripts/daily-check.mjs
// 产出：更新 README.md 里 <!-- UPTIME:START --> ... <!-- UPTIME:END --> 之间的表格
//
// 为什么专线机场更要检测：这个价位读者付的是「稳定性溢价」，
// 官网打不开对他们来说就是「这家跑路了」，比便宜档更敏感。

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const AIRPORTS = join(root, 'data', 'airports.json')
const UPTIME = join(root, 'data', 'uptime.json')
const README = join(root, 'README.md')
const KEEP_DAYS = 30

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const PARKED =
  /domain (?:is |may be )?for sale|buy this domain|this website is for sale|domain parking|sedoparking|godaddy\.com\/forsale|dan\.com|域名(?:正在|已)?(?:出售|转让)|此域名出售/i

const today = () => {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  return d.toISOString().slice(0, 10)
}

async function probe(host) {
  const t0 = Date.now()
  try {
    const res = await fetch('https://' + host + '/', {
      headers: { 'user-agent': UA, accept: 'text/html,*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    })
    const ms = Date.now() - t0
    const html = (await res.text()).slice(0, 3000)
    if (PARKED.test(html)) return { ok: false, ms, code: res.status, note: '停放页' }
    const ok = [200, 301, 302, 403].includes(res.status)
    return { ok, ms, code: res.status, note: ok ? '' : `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, code: 0, note: String(e.message || e).slice(0, 40) }
  }
}

const airports = JSON.parse(readFileSync(AIRPORTS, 'utf8'))

let hist = { updated: '', days: {} }
if (existsSync(UPTIME)) {
  try {
    hist = JSON.parse(readFileSync(UPTIME, 'utf8'))
  } catch {}
}
if (!hist.days) hist.days = {}

const day = today()
const results = {}
console.log(`检测 ${airports.length} 家机场（${day}）...\n`)
for (const a of airports) {
  let best = null
  for (const h of a.hosts) {
    const r = await probe(h)
    if (r.ok) {
      best = { ...r, host: h }
      break
    }
    if (!best) best = { ...r, host: h }
  }
  results[a.name] = best
  console.log(`  ${best.ok ? '✅' : '❌'} ${a.name.padEnd(14)} ${String(best.code).padEnd(4)} ${String(best.ms).padStart(5)}ms  ${best.note}`)
}

hist.days[day] = results
hist.updated = new Date().toISOString()
const keys = Object.keys(hist.days).sort()
while (keys.length > KEEP_DAYS) delete hist.days[keys.shift()]
writeFileSync(UPTIME, JSON.stringify(hist, null, 2) + '\n', 'utf8')

// 生成表格
const days = Object.keys(hist.days).sort().slice(-7)
const fmtDay = (d) => d.slice(5)
const cell = (r) => (!r ? '—' : !r.ok ? '❌' : r.ms < 1500 ? '✅' : '🟡')

const lines = []
lines.push('## 最近 7 天可用性（每日自动检测）', '')
lines.push(
  '> 每天早上自动探测各家官网，`✅` 能正常打开（<1.5 秒），`🟡` 能打开但偏慢，`❌` 打不开。' +
    '**专线机场买的是「稳定」，连续 7 天全绿才说明站是活的。**',
  ''
)
lines.push(`| 机场 | ${days.map(fmtDay).join(' | ')} | 可用率 |`)
lines.push(`| :--- | ${days.map(() => ':---:').join(' | ')} | ---: |`)
for (const a of airports) {
  const cells = days.map((d) => cell(hist.days[d]?.[a.name]))
  const okCount = cells.filter((c) => c === '✅' || c === '🟡').length
  const rate = days.length ? Math.round((okCount / days.length) * 100) + '%' : '—'
  lines.push(`| **${a.name}** | ${cells.join(' | ')} | ${rate} |`)
}
lines.push('')
lines.push(`*最近一次检测：${day}（北京时间）｜检测节点：GitHub Actions（境外）*`, '')

const block = lines.join('\n')

if (existsSync(README)) {
  let md = readFileSync(README, 'utf8')
  const START = '<!-- UPTIME:START -->'
  const END = '<!-- UPTIME:END -->'
  if (md.includes(START) && md.includes(END)) {
    md = md.replace(new RegExp(START + '[\\s\\S]*?' + END), `${START}\n${block}\n${END}`)
  } else {
    const anchor = '## 逐家介绍'
    md = md.includes(anchor)
      ? md.replace(anchor, `${START}\n${block}\n${END}\n\n---\n\n${anchor}`)
      : md + `\n${START}\n${block}\n${END}\n`
  }
  writeFileSync(README, md, 'utf8')
  console.log('\n✔ README.md 可用性区块已更新')
}

const prev = days[days.length - 2]
if (prev) {
  const changed = airports.filter((a) => hist.days[prev]?.[a.name]?.ok !== hist.days[day]?.[a.name]?.ok)
  if (changed.length) {
    console.log(`\n状态变化（对比 ${prev}）：`)
    for (const a of changed) console.log(`  ${a.name}: ${hist.days[day][a.name]?.ok ? '恢复' : '打不开'}`)
  } else {
    console.log('\n全部与昨日一致')
  }
}
