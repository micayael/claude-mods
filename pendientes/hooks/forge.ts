// El repo remoto del proyecto, en GitHub o GitLab, manejado con gh y glab
export type Forge = { kind: 'github' | 'gitlab'; repo: string }

export const CLI = { github: 'gh', gitlab: 'glab' } as const

// git@gitlab.com:dueño/repo.git, https://github.com/dueño/repo, ssh://git@gitlab.com:2222/dueño/repo.git
export function parseRemote(url: string): Forge | undefined {
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?(github\.com|gitlab\.com)(?::\d+(?=\/))?[:/](.+?)(?:\.git)?\/?$/.exec(url.trim())
  if (m === null) return undefined
  return { kind: m[1] === 'github.com' ? 'github' : 'gitlab', repo: m[2] }
}

// "/todo new <título>", o una lista con guiones, una por línea. En una sola línea siempre es
// un título, aunque tenga guiones ("Symfony 6.4 - 7.4").
export function parseTitles(args: string): string[] {
  const lines = args.split('\n').map(l => l.trim()).filter(Boolean)
  const listed = lines.filter(l => /^[-*] /.test(l))
  if (lines.length > 1 && listed.length > 0) return listed.map(l => l.slice(2).trim()).filter(Boolean)
  const one = lines.join(' ').replace(/^[-*] /, '')
  return one === '' ? [] : [one]
}

// Subtareas: el issue hijo lleva en su descripción una línea "Parte de #33"
const PARENT_LINE = /^[ \t]*Parte de #(\d+)[ \t]*$/im

export function parseParent(body: string | null | undefined): number | undefined {
  const m = PARENT_LINE.exec(body ?? '')
  return m === null ? undefined : Number(m[1])
}

// La descripción con (o sin, si parent es undefined) la línea del padre, al final
export function withParent(body: string | null | undefined, parent: number | undefined): string {
  const rest = (body ?? '')
    .split('\n')
    .filter(line => !PARENT_LINE.test(line))
    .join('\n')
    .trimEnd()
  if (parent === undefined) return rest
  return rest === '' ? `Parte de #${parent}` : `${rest}\n\nParte de #${parent}`
}

// El número de issue de una URL de la API de GitHub (parent_issue_url), solo si es de `repo`:
// GitHub permite padres en otro repo del mismo dueño, y ese número no es un issue de este
export function issueNumberFromUrl(url: string | null | undefined, repo: string): number | undefined {
  const m = /\/repos\/(.+)\/issues\/(\d+)$/.exec(url ?? '')
  return m === null || m[1].toLowerCase() !== repo.toLowerCase() ? undefined : Number(m[2])
}

// glab imprime el JSON de la respuesta y, si hubo error, texto después: se toma el primer objeto
export function firstJson(text: string): string {
  const start = text.indexOf('{')
  if (start === -1) return text
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1)
  }
  return text.slice(start)
}

// Corta un texto en filas de `width` columnas, por palabras (una palabra más larga que el ancho se
// parte). Así el panel sabe cuánto alto ocupa el resumen y lo dibuja fila por fila
export function wrapRows(text: string, width: number): string[] {
  const w = Math.max(1, Math.floor(width))
  const rows: string[] = []
  for (const line of text.split('\n')) {
    let row = ''
    for (const word of line.split(/\s+/).filter(Boolean)) {
      let rest = word
      while (rest.length > w) {
        if (row !== '') {
          rows.push(row)
          row = ''
        }
        rows.push(rest.slice(0, w))
        rest = rest.slice(w)
      }
      if (row === '') row = rest
      else if (row.length + 1 + rest.length <= w) row = `${row} ${rest}`
      else {
        rows.push(row)
        row = rest
      }
    }
    rows.push(row)
  }
  return rows
}
