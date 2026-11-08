import type { Register } from 'claude-code'

// Nada que mostrar: sin árbol, o cajas sin texto adentro
function vacio(el: unknown): boolean {
  if (el === null || el === undefined || el === false || el === '') return true
  if (typeof el !== 'object') return false
  if (Array.isArray(el)) return el.every(vacio)
  const { type, children } = el as { type?: string; children?: unknown }
  return type === 'Box' && (children === undefined || vacio(children))
}

export const register: Register = on => {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Lo que dibujan los mods de abajo (token-weather, por ejemplo); si no dibujan nada, no hay línea
    const debajo = await next(e)
    if (vacio(debajo)) return debajo
    // Fuera de la terminal la app ya dibuja la banda dentro de una tarjeta: la línea sobra
    if (e.surface !== 'terminal') return debajo
    const { Box, Text } = $.ui.resolve(e)
    const props = e.props as { bodyColumns?: number }
    const ancho = Math.max(10, props.bodyColumns ?? (e as { bodyColumns?: number }).bodyColumns ?? 80)
    return (
      <Box flexDirection="column">
        <Text dimColor wrap="truncate-end">{'─'.repeat(ancho)}</Text>
        {debajo}
      </Box>
    )
  })
}
