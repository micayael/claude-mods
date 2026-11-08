import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const band = ($: Engine, surface: 'terminal' | 'desktop') =>
  $.ui.mount({ plugin: 'separador', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false } as never })

for (const surface of ['terminal', 'desktop'] as const) {
  test(`pone la línea arriba de lo que hay (${surface})`, async ($, on) => {
    on('ui.render', async ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>clima</Text>
    })
    const ui = await band($, surface)
    // En escritorio la app ya pone la banda en una tarjeta: no hay línea
    if (surface === 'terminal') expect((await ui.findAll({ text: /─{10}/ })).length).toBeGreaterThan(0)
    else expect((await ui.findAll({ text: /─/ })).length).toBe(0)
    expect((await ui.findAll({ text: /clima/ })).length).toBeGreaterThan(0)
  })

  test(`sin nada abajo no dibuja la línea (${surface})`, async ($, on) => {
    on('ui.render', async ($, e) => {
      const { Box } = $.ui.resolve(e)
      return <Box />
    })
    const ui = await band($, surface)
    expect((await ui.findAll({ text: /─/ })).length).toBe(0)
  })
}
