import { atom, read, update } from 'claude-code'
import type { CoreEngineInterface, Register, RenderNode, SessionRateLimit } from 'claude-code'

import type { BigItem, Breakdown, Limit, Row, Usage } from '../types'

type Engine = CoreEngineInterface

// ───────── 설정값 ─────────
const COMPACT_AT = 70 // 컨텍스트가 이 % 이상이면 /compact 를 권한다
const CLEAR_AT = 85 // 이 % 이상이면 /clear 도 권한다

// 로그 줄이기: 이 줄(행) 수를 넘는 Bash 출력만 줄인다.
const MIN_LINES = 80
const HEAD = 20
const TAIL = 40
const KEEP_MIDDLE = 60
const IMPORTANT = /error|fail|warn|exception|traceback|panic|fatal|denied|not found|✗|✖|×/i
// 파일 내용을 그대로 보려는 명령은 건드리지 않는다.
const SKIP_COMMAND = /^\s*(cat|head|tail|sed|awk|less|more|type|get-content|git\s+(diff|show|log|blame))\b/i

// 큰 작업 경고: 한 번에 읽는 파일이 이 토큰(추정)을 넘으면 알린다. 글자 수 / 4 로 어림한다.
const BIG_READ_TOKENS = 15_000
const SKIP_READ = /\.(png|jpe?g|gif|webp|pdf)$/i

// 사용처: 한 줄에 보여 줄 항목 수, 이 비율(%) 이상이면 MCP 정리를 권한다.
const USAGE_ROWS = 5
const MCP_WARN = 10

// 쉰 시간: 화면 시간을 따라가게 하는 주기
const TICK_MS = 30_000

const SHOWN = ['five_hour', 'seven_day'] // 한도 표시 순서

// 데스크톱에서 기능 캡슐 뒤에 까는 옅은 배경(밝은·어두운 테마 모두에서 은은하게 보이는 반투명 회색)
const CAPSULE_BG = 'rgba(128,128,128,0.18)'

// ───────── 값(화면이 읽는 상태) ─────────
// atom 의 첫 인자는 plugin·key 가 글자 그대로(리터럴) 적힌 객체여야 앱이 읽을 수 있다.
const usageAtom = atom({ plugin: 'token-gauge', key: 'usage' } as const, { percent: null, limits: [] } as Usage)
const savedAtom = atom({ plugin: 'token-gauge', key: 'savedTokens' } as const, 0)
const reducerAtom = atom({ plugin: 'token-gauge', key: 'isReducerOn' } as const, true)
// 펼쳐진 기능 캡슐의 id. null 은 자동, 'none' 은 사용자가 직접 접은 상태. 한 번에 하나만 펼친다.
const openAtom = atom({ plugin: 'token-gauge', key: 'openGroup' } as const, null as string | null)
const lastActiveAtom = atom({ plugin: 'token-gauge', key: 'lastActive' } as const, null as number | null)
const runningAtom = atom({ plugin: 'token-gauge', key: 'isRunning' } as const, false)
const nowAtom = atom({ plugin: 'token-gauge', key: 'now' } as const, 0)
const breakdownAtom = atom({ plugin: 'token-gauge', key: 'breakdown' } as const, null as Breakdown | null)
const bigAtom = atom({ plugin: 'token-gauge', key: 'bigItems' } as const, [] as BigItem[])
const loopAtom = atom({ plugin: 'token-gauge', key: 'loopIds' } as const, [] as string[])
const agentAtom = atom({ plugin: 'token-gauge', key: 'agentCount' } as const, 0)

// ───────── 표시용 도우미 ─────────
// 리셋까지 남은 시간을 시간 단위로: "2d 4h", "4h", "<1h". 알 수 없으면 빈 문자열.
const timeLeft = (iso: string | undefined): string => {
  if (!iso) return ''
  const ms = new Date(iso).getTime() - Date.now()
  if (Number.isNaN(ms)) return ''
  const hours = Math.floor(ms / 3_600_000)
  if (hours < 1) return '<1h'
  const d = Math.floor(hours / 24)
  const h = hours % 24
  if (d === 0) return `${h}h`
  return h === 0 ? `${d}d` : `${d}d ${h}h`
}

// 사용률 색: 평소엔 기본색, 70% 부터 경고, 90% 부터 위험
const levelColor = (percent: number): 'warning' | 'error' | undefined =>
  percent >= 90 ? 'error' : percent >= 70 ? 'warning' : undefined

