import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOOL = 'mcp__resumen__guardar'

const result = (exitCode: number, stdout: string) =>
  ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never

// Lo que en una sesión responde el engine: un disco, git y el prompt
function bottoms(on: On) {
  const files = new Map<string, string>()
  const prompts: string[] = []
  mock.store(on)
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('session.root', async () => ({ value: '/home/u/proyecto' }))
  on('env.get', async () => ({ value: '/home/u' }) as never)
  on('command.register', async () => ({ value: { command: 'resumen' } }))
  on('tool.register', async () => ({ value: { tool: TOOL } }))
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('fs.exists', async ($, e) => ({ value: files.has(e.path) }) as never)
  on('fs.read', async ($, e) => ({ value: files.get(e.path) ?? '' }) as never)
  on('fs.write', async ($, e) => (files.set(e.path, e.text), { value: undefined }) as never)
  on('process.run', async ($, e) => {
    const line = e.argv.join(' ')
    if (line === 'git rev-parse --abbrev-ref HEAD') return result(0, 'feature/x\n')
    if (line === 'git status --short') return result(0, ' M a.php\n')
    return result(0, '')
  })
  on('prompt.submit', async ($, e) => (prompts.push(e.text), { text: e.text }) as never)
  // Lo que dibuja el engine cuando la banda pasa
  on('ui.render', async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>banda de abajo</Text>
  })
  return { files, prompts }
}

const start = ($: Engine) => $.session.start({ cwd: '/home/u/proyecto' } as never)
const run = async ($: Engine, args: string) => String((await $.command.run({ command: 'resumen', args } as never)).text)
const band = ($: Engine, surface: 'terminal' | 'desktop') =>
  $.ui.mount({ plugin: 'resumen', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false } as never })
const idle = () => new Promise(r => setTimeout(r, 30))

for (const surface of ['terminal', 'desktop'] as const) {
  test(`sin resumen la banda lo dice (${surface})`, async ($, on) => {
    bottoms(on)
    await start($)
    const ui = await band($, surface)
    expect((await ui.findAll({ text: /Sin resumen: usá \/resumen/ })).length).toBeGreaterThan(0)
    expect((await ui.findAll({ text: /⎇ feature\/x/ })).length).toBeGreaterThan(0)
  })

  test(`guardar escribe el archivo del proyecto y la banda lo muestra (${surface})`, async ($, on) => {
    const { files } = bottoms(on)
    await start($)
    await $.tool.call({ tool: TOOL, tool_use_id: 't1', corto: 'Migrar login\nFalta el test\nuna\ncuarta' } as never)
    expect(files.get('/home/u/.claude/resumen/-home-u-proyecto.txt')).toBe('Migrar login\nFalta el test\nuna\n')
    const ui = await band($, surface)
    expect((await ui.findAll({ text: /Migrar login/ })).length).toBeGreaterThan(0)
    expect((await ui.findAll({ text: /cuarta/ })).length).toBe(0)
  })
}

test('/resumen pide el resumen al modelo con rama y cambios', async ($, on) => {
  const { prompts } = bottoms(on)
  await start($)
  expect(await run($, '')).toBe('Armando el resumen…')
  await idle()
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('Rama de git: feature/x')
  expect(prompts[0]).toContain('M a.php')
  expect(prompts[0]).toContain(TOOL)
})

test('off apaga la banda, toggle la prende y se recuerda', async ($, on) => {
  bottoms(on)
  await start($)
  expect(await run($, 'off')).toBe('Banda de resumen apagada.')
  expect((await (await band($, 'terminal')).findAll({ text: /Sin resumen/ })).length).toBe(0)
  // Una sesión nueva lee la elección guardada
  await start($)
  expect((await (await band($, 'terminal')).findAll({ text: /Sin resumen/ })).length).toBe(0)
  expect(await run($, 'toggle')).toBe('Banda de resumen prendida.')
  expect((await (await band($, 'terminal')).findAll({ text: /Sin resumen/ })).length).toBeGreaterThan(0)
})

test('guardar va en la lista del prompt aunque el engine la difiera', async ($, on) => {
  bottoms(on)
  on('tool.describe', async ($, e) => ({ description: e.description, isDeferred: true }))
  await start($)
  const r = await $.tool.describe({ tool: TOOL, description: 'x', isDeferred: true, provider: { plugin: 'resumen', tier: 'user' } } as never)
  expect(r.isDeferred).toBe(false)
})

test('el resumen va arriba y la banda de los otros mods sigue debajo', async ($, on) => {
  bottoms(on)
  await start($)
  const ui = await band($, 'terminal')
  expect((await ui.findAll({ text: /Sin resumen/ })).length).toBeGreaterThan(0)
  expect((await ui.findAll({ text: /banda de abajo/ })).length).toBeGreaterThan(0)
  await run($, 'off')
  const sola = await band($, 'terminal')
  expect((await sola.findAll({ text: /Sin resumen/ })).length).toBe(0)
  expect((await sola.findAll({ text: /banda de abajo/ })).length).toBeGreaterThan(0)
})
