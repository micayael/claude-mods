import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Corto } from '../types'

const TOOL = 'guardar'
const corto = atom({ plugin: 'resumen', key: 'corto' } as const, null as Corto)
const rama = atom({ plugin: 'resumen', key: 'rama' } as const, '')
const visible = atom({ plugin: 'resumen', key: 'visible' } as const, true)

const HELP = 'Uso: /resumen (arma el resumen) · /resumen on | off | toggle (banda sobre el prompt)'

// Un archivo por proyecto, fuera del proyecto: ~/.claude/resumen/<ruta-del-proyecto>.txt
async function archivo($: EngineInterface): Promise<string> {
  const home = (await $.env.get('HOME')) ?? '~'
  const root = await $.session.root()
  return `${home}/.claude/resumen/${root.replace(/[^A-Za-z0-9._]/g, '-')}.txt`
}

async function git($: EngineInterface, args: string[]): Promise<string> {
  try {
    const r = await $.process.run(['git', ...args], { cwd: await $.session.root(), timeoutMs: 5000 })
    return r.exitCode === 0 ? r.stdout.trim() : ''
  } catch {
    return ''
  }
}

async function cargar($: EngineInterface): Promise<void> {
  const path = await archivo($)
  const texto = (await $.fs.exists(path)) ? String(await $.fs.read(path)).trim() : ''
  await update($, corto, () => texto || null)
  const r = await git($, ['rev-parse', '--abbrev-ref', 'HEAD'])
  await update($, rama, () => r)
}

async function tareaActual($: EngineInterface): Promise<string> {
  const { value = [] } = await $.state.get({ plugin: 'pendientes', key: 'tasks' } as const)
  return value
    .filter(t => t.status === 'current')
    .map(t => `#${t.id} ${t.title}`)
    .join(', ')
}

const recortar = (s: string, n: number) => {
  const lineas = s.split('\n')
  return lineas.length > n ? `${lineas.slice(0, n).join('\n')}\n… (${lineas.length - n} líneas más)` : s
}

async function pedirResumen($: EngineInterface): Promise<void> {
  const [r, estado, diff, tarea] = await Promise.all([
    git($, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git($, ['status', '--short']),
    git($, ['diff', 'HEAD', '--stat']),
    tareaActual($).catch(() => ''),
  ])
  const datos = [
    `Rama de git: ${r || '(no es un repo de git)'}`,
    `Tarea actual de pendientes: ${tarea || '(ninguna)'}`,
    `Cambios sin commitear (git status --short):\n${recortar(estado, 40) || '(ninguno)'}`,
    diff ? `Resumen del diff:\n${recortar(diff, 30)}` : '',
  ].filter(Boolean)
  const texto = [
    'Resumime en español, en pocas líneas, dónde estamos en este proyecto, para no perder el hilo. Usá la conversación y estos datos.',
    'Formato, una o dos líneas por punto:',
    '- Objetivo: qué estamos haciendo.',
    '- Hecho:',
    '- En curso:',
    '- Falta:',
    '- Decisiones mías pendientes: (o "ninguna")',
    '',
    ...datos,
    '',
    `Al terminar, llamá a la herramienta mcp__resumen__${TOOL} con "corto": una versión de 2 o 3 líneas como máximo (objetivo y en qué quedamos), sin markdown. No hagas nada más.`,
  ].join('\n')
  await $.prompt.submit({ text: texto })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'resumen',
      description: 'Resume objetivo, hecho, en curso, falta y decisiones pendientes; on/off para la banda',
      argumentHint: '[on | off | toggle]',
    })
    await $.tool.register({
      name: TOOL,
      isDeferred: false,
      description:
        'Guarda la versión corta (2 o 3 líneas como máximo) del resumen del proyecto, para la banda sobre el prompt. Usala solo cuando /resumen lo pida.',
      inputSchema: {
        type: 'object',
        properties: { corto: { type: 'string', description: 'Resumen corto, 2 o 3 líneas como máximo, sin markdown' } },
        required: ['corto'],
      },
    })
    const elegido = await $.store.get('visible')
    await update($, visible, () => elegido !== false)
    await cargar($).catch(() => undefined)
    return next(e)
  })

  // Rama y resumen se releen al terminar cada turno (sin modelo: solo git y un archivo)
  on('turn.complete', async ($, e, next) => {
    await cargar($).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'resumen' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off' || arg === 'toggle') {
      const antes = await read($, visible)
      const ahora = arg === 'toggle' ? !antes : arg === 'on'
      await $.store.set('visible', ahora)
      await update($, visible, () => ahora)
      return { text: ahora ? 'Banda de resumen prendida.' : 'Banda de resumen apagada.' }
    }
    if (arg !== '') return { text: HELP }
    void pedirResumen($).catch(err => $.ui.toast(`resumen: ${(err as Error).message}`))
    return { text: 'Armando el resumen…' }
  })

  // La herramienta va siempre en la lista del prompt, nunca detrás de ToolSearch
  on('tool.describe', { tool: 'mcp__resumen__guardar' }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))

  on('tool.call', { tool: 'mcp__resumen__guardar' }, async ($, e) => {
    const input = e as unknown as { corto?: unknown }
    const texto = typeof input.corto === 'string' ? input.corto.trim() : ''
    if (!texto) return { result: 'Falta "corto".' }
    const tres = texto.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 3).join('\n')
    const path = await archivo($)
    await $.fs.write(path, `${tres}\n`)
    await update($, corto, () => tres)
    return { result: `Guardado en ${path}.` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, visible))) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    // Lo que dibujan los mods de abajo (token-weather, por ejemplo) va debajo del resumen
    const debajo = await next(e)
    const texto = await read($, corto)
    const r = await read($, rama)
    const tarea = await tareaActual($).catch(() => '')
    const pie = [r ? `⎇ ${r}` : '', tarea ? `▸ ${tarea}` : ''].filter(Boolean).join('  ·  ')

    const lineas = texto === null ? ['Sin resumen: usá /resumen'] : texto.split('\n')
    const ancho = Math.max(10, e.props.bodyColumns ?? 80)

    return (
      <Box flexDirection="column">
        <Text dimColor>{'─'.repeat(ancho)}</Text>
        {lineas.map((l, i) => (
          <Text dimColor={i > 0}>
            {i > 0 ? '         ' : texto === null ? '' : <Text bold>Resumen: </Text>}
            {l}
          </Text>
        ))}
        {pie !== '' && <Text dimColor>{'         '}{pie}</Text>}
        <Text dimColor>{'─'.repeat(ancho)}</Text>
        {debajo}
      </Box>
    )
  })
}