const short = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n))

const pctText = (tokens: number, window: number): string => {
  if (window <= 0) return '-'
  const p = (tokens / window) * 100
  return p < 1 ? '<1%' : `${Math.round(p)}%`
}

const toUsage = (percent: number | undefined, rateLimits: readonly SessionRateLimit[]): Usage => ({
  percent: percent ?? null,
  limits: rateLimits.map((l): Limit => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
})

// 컨텍스트 항목 이름(영어)을 한글로. 모르는 이름은 그대로 둔다.
const LABELS: [RegExp, string][] = [
  [/mcp/i, 'MCP 도구'],
  [/memory/i, 'CLAUDE.md'],
  [/skill/i, '스킬'],
  [/message/i, '대화'],
  [/system prompt/i, '시스템 지침'],
  [/system tool/i, '기본 도구'],
  [/agent/i, '보조 AI'],
  [/slash|command/i, '명령'],
]
const labelOf = (name: string): string => LABELS.find(([re]) => re.test(name))?.[1] ?? name

// 프롬프트 캐시가 살아 있는 시간(분). 구독의 한도 안에서는 1시간, 그 밖(API 키·추가 크레딧)은 5분이다.
// 한도 값이 있고 모두 100% 미만이면 구독 한도 안으로 본다(어림).
const cacheTtlMin = (limits: readonly Limit[]): number =>
  limits.length > 0 && limits.every(l => l.percentUsed < 100) ? 60 : 5

// ───────── 긴 로그 줄이기 ─────────
// 연속으로 같은 줄이 3번 이상 나오면 한 줄 + (×N)으로 합친다.
const collapse = (lines: string[]): string[] => {
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const cur = lines[i] ?? ''
    let j = i + 1
    while (j < lines.length && lines[j] === cur) j++
    const run = j - i
    if (run >= 3) out.push(`${cur}  (같은 줄 ×${run})`)
    else for (let k = i; k < j; k++) out.push(cur)
    i = j
  }
  return out
}

// 줄일 게 없으면 null. 처음·끝·오류 줄은 남기고 가운데만 생략한다.
const shrink = (text: string): { text: string; originalLines: number; keptLines: number } | null => {
  const original = text.split('\n')
  if (original.length <= MIN_LINES) return null

  const lines = collapse(original)
  const keep = new Set<number>()
  for (let i = 0; i < Math.min(HEAD, lines.length); i++) keep.add(i)
  for (let i = Math.max(0, lines.length - TAIL); i < lines.length; i++) keep.add(i)

  let extra = 0
  for (let i = HEAD; i < lines.length - TAIL && extra < KEEP_MIDDLE; i++) {
    if (IMPORTANT.test(lines[i] ?? '')) {
      keep.add(i)
      extra++
    }
  }

  const out: string[] = []
  let prev = -1
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i > prev + 1) out.push(`… (${i - prev - 1}줄 생략) …`)
    out.push(lines[i] ?? '')
    prev = i
  }
  if (prev < lines.length - 1) out.push(`… (${lines.length - 1 - prev}줄 생략) …`)

  const reduced = out.join('\n')
  if (reduced.length > text.length * 0.8) return null // 별로 안 줄면 그대로 둔다
  return { text: reduced, originalLines: original.length, keptLines: out.length }
}

// 원본을 저장할 폴더: dev-mods 밖(~/.claude/token-gauge-logs)이면 재로드를 건드리지 않는다.
const logDir = ($: Engine): string => {
  const root = $.plugin.root.replace(/\\/g, '/')
  const at = root.indexOf('/dev-mods/')
  return at >= 0 ? `${root.slice(0, at)}/token-gauge-logs` : `${root}/../token-gauge-logs`
}

type BashRecord = {
  stdout: string
  stderr: string
  interrupted?: boolean
  isImage?: boolean
  backgroundTaskId?: string
  persistedOutputPath?: string
  structuredContent?: unknown[]
}

