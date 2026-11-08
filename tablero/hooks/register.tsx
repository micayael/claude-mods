import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionUsage, TurnUsage } from 'claude-code'

import type { Agent, Cache, Limit, Main, Usage } from '../types'

const PANE = 'tablero'
const TITLE = 'Tablero'

const usage = atom({ plugin: 'tablero', key: 'usage' } as const, null, { shape: 'usage-1' })
const cache = atom({ plugin: 'tablero', key: 'cache' } as const, { read: 0, write: 0, fresh: 0 }, { shape: 'cache-1' })
// Claude Code usa caché de 1 h con suscripción; en exceso de uso baja a 5 min.
const CACHE_TTL_MS = 60 * 60_000
const cacheAt = atom({ plugin: 'tablero', key: 'cacheAt' } as const, null, { shape: 'cacheAt-1' })
const tick = atom({ plugin: 'tablero', key: 'tick' } as const, 0)
const main = atom({ plugin: 'tablero', key: 'main' } as const, null as Main | null, { shape: 'main-1' })
const agents = atom({ plugin: 'tablero', key: 'agents' } as const, [], { shape: 'agents-2' })

const toUsage = (u: Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>): Usage => ({
  tokens: u.context.tokens ?? 0,
  window: u.context.window,
  percent: u.context.percent ?? 0,
  limits: u.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
  usd: u.cost?.usd,
})

const inContext = (u: TurnUsage) => u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens

const windowFor = (model: string, main: Usage | null, mainModel: string) => {
  if (main && model === mainModel) return main.window
  return /\[1m\]/i.test(model) ? 1_000_000 : 200_000
}

const k = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`)

const GRAY = '#6b7280'
const TRACK = '#3f3f46'
const filled = (pct: number, width: number) => Math.round((Math.min(100, Math.max(0, pct)) / 100) * width)

const GREEN = '#22c55e'
const YELLOW = '#eab308'
const RED = '#ef4444'
const tone = (pct: number) => (pct >= 85 ? RED : pct >= 60 ? YELLOW : GREEN)

const effortOf = (e: string | number | undefined) => (e === undefined ? undefined : String(e))
const modelLabel = (m: string, effort?: string) => (effort ? `${shortModel(m)} · ${effort}` : shortModel(m))

const shortModel = (m: string) => m.replace(/^claude-/, '').replace(/-\d{8}$/, '')

const limitName = (kind: string) => (kind === 'five_hour' ? '5 h' : kind === 'seven_day' ? 'Semana' : kind)

const inTime = (iso: string | undefined, now: number) => {
  if (!iso) return ''
  const ms = Date.parse(iso) - now
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h > 0 ? `${h}h ${m}m` : `${m}m`
}

const left = (ms: number) => {
  const m = Math.ceil(ms / 60_000)
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`
}

// Verde con 40% o más del tiempo, amarillo debajo de 40%, rojo debajo de 10%.
const cacheTone = (ms: number) => {
  const pct = (ms / CACHE_TTL_MS) * 100
  return pct < 10 ? RED : pct < 40 ? YELLOW : GREEN
}

// Color propio de cada barra; el % sigue en verde/amarillo/rojo para avisar.
const HUE = { session: '#22d3ee', five_hour: '#c084fc', seven_day: '#f472b6' } as const
const hueOf = (kind: string) => (kind === 'five_hour' ? HUE.five_hour : kind === 'seven_day' ? HUE.seven_day : HUE.session)

const toolLabel = (tool: string, input: Record<string, unknown>) => {
  const raw = input.pattern ?? input.file_path ?? input.command ?? input.query ?? input.url ?? input.description
  if (typeof raw !== 'string' || raw === '') return tool
  const arg = typeof input.file_path === 'string' ? raw.split('/').pop() ?? raw : raw
  return `${tool} ${arg.length > 28 ? `${arg.slice(0, 27)}…` : arg}`
}

const elapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
}

const hitRate = (c: Cache) => {
  const total = c.read + c.write + c.fresh
  return total === 0 ? 0 : Math.floor((c.read / total) * 1000) / 10
}

