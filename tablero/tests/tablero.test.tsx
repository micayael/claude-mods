import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'tablero',
  component: 'Pane',
  requestId: 'tablero',
  props: {
    title: 'Tablero',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const USAGE = {
  startedAt: 0,
  context: { tokens: 90_000, window: 200_000, percent: 45 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 23, resetsAt: '2026-11-08T15:00:00Z' },
    { kind: 'seven_day', percentUsed: 61, resetsAt: '2026-11-10T10:00:00Z' },
  ],
  cost: { usd: 1.5 },
}

test('muestra contexto, límites, caché y sub-agentes', async ($, on) => {
  on('command.register', () => ({ value: { command: 'tablero' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => ({ value: USAGE }))
  on('agent.list', () => ({ value: [] }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('clock.now', () => ({ value: Date.parse('2026-11-08T12:00:00Z') }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: {
        model: 'claude-haiku-5-5',
        input_tokens: 1000,
        output_tokens: 10,
        cache_read_input_tokens: 40_000,
        cache_creation_input_tokens: 9000,
      },
    }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure({ ...USAGE, changed: ['context', 'rateLimits'] })
  await $.agent.spawn({ prompt: 'x', description: 'Buscar archivos', subagentType: 'Explore' })
  for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'claude-haiku-5-5', effort: 'low', messageCount: 1, agentId: 'a1' })) {
  }

  await $.tool.call({ tool: 'Grep', pattern: 'turn.step', agentId: 'a1' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /1 paso · 1 herramienta/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Grep turn\.step/ })).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /90\.0k de 200\.0k/ }))?.text).toContain('90.0k')
  expect(await ui.find({ type: 'Text', text: /^Semana/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Leídos 40\.0k/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Explore/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Explore · haiku-5-5 · low/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /50\.0k de 200\.0k/ })).toBeTruthy()
  await ui.unmount()

  const band = await $.ui.mount({ plugin: 'tablero', component: 'AbovePrompt', props: {}, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /^23%$/ })).toBeTruthy()
  expect(await band.find({ type: 'Text', text: /sem|caché/ })).toBeFalsy()
  await band.unmount()

  for await (const _ of $.turn.step({ turnId: 'm', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 })) {
  }
  const ui2 = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui2.find({ type: 'Text', text: /^Vence en/ })).toBeTruthy()
  expect(await ui2.find({ type: 'Text', text: /^opus-5-5 · high$/ })).toBeTruthy()
  expect(await ui2.find({ type: 'Text', text: /^1h 0m$/ })).toBeTruthy()
  await ui2.unmount()
})

test('cuenta los pasos que llegan antes de agent.spawn y usa la ventana del principal', async ($, on) => {
  on('command.register', () => ({ value: { command: 'tablero' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => ({ value: { ...USAGE, context: { tokens: 1000, window: 1_000_000, percent: 0.1 } } }))
  on('agent.list', () => ({ value: [] }))
  on('clock.now', () => ({ value: Date.parse('2026-11-08T12:00:00Z') }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a2' }))
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { model: 'claude-opus-5-5', input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 0 },
    }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // El sub-agente da un paso y usa una herramienta antes de que se registre.
  for await (const _ of $.turn.step({ turnId: 's', index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId: 'a2' })) {
  }
  await $.tool.call({ tool: 'Read', file_path: '/x/y/archivo.ts', agentId: 'a2' })
  await $.agent.spawn({ prompt: 'x', description: 'Revisar', subagentType: 'general-purpose' })
  // Recién ahora responde el principal, con el mismo modelo y ventana de 1M.
  for await (const _ of $.turn.step({ turnId: 'm', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /1 paso · 1 herramienta/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /general-purpose · opus-5-5/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Read archivo\.ts/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /100\.0k de 1\.0M/ })).toBeTruthy()
  await ui.unmount()
})

test('/tablero cierra el panel, queda cerrado en la próxima sesión y lo reabre', async ($, on) => {
  const opened: string[] = []
  const closed: string[] = []
  const store = new Map<string, unknown>()
  let panes: { id: string }[] = [{ id: 'tablero' }]
  on('command.register', () => ({ value: { command: 'tablero' } }))
  on('ui.open', (_, e) => (opened.push(e.id), (panes = [{ id: e.id }]), { value: { isPlaced: true } }))
  on('ui.close', (_, e) => (closed.push(e.id), (panes = []), { value: undefined }))
  on('ui.panes', () => ({ value: panes }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => (store.set(e.key, e.value), { value: undefined }))
  on('session.usage', () => ({ value: USAGE }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  const r1 = await $.command.run({ command: 'tablero', args: '' } as never)
  expect(closed).toEqual(['tablero'])
  expect(store.get('paneHidden')).toBe(true)
  expect(JSON.stringify(r1)).toContain('cerrado')

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(opened).toEqual([])

  await $.command.run({ command: 'tablero', args: '' } as never)
  expect(store.get('paneHidden')).toBe(false)
  expect(opened).toEqual(['tablero'])
})

test('la línea deja ver lo que dibujan los mods de abajo', async ($, on) => {
  on('command.register', () => ({ value: { command: 'tablero' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('store.get', () => ({ value: undefined }))
  on('session.usage', () => ({ value: USAGE }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: Date.parse('2026-11-08T12:00:00Z') }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>banda de resumen</Text>
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'tablero', component: 'AbovePrompt', props: {}, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: /banda de resumen/ })).toBeTruthy()
  expect(await band.find({ type: 'Text', text: /^23%$/ })).toBeTruthy()
  expect(await band.find({ type: 'Text', text: /sem|caché/ })).toBeFalsy()
  await band.unmount()
})
