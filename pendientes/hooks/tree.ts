import type { Task } from '../types'

// El orden del panel como árbol: cada tarea seguida de sus subtareas, con su profundidad.
// Arriba va lo que tiene algo en curso (ella o alguna subtarea), después lo pendiente y al final
// lo tildado. Un padre que no está en la lista (cerrado) o un ciclo dejan a la tarea como raíz.
export type Row = { task: Task; depth: number }

const MAX_DEPTH = 8
const RANK = { current: 0, pending: 1, done: 2 } as const

export function treeRows(list: readonly Task[]): Row[] {
  const byId = new Map(list.map(t => [t.id, t]))

  const hasCycle = (t: Task) => {
    const seen = new Set([t.id])
    for (let p = t.parent; p !== undefined; p = byId.get(p)?.parent) {
      if (seen.has(p)) return true
      seen.add(p)
    }
    return false
  }
  const parentOf = (t: Task) => (t.parent !== undefined && byId.has(t.parent) && !hasCycle(t) ? t.parent : undefined)

  const children = new Map<number, Task[]>()
  const roots: Task[] = []
  for (const t of list) {
    const p = parentOf(t)
    if (p === undefined) roots.push(t)
    else children.set(p, [...(children.get(p) ?? []), t])
  }

  // Una rama está "en curso" si la tarea o cualquier subtarea lo está
  const rankOf = (t: Task, depth = 0): number => {
    if (t.status === 'current' || depth > MAX_DEPTH) return RANK[t.status]
    return Math.min(RANK[t.status], ...(children.get(t.id) ?? []).map(c => (rankOf(c, depth + 1) === 0 ? 0 : 3)))
  }
  const sorted = (ts: readonly Task[]) =>
    [...ts].sort((a, b) => rankOf(a) - rankOf(b) || RANK[a.status] - RANK[b.status] || a.id - b.id)

  const rows: Row[] = []
  // Más allá de MAX_DEPTH se sigue mostrando todo, pero sin más sangría
  const walk = (t: Task, depth: number) => {
    rows.push({ task: t, depth })
    for (const c of sorted(children.get(t.id) ?? [])) walk(c, Math.min(depth + 1, MAX_DEPTH))
  }
  for (const r of sorted(roots)) walk(r, 0)
  return rows
}

// El padre y todos sus ancestros abiertos, para no armar ciclos al enganchar
export function ancestors(list: readonly Task[], id: number): number[] {
  const byId = new Map(list.map(t => [t.id, t]))
  const out: number[] = []
  for (let p = byId.get(id)?.parent; p !== undefined && !out.includes(p); p = byId.get(p)?.parent) out.push(p)
  return out
}