async function refresh($: EngineInterface) {
  const u = await $.session.usage()
  await update($, usage, () => toUsage(u))
}

// Antes del primer paso del modelo no hay dato real: se toma de la configuración.
async function seedMain($: EngineInterface) {
  const rows = await $.config.list().catch(() => [])
  const pick = (re: RegExp) => {
    const v = rows.find(r => re.test(r.key))?.value
    return typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : undefined
  }
  const model = pick(/^model$/i)
  const effort = pick(/effort/i)
  if (model) await update($, main, cur => cur ?? { model, effort })
}

// Crea el sub-agente si todavía no está (sus primeros pasos pueden llegar antes que agent.spawn).
async function touch($: EngineInterface, id: string, fn: (a: Agent) => Agent) {
  const at = await $.clock.now()
  await update($, agents, list => {
    const cur = list.find(a => a.id === id)
    const base: Agent = cur ?? { id, description: '', type: 'agente', model: '', tokens: 0, window: 0, isDone: false, startedAt: at, steps: 0, tools: 0 }
    const next = fn(base)
    return cur ? list.map(a => (a.id === id ? next : a)) : [...list, next].slice(-30)
  })
}

export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'tablero', description: 'Abre o cierra el panel del tablero (la línea de abajo queda siempre)' })
    // Si lo cerraste a mano, queda cerrado también en sesiones nuevas hasta /tablero.
    if ((await $.store.get('paneHidden').catch(() => false)) !== true) void $.ui.open({ id: PANE, title: TITLE, backgroundColor: 'transparent' })
    void refresh($)
    void seedMain($)
    $.clock.every(5_000, () => void $.clock.now().then(t => update($, tick, () => t)))
    return next(e)
  })

  on('command.run', { command: 'tablero' }, async $ => {
    const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
    if (isOpen) {
      await $.store.set('paneHidden', true)
      await $.ui.close({ id: PANE })
      return { text: 'Panel cerrado; la línea de abajo sigue. /tablero lo vuelve a abrir.' }
    }
    await $.store.set('paneHidden', false)
    await $.ui.open({ id: PANE, title: TITLE, backgroundColor: 'transparent' })
    return { text: 'Panel abierto.' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await $.store.set('paneHidden', true)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await update($, usage, () => toUsage(e))
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const t0 = await $.clock.now()
    const r = await next(e)
    const id = r.agentId
    if (id) {
      await touch($, id, a => ({
        ...a,
        description: e.description ?? a.description,
        type: e.subagentType,
        model: a.model || r.model,
        startedAt: Math.min(a.startedAt, t0),
      }))
    }
    return r
  })

  on('turn.step', async function* ($, e, next) {
    const effort = effortOf(e.effort)
    if (e.agentId) {
      const id = e.agentId
      await touch($, id, a => ({ ...a, model: e.model, effort, steps: a.steps + 1 }))
    } else {
      await update($, main, () => ({ model: e.model, effort }))
    }
    const r = yield* next(e)
    const u = r.usage
    if (u) {
      await update($, cache, c => ({
        read: c.read + u.cache_read_input_tokens,
        write: c.write + u.cache_creation_input_tokens,
        fresh: c.fresh + u.input_tokens,
      }))
      if (e.agentId) {
        const id = e.agentId
        await touch($, id, a => ({ ...a, model: u.model, tokens: inContext(u) }))
      } else {
        const at = await $.clock.now()
        await update($, cacheAt, () => at)
      }
    }
    return r
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId && (e.tool as string) !== 'SubagentHandback') {
      const id = e.agentId
      const what = toolLabel(e.tool, e as unknown as Record<string, unknown>)
      await touch($, id, a => ({ ...a, tools: a.tools + 1, lastTool: what }))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) {
      const id = e.agentId
      const at = await $.clock.now()
      await touch($, id, a => ({ ...a, isDone: true, endedAt: at }))
    } else {
      await refresh($)
    }
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const u = await read($, usage)
    if (e.props.hasSurvey || !u) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, agents)
    const running = list.filter(a => !a.isDone).length
    const m = await read($, main)
    const week = u.limits.find(l => l.kind === 'seven_day')
    const five = u.limits.find(l => l.kind === 'five_hour')
    const now = Math.max(await read($, tick), await $.clock.now())
    const lastAt = await read($, cacheAt)
    const cacheLeft = lastAt === null ? null : lastAt + CACHE_TTL_MS - now

    // Lo que dibujan los mods de abajo (resumen, por ejemplo) va debajo de esta línea.
    const below = await next(e)
    return (
      <Box flexDirection="column">
      <Box>
        {m && <Text bold>{modelLabel(m.model, m.effort)} </Text>}
        {m && <Text dimColor>· </Text>}
        <Text color={HUE.session}>ctx </Text>
        <Text color={tone(u.percent)}>{Math.round(u.percent)}%</Text>
        <Text dimColor> {k(u.tokens)}/{k(u.window)}</Text>
        {five && <Text dimColor> · </Text>}
        {five && <Text color={HUE.five_hour}>5h </Text>}
        {five && <Text color={tone(five.percentUsed)}>{five.percentUsed}%</Text>}
        {week && <Text dimColor> · </Text>}
        {week && <Text color={HUE.seven_day}>sem </Text>}
        {week && <Text color={tone(week.percentUsed)}>{week.percentUsed}%</Text>}
        {week && week.resetsAt && <Text dimColor> (reinicia en {inTime(week.resetsAt, now)})</Text>}
        <Text dimColor> · caché {Math.round(hitRate(await read($, cache)))}%</Text>
        {cacheLeft !== null && (
          <Text color={cacheTone(cacheLeft)}>
            {cacheLeft <= 0 ? ' vencida' : ` vence ${left(cacheLeft)}`}
          </Text>
        )}
        {running > 0 && <Text dimColor> · {running} agente{running === 1 ? '' : 's'}</Text>}
      </Box>
      {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const u = await read($, usage)
    const c = await read($, cache)
    const list = await read($, agents)
    const now = Math.max(await read($, tick), await $.clock.now())
    const lastAt = await read($, cacheAt)
    const cacheLeft = lastAt === null ? null : lastAt + CACHE_TTL_MS - now
    const live = await $.agent.list().catch(() => [])
    const statusOf = (a: Agent) => live.find(l => l.id === a.id)?.status ?? (a.isDone ? 'completed' : 'running')
    const mm = await read($, main)
    // En terminal cada carácter es una columna; en escritorio ocupa más, por eso se acorta.
    const cols = e.props.bodyColumns ?? 40
    const width = Math.max(10, e.surface === 'terminal' ? cols : Math.min(40, Math.floor((cols - 2) * 0.75)))

    // Barra fina: tramo lleno en color y el resto como riel apagado.
    const line = (pct: number, color: string) => {
      const full = filled(pct, width)
      return (
        <Box>
          <Text wrap="truncate-end" color={color}>{'━'.repeat(full)}</Text>
          <Text wrap="truncate-end" color={TRACK}>{'━'.repeat(width - full)}</Text>
        </Box>
      )
    }

    const metric = (label: string, pct: number, detail: string, color: string, hue: string, shown = `${Math.round(pct)}%`) => (
      <Box flexDirection="column" marginBottom={1}>
        <Box justifyContent="space-between">
          <Text bold color={hue}>{label}</Text>
          <Text bold color={color}>{shown}</Text>
        </Box>
        {line(pct, hue)}
        {detail !== '' && <Text dimColor>{detail}</Text>}
      </Box>
    )

    const section = (title: string) => (
      <Text bold underline>
        {title}
      </Text>
    )

    const limits: Limit[] = u?.limits ?? []
    const hit = hitRate(c)
    const hitColor = c.read + c.write + c.fresh === 0 ? GRAY : hit >= 70 ? GREEN : hit >= 40 ? YELLOW : RED

    return (
      <Box flexDirection="column">
        {section('Contexto')}
        {mm && (
          <Box justifyContent="space-between">
            <Text>Modelo</Text>
            <Text bold>{modelLabel(mm.model, mm.effort)}</Text>
          </Box>
        )}
        {u ? metric('Sesión', u.percent, `${k(u.tokens)} de ${k(u.window)} tokens`, tone(u.percent), HUE.session) : <Text dimColor>Sin datos todavía.</Text>}

        {section('Uso de Claude')}
        {limits.length === 0 && <Text dimColor>Aparece después de la primera respuesta.</Text>}
        {limits.map(l => metric(limitName(l.kind), l.percentUsed, l.resetsAt ? `Reinicia en ${inTime(l.resetsAt, now)}` : '', tone(l.percentUsed), hueOf(l.kind)))}
        {u?.usd !== undefined && (
          <Box justifyContent="space-between" marginBottom={1}>
            <Text>Costo de la sesión</Text>
            <Text bold>US$ {u.usd.toFixed(2)}</Text>
          </Box>
        )}

        {section('Caché')}
        <Box flexDirection="column" marginBottom={1}>
          <Box justifyContent="space-between">
            <Text>Aciertos</Text>
            <Text bold color={hitColor}>{hit.toFixed(hit >= 99 && hit < 100 ? 1 : 0)}%</Text>
          </Box>
          {line(hit, hitColor)}
          <Text dimColor>Leídos {k(c.read)} · escritos {k(c.write)} · sin caché {k(c.fresh)}</Text>
          <Text dimColor>Ahorro aprox. {k(Math.round(c.read * 0.9))} tokens</Text>
        </Box>
        {cacheLeft === null && (
          <Box marginBottom={1}>
            <Text dimColor>Vencimiento: aparece después del próximo mensaje.</Text>
          </Box>
        )}
        {cacheLeft !== null && (
          <Box flexDirection="column" marginBottom={1}>
            <Box justifyContent="space-between">
              <Text>Vence en</Text>
              <Text bold color={cacheTone(cacheLeft)}>
                {cacheLeft <= 0 ? 'vencida' : left(cacheLeft)}
              </Text>
            </Box>
            {line(Math.max(0, (cacheLeft / CACHE_TTL_MS) * 100), cacheTone(cacheLeft))}
            <Text dimColor>
              {cacheLeft <= 0 ? 'El próximo mensaje vuelve a escribir todo el contexto.' : 'Cada mensaje la renueva por 1 h.'}
            </Text>
          </Box>
        )}

        {section('Sub-agentes')}
        {list.length === 0 && <Text dimColor>Ninguno en esta sesión.</Text>}
        {list
          .slice()
          .reverse()
          .map(a => {
            const win = windowFor(a.model, u, mm?.model ?? '')
            const pct = win ? (a.tokens / win) * 100 : 0
            const st = statusOf(a)
            const isLive = st === 'running' || st === 'pending' || st === 'waiting'
            return (
              <Box flexDirection="column" marginBottom={1}>
                <Text color={isLive ? HUE.session : GRAY}>
                  {isLive ? '● ' : '○ '}
                  {a.type} · {modelLabel(a.model, a.effort)} · {st}
                </Text>
                {a.description !== '' && <Text color={isLive ? undefined : GRAY} dimColor={isLive}>{a.description}</Text>}
                <Text color={isLive ? undefined : GRAY} dimColor={isLive}>
                  {elapsed((a.endedAt ?? now) - a.startedAt)} · {a.steps} paso{a.steps === 1 ? '' : 's'} · {a.tools} herramienta
                  {a.tools === 1 ? '' : 's'}
                </Text>
                {a.lastTool && (
                  <Text wrap="truncate-end" color={isLive ? HUE.session : GRAY}>
                    {isLive ? 'ahora: ' : 'última: '}
                    {a.lastTool}
                  </Text>
                )}
                <Box justifyContent="space-between">
                  <Text color={isLive ? undefined : GRAY} dimColor={isLive}>
                    {k(a.tokens)} de {k(win)}
                  </Text>
                  <Text color={isLive ? tone(pct) : GRAY}>{Math.round(pct)}%</Text>
                </Box>
                {line(pct, isLive ? tone(pct) : GRAY)}
              </Box>
            )
          })}
      </Box>
    )
  })
}