// ───────── 사용처 측정 ─────────
// 컨텍스트를 항목별로 나눈다('summary': 내 컴퓨터에서 어림하므로 비용이 들지 않는다).
const refreshBreakdown = async ($: Engine): Promise<void> => {
  try {
    const { context } = await $.session.usage({ breakdown: 'summary' })
    const b = context.breakdown
    if (!b) return
    const rows: Row[] = b.categories
      .filter(c => c.kind === 'used' && c.tokens > 0)
      .map(c => ({ label: labelOf(c.name), tokens: c.tokens }))
      .sort((a, z) => z.tokens - a.tokens)
      .slice(0, USAGE_ROWS)
    await update($, breakdownAtom, () => ({ rows, window: b.rawMaxTokens }))
  } catch {
    // 측정하지 못하면 이전 값을 그대로 둔다.
  }
}

export const register: Register = on => {
  // ── 시작: 사용량·사용처를 읽고, 화면이 시간을 따라가도록 타이머를 건다 ──
  on('session.start', async ($, e, next) => {
    const { context, rateLimits } = await $.session.usage()
    const now = Date.now()
    await update($, usageAtom, () => toUsage(context.percent, rateLimits))
    await update($, nowAtom, () => now)
    await update($, lastActiveAtom, v => v ?? now)
    $.clock.every(TICK_MS, () => {
      void update($, nowAtom, () => Date.now())
    })
    await refreshBreakdown($)
    return next(e)
  })

  // ── 턴이 끝날 때마다: 사용량·사용처 갱신 ──
  on('session.measure', async ($, e, next) => {
    await update($, usageAtom, () => toUsage(e.context.percent, e.rateLimits))
    // 컨텍스트가 다시 낮아지면 "직접 접어 둔" 표시를 풀어서, 다음에 찰 때 자동으로 다시 알려 준다.
    if ((e.context.percent ?? 0) < COMPACT_AT) {
      await update($, openAtom, v => (v === 'none' ? null : v))
    }
    await refreshBreakdown($)
    return next(e)
  })

  // ── 쉰 시간: 마지막으로 응답이 오간 시각을 기록 ──
  on('prompt.submit', async ($, e, next) => {
    await update($, runningAtom, () => true)
    await update($, lastActiveAtom, () => Date.now())
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await update($, runningAtom, () => false)
    await update($, lastActiveAtom, () => Date.now())
    return next(e)
  })

  // ── 긴 Bash 출력 줄이기 ──
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.result === undefined) return ran
    if (!(await read($, reducerAtom))) return ran
    if (SKIP_COMMAND.test(e.command)) return ran

    const record = ran.result as BashRecord
    if (record.interrupted || record.isImage || record.backgroundTaskId || record.persistedOutputPath) return ran
    if (record.structuredContent !== undefined) return ran

    const shrunk = shrink(record.stdout)
    if (shrunk === null) return ran

    // 원본을 먼저 저장한다. 저장이 안 되면 맥락을 지키려고 줄이지 않는다.
    const path = `${logDir($)}/${await $.clock.now()}.txt`
    try {
      await $.fs.write(path, record.stdout)
    } catch {
      return ran
    }

    const note = `\n[token-gauge] 긴 출력 ${shrunk.originalLines}줄을 ${shrunk.keptLines}줄로 줄였어요(처음·끝·오류 줄은 유지). 원본 전체: ${path}`
    const savedTokens = Math.max(0, Math.round((record.stdout.length - shrunk.text.length) / 4))
    await update($, savedAtom, n => n + savedTokens)

    return { result: { ...ran.result, stdout: shrunk.text + note }, context: ran.context }
  })

  // ── 큰 작업 경고 ① 큰 파일 읽기: 막지 않고, 알리고 기록만 한다 ──
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    // 일부만 읽는 경우(limit·pages)와 이미지·PDF 는 크기를 어림하지 않는다.
    if (e.limit === undefined && e.pages === undefined && !SKIP_READ.test(e.file_path)) {
      try {
        const stat = await $.fs.stat(e.file_path)
        const tokens = Math.round(stat.size / 4)
        if (stat.kind === 'file' && tokens >= BIG_READ_TOKENS) {
          const name = e.file_path.split(/[\\/]/).pop() ?? e.file_path
          $.ui.toast(`큰 파일을 읽어요: ${name} (약 ${short(tokens)} 토큰)`, { timeoutMs: 6000 })
          await update($, bigAtom, items => [...items.slice(-4), { what: name, tokens }])
        }
      } catch {
        // 크기를 못 재면 조용히 넘어간다.
      }
    }
    return next(e)
  })

  // ── 큰 작업 경고 ② 보조 AI ──
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    await update($, agentAtom, n => n + 1)
    return next(e)
  })

  // ── 큰 작업 경고 ③ 반복 작업(쉬는 중에도 돌며 대화 전체를 매번 다시 읽는다) ──
  on('tool.call', { tool: 'CronCreate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.result !== undefined) {
      const made = ran.result as { id?: string; recurring?: boolean }
      const id = made.id
      if (made.recurring === true && id !== undefined) {
        await update($, loopAtom, ids => (ids.includes(id) ? ids : [...ids, id]))
      }
    }
    return ran
  })

  on('tool.call', { tool: 'CronDelete' }, async ($, e, next) => {
    await update($, loopAtom, ids => ids.filter(id => id !== e.id))
    return next(e)
  })

  on('tool.call', { tool: 'ScheduleWakeup' }, async ($, e, next) => {
    if (e.stop === true) await update($, loopAtom, ids => ids.filter(id => id !== 'wake'))
    else await update($, loopAtom, ids => (ids.includes('wake') ? ids : [...ids, 'wake']))
    return next(e)
  })

  // ── 프롬프트 위 줄 ──
  // 구조: [Usage ··········· 한도 게이지  (캡슐)(캡슐)(캡슐)]
  //       캡슐을 누르면 그 아래로 한 줄이 펼쳐진다. 한 번에 하나만 펼친다.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const usage = await read($, usageAtom)
    const saved = await read($, savedAtom)
    const isOn = await read($, reducerAtom)
    const open = await read($, openAtom)
    const nowTick = await read($, nowAtom) // 타이머가 올려 줘야 시간이 흐르는 걸 따라간다
    const lastActive = await read($, lastActiveAtom)
    const isRunning = await read($, runningAtom)
    const breakdown = await read($, breakdownAtom)
    const bigItems = await read($, bigAtom)
    const loopIds = await read($, loopAtom)
    const agents = await read($, agentAtom)
    const { Box, Button, Text } = $.ui.resolve(e)

    // 데스크톱은 Button 안쪽 글자의 색·배경을 무시한다(화면 확인으로 알게 됨).
    // 그래서 색은 전부 Button 바깥의 Text/Box 에 걸고, Button 은 글자만 담는다.
    const isTerminal = e.surface === 'terminal'

    const limits = SHOWN.map(kind => usage.limits.find(l => l.kind === kind)).filter(
      (l): l is Limit => l !== undefined,
    )
    const percent = usage.percent ?? 0
    const needsCompact = percent >= COMPACT_AT
    const needsClear = percent >= CLEAR_AT

    const runCmd = (command: string) => async () => {
      try {
        await $.command.run({ command })
      } catch {
        $.ui.toast(`/${command} 를 실행하지 못했어요. 직접 입력해 주세요.`)
      }
    }

    // 값이 점점 쌓이는 칸을 위한 공통 모양
    type Feature = {
      id: string
      dot: string
      dotColor: 'success' | 'warning' | 'error' | undefined
      isDim: boolean
      label: string
      tail: string
      autoOpen: boolean // 눌러 두지 않아도 스스로 펼쳐질 만큼 급한가
      rows: RenderNode // 펼쳤을 때 아랫줄에 나올 내용
    }
    const features: Feature[] = []

    // 공통: 아랫줄의 동작 칩 한 개 (색은 Button 바깥의 Box 에 건다)
    const chip = (key: string, label: string, tone: 'warning' | 'error' | undefined, go: () => void) => (
      <Box key={key} backgroundColor={tone} paddingX={tone ? 1 : 0}>
        <Button key={key} plain dimColor={tone === undefined} label={label} onPress={go} />
      </Box>
    )
    const bar = (k: string) => <Text key={k} dimColor> │ </Text>

    // ① 로그축약 ─ /compact·/clear 도 이 기능에 속한다
    {
      const items: RenderNode[] = []
      const push = (node: RenderNode, key: string) => {
        if (items.length > 0) items.push(bar(`bar-${key}`))
        items.push(node)
      }
      push(chip('compact', '/compact', needsCompact ? 'warning' : undefined, runCmd('compact')), 'compact')
      push(chip('clear', '/clear', needsClear ? 'error' : undefined, runCmd('clear')), 'clear')
      push(
        chip('toggle', isOn ? '끄기' : '켜기', undefined, () => {
          void update($, reducerAtom, v => !v)
        }),
        'toggle',
      )
      features.push({
        id: 'reducer',
        dot: isOn ? '●' : '○',
        dotColor: isOn ? (needsCompact ? 'warning' : 'success') : undefined,
        isDim: !isOn,
        label: '로그축약',
        tail: saved > 0 ? `≈${short(saved)}` : '',
        autoOpen: needsCompact,
        rows: (
          <Box flexDirection="row" flexWrap="nowrap">
            {items}
          </Box>
        ),
      })
    }

    // ② 사용처 ─ 컨텍스트를 무엇이 차지하는지
    {
      const rows = breakdown?.rows ?? []
      const win = breakdown?.window ?? 0
      const mcp = rows.find(r => r.label === 'MCP 도구')
      const mcpShare = mcp && win > 0 ? (mcp.tokens / win) * 100 : 0
      features.push({
        id: 'usage',
        dot: '▤',
        dotColor: mcpShare >= MCP_WARN ? 'warning' : undefined,
        isDim: false,
        label: '사용처',
        tail: '',
        autoOpen: false,
        rows:
          breakdown === null ? (
            <Text dimColor>측정 중…</Text>
          ) : (
            <Box flexDirection="row" flexWrap="nowrap">
              {rows.map((r, i) => (
                <Box key={r.label} flexDirection="row" flexWrap="nowrap">
                  {i > 0 ? bar(`u-${r.label}`) : null}
                  <Text dimColor>{r.label} </Text>
                  <Text weight="bold">{pctText(r.tokens, win)}</Text>
                </Box>
              ))}
              {mcpShare >= MCP_WARN ? (
                <Box flexDirection="row" flexWrap="nowrap">
                  <Text dimColor> │ 안 쓰는 MCP는 </Text>
                  <Button key="mcp" plain dimColor label="/mcp" onPress={runCmd('mcp')} />
                  <Text dimColor> 에서 끄세요</Text>
                </Box>
              ) : null}
            </Box>
          ),
      })
    }

    // ③ 캐시(쉰 시간) ─ 한참 쉬면 캐시가 식어서 다음 메시지가 한도를 더 쓴다
    {
      const now = Math.max(nowTick, lastActive ?? 0)
      const idleMs = lastActive === null ? 0 : Math.max(0, now - lastActive)
      const ttl = cacheTtlMin(usage.limits)
      const remain = Math.ceil(ttl - idleMs / 60_000)
      const isCold = !isRunning && remain <= 0
      const idleMin = Math.floor(idleMs / 60_000)
      features.push({
        id: 'cache',
        dot: '◷',
        dotColor: isCold ? 'warning' : 'success',
        isDim: false,
        label: '캐시',
        tail: isRunning ? '작업 중' : isCold ? '식음' : `${remain}분`,
        autoOpen: false,
        rows: isRunning ? (
          <Text dimColor>작업 중이라 캐시가 계속 이어져요</Text>
        ) : isCold ? (
          <Box flexDirection="row" flexWrap="nowrap">
            <Text dimColor>{idleMin}분 쉬어서 캐시가 식었어요. 이어 하면 전체를 다시 읽어요. 다른 일이면 </Text>
            {chip('cold-clear', '/clear', 'warning', runCmd('clear'))}
          </Box>
        ) : (
          <Text dimColor>
            마지막 응답 {idleMin}분 전 · 약 {remain}분 더 유지돼요(기준 {ttl}분) · 지금 이어 하면 가장 아껴요
          </Text>
        ),
      })
    }

    // ④ 큰 작업 ─ 큰 파일 읽기, 반복 작업, 보조 AI. 있을 때만 나타난다.
    {
      const count = bigItems.length + loopIds.length + (agents > 0 ? 1 : 0)
      if (count > 0) {
        const lines: RenderNode[] = []
        for (const b of bigItems) lines.push(<Text key={`b-${b.what}-${b.tokens}`} dimColor>큰 파일 {b.what} ≈{short(b.tokens)}</Text>)
        if (loopIds.length > 0) {
          lines.push(
            <Text key="loops" dimColor>
              반복 작업 {loopIds.length}개(쉬는 중에도 돌며 대화 전체를 읽어요)
            </Text>,
          )
        }
        if (agents > 0) lines.push(<Text key="agents" dimColor>보조 AI {agents}회</Text>)
        const content: RenderNode[] = []
        lines.forEach((node, i) => {
          if (i > 0) content.push(bar(`h-${i}`))
          content.push(node)
        })
        content.push(bar('h-clear'))
        content.push(
          chip('h-reset', '지우기', undefined, () => {
            void update($, bigAtom, () => [])
            void update($, agentAtom, () => 0)
          }),
        )
        features.push({
          id: 'heavy',
          dot: '⚠',
          dotColor: loopIds.length > 0 || bigItems.length > 0 ? 'warning' : undefined,
          isDim: false,
          label: '큰 작업',
          tail: String(count),
          autoOpen: false,
          rows: (
            <Box flexDirection="row" flexWrap="nowrap">
              {content}
            </Box>
          ),
        })
      }
    }

    // 어느 캡슐이 펼쳐질지: 직접 접었으면 없음, 직접 폈으면 그것, 아니면 급한 것(있으면)
    const autoId = features.find(f => f.autoOpen)?.id ?? null
    const openId =
      open === 'none' ? null : open !== null && features.some(f => f.id === open) ? open : autoId
    const openFeature = features.find(f => f.id === openId)

    const toggle = (f: Feature, isThis: boolean) => () => {
      void update($, openAtom, () => (isThis ? 'none' : f.id))
      if (f.id === 'usage' && !isThis) void refreshBreakdown($)
    }

    // 캡슐 한 개. 하나가 펼쳐져 있으면 나머지는 아이콘만 남겨 윗줄을 지킨다.
    const capsule = (f: Feature) => {
      const isThis = openId === f.id
      const text = f.tail ? `${f.label} ${f.tail}` : f.label
      const label = isThis ? `${text} ▴` : openId !== null ? '▾' : `${text} ▾`
      return (
        <Box
          key={f.id}
          flexDirection="row"
          flexWrap="nowrap"
          backgroundColor={isTerminal ? undefined : CAPSULE_BG}
          paddingX={isTerminal ? 0 : 1}
        >
          {isTerminal ? <Text dimColor>[</Text> : null}
          <Text color={f.dotColor} dimColor={f.isDim}>
            {f.dot}{' '}
          </Text>
          <Button key={f.id} plain dimColor={f.isDim} label={label} onPress={toggle(f, isThis)} />
          {isTerminal ? <Text dimColor>]</Text> : null}
        </Box>
      )
    }

    const capsules: RenderNode[] = []
    features.forEach((f, i) => {
      if (i > 0) capsules.push(<Text key={`sp-${f.id}`}> </Text>)
      capsules.push(capsule(f))
    })

    return (
      <Box flexDirection="column" width="100%">
        <Box flexDirection="row" flexWrap="nowrap" justifyContent="space-between" width="100%">
          {/* 왼쪽 끝: 제목. 이 줄 전체가 토큰 관리라는 표시 */}
          <Text weight="bold">Usage</Text>
          {/* 오른쪽 끝: 한도 게이지 + 기능 캡슐들 */}
          <Box flexDirection="row" flexWrap="nowrap">
            {/* 1순위: 사용률(굵게, 수위에 따라 색) → 2순위: 리셋까지 남은 시간(흐리게) */}
            {limits.map((l, i) => {
              const pct = Math.round(l.percentUsed)
              const left = timeLeft(l.resetsAt)
              return (
                <Text key={l.kind}>
                  {i > 0 ? <Text dimColor> │ </Text> : null}
                  <Text weight="bold" color={levelColor(pct)}>
                    {pct}%
                  </Text>
                  {left ? <Text dimColor> ↻{left}</Text> : null}
                </Text>
              )
            })}
            {/* 한도 값이 아직 없을 때(세션 시작 직후나 API 요금제)는 빈칸 대신 흐린 자리표시 */}
            {limits.length > 0 ? <Text>  </Text> : <Text dimColor>한도 –  </Text>}
            {capsules}
          </Box>
        </Box>
        {/* 펼침(아랫줄): 캡슐 바로 아래, 같은 오른쪽 끝에 그 기능의 내용이 나타난다. */}
        {openFeature ? (
          <Box flexDirection="row" flexWrap="nowrap" justifyContent="flex-end" width="100%">
            <Box
              flexDirection="row"
              flexWrap="nowrap"
              backgroundColor={isTerminal ? undefined : CAPSULE_BG}
              paddingX={isTerminal ? 0 : 1}
            >
              {isTerminal ? <Text dimColor>[</Text> : null}
              {openFeature.rows}
              {isTerminal ? <Text dimColor>]</Text> : null}
            </Box>
          </Box>
        ) : null}
      </Box>
    )
  })
}
