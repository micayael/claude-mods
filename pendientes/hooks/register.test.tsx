import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { firstJson, issueNumberFromUrl, parseParent, parseRemote, parseTitles, withParent, wrapRows } from './forge'
import { treeRows } from './tree'
import type { Task } from '../types'

const TOOL = 'mcp__pendientes__pendientes'
const CLOSE = 'Close on push'

type FakeIssue = { id: number; title: string; body: string; labels: string[]; isOpen: boolean; nativeParent?: number; isTask?: boolean }

// El mundo detrás de process.run: git (remoto y rama principal) y un GitLab o GitHub de mentira
type World = {
  issues: FakeIssue[]
  calls: string[][]
  tip: string // dónde está origin/master
  reflog: { sha: string; message: string }[] // quién lo movió, lo más nuevo primero
  failReads: boolean
  failWrites: boolean
  failClose: boolean // solo el cierre falla (GitHub PATCH)
  noNative: boolean // sin sub-issues (GitHub) ni GraphQL (GitLab)
  gqlPageSize: number // GitLab: de a cuántos devuelve workItems (para probar la paginación)
  mutationErrors: string[] // GitLab: errores dentro del payload, con glab terminando bien
  subIssueRejects: boolean // GitHub: 422 al enganchar (límite de 100 hijos, 8 niveles)
}

const result = (exitCode: number, stdout: string, stderr = '') =>
  ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } }) as never
const json = (value: unknown) => result(0, JSON.stringify(value))

function fakeWorld(on: On, kind: 'gitlab' | 'github', issues: FakeIssue[] = []): World {
  const w: World = { issues, calls: [], tip: 'aaa', reflog: [{ sha: 'aaa', message: 'update by push' }], failReads: false, failWrites: false, failClose: false, noNative: false, gqlPageSize: 100, mutationErrors: [], subIssueRejects: false }
  let next = Math.max(40, ...issues.map(i => i.id))

  on('process.run', async ($, e) => {
    const argv = [...e.argv]
    w.calls.push(argv)
    const line = argv.join(' ')
    if (line === 'git remote get-url origin') {
      return result(0, kind === 'gitlab' ? 'git@gitlab.com:micayael/drvale.git\n' : 'git@github.com:micayael/demo.git\n')
    }
    if (line === 'git symbolic-ref --short refs/remotes/origin/HEAD') return result(0, 'origin/master\n')
    if (line === 'git rev-parse origin/master') return result(0, `${w.tip}\n`)
    if (line === 'git reflog show --format=%H%x09%gs -n 50 refs/remotes/origin/master') {
      return result(0, w.reflog.map(r => `${r.sha}\t${r.message}`).join('\n') + '\n')
    }
    if (argv[0] !== (kind === 'gitlab' ? 'glab' : 'gh') || argv[1] !== 'api') return result(1, '', 'comando inesperado')

    const method = argv.includes('-X') ? argv[argv.indexOf('-X') + 1] : 'GET'
    const isValue = (i: number) => ['-X', '-f', '-F'].includes(argv[i - 1])
    const path = argv.slice(2).find((a, i) => !a.startsWith('-') && !isValue(i + 2))!
    const fields: Record<string, string> = {}
    argv.forEach((a, i) => {
      if (argv[i - 1] === '-f' || argv[i - 1] === '-F') fields[a.slice(0, a.indexOf('='))] = a.slice(a.indexOf('=') + 1)
    })
    const uidOf = (i: FakeIssue) => 1000 + i.id

    if (kind === 'gitlab' && path === 'graphql') {
      if (w.noNative) return result(1, '{"errors":[{"message":"graphql caído"}]}', 'glab: graphql error')
      const q = fields.query
      const gid = (n: number) => `gid://gitlab/WorkItem/${n}`
      const fromGid = (g: string) => Number(g.slice(g.lastIndexOf('/') + 1))
      if (q.includes('workItems(state: opened')) {
        const open = w.issues.filter(i => i.isOpen)
        const from = fields.after === undefined ? 0 : Number(fields.after)
        const page = open.slice(from, from + w.gqlPageSize)
        const nodes = page.map(i => ({
          id: gid(i.id),
          iid: String(i.id),
          workItemType: { name: i.isTask ? 'Task' : 'Issue' },
          widgets: [{}, { parent: i.nativeParent ? { iid: String(i.nativeParent), workItemType: { name: w.issues.find(x => x.id === i.nativeParent)?.isTask ? 'Task' : i.nativeParent > 900 ? 'Epic' : 'Issue' } } : null }],
        }))
        const end = from + page.length
        return json({ data: { project: { workItems: { pageInfo: { hasNextPage: end < open.length, endCursor: String(end) }, nodes } } } })
      }
      if (q.includes('workItemTypes(name: TASK)')) {
        const iids = (/iids: \[([^\]]*)\]/.exec(q)?.[1] ?? '').match(/\d+/g)?.map(Number) ?? []
        const nodes = w.issues
          .filter(i => iids.includes(i.id))
          .map(i => ({ id: gid(i.id), iid: String(i.id), workItemType: { name: i.isTask ? 'Task' : 'Issue' } }))
        return json({ data: { project: { workItemTypes: { nodes: [{ id: 'gid://gitlab/WorkItems::Type/5' }] }, workItems: { nodes } } } })
      }
      if (w.mutationErrors.length > 0 && q.startsWith('mutation')) {
        const name = q.includes('workItemCreate') ? 'workItemCreate' : 'workItemUpdate'
        return json({ data: { [name]: { workItem: null, errors: w.mutationErrors } } })
      }
      if (q.includes('workItemCreate')) {
        const issue: FakeIssue = { id: ++next, title: fields.title, body: fields.body ?? '', labels: [], isOpen: true, isTask: true, nativeParent: fromGid(fields.parent) }
        w.issues.push(issue)
        return json({ data: { workItemCreate: { workItem: { iid: String(issue.id) }, errors: [] } } })
      }
      if (q.includes('workItemUpdate')) {
        const one = w.issues.find(i => gid(i.id) === fields.id)!
        one.nativeParent = q.includes('parentId: null') ? undefined : fromGid(fields.parent)
        return json({ data: { workItemUpdate: { errors: [] } } })
      }
      return result(1, '', 'query inesperada')
    }
    if (method === 'GET' && w.failReads) return result(1, '', 'dial tcp: no route to host')
    if (method !== 'GET' && w.failWrites) return result(1, '', '403 Forbidden')

    const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? 1)
    const byId = (m: RegExpExecArray | null) => w.issues.find(i => i.id === Number(m?.[1]))
    const has = (i: FakeIssue, name: string) => i.labels.some(l => l.toLowerCase() === name.toLowerCase())

    if (kind === 'gitlab') {
      if (method === 'GET' && /\/issues\?state=opened/.test(path)) {
        const open = w.issues.filter(i => i.isOpen).slice((page - 1) * 100, page * 100)
        return json(open.map(i => ({ iid: i.id, title: i.title, labels: i.labels, state: 'opened', description: i.body, issue_type: i.isTask ? 'task' : 'issue' })))
      }
      if (method === 'POST' && /\/issues$/.test(path)) {
        const issue = { id: ++next, title: fields.title, body: fields.description, labels: [], isOpen: true }
        w.issues.push(issue)
        return json({ iid: issue.id })
      }
      const one = byId(/\/issues\/(\d+)$/.exec(path))
      if (!one) return result(1, '', '404 Not Found')
      if (method === 'GET') {
        return json({ iid: one.id, title: one.title, labels: one.labels, state: one.isOpen ? 'opened' : 'closed', description: one.body, issue_type: one.isTask ? 'task' : 'issue' })
      }
      if (method === 'PUT') {
        if (fields.add_labels) one.labels.push(...fields.add_labels.split(',').filter(l => !has(one, l)))
        if (fields.remove_labels) one.labels = one.labels.filter(l => !fields.remove_labels.split(',').includes(l))
        if (fields.state_event) one.isOpen = fields.state_event === 'reopen'
        if (fields.description !== undefined) one.body = fields.description
        return json({ iid: one.id })
      }
      return result(1, '', '405')
    }

    if (method === 'GET' && /\/issues\?state=open/.test(path)) {
      const open = w.issues.filter(i => i.isOpen)
      const rows = [
        ...open.map(i => ({
          id: uidOf(i),
          number: i.id,
          title: i.title,
          state: 'open',
          body: i.body,
          labels: i.labels.map(name => ({ name })),
          parent_issue_url: i.nativeParent ? `https://api.github.com/repos/micayael/demo/issues/${i.nativeParent}` : null,
        })),
        { number: 999, title: 'un PR', state: 'open', labels: [], pull_request: {} },
      ]
      return json(rows.slice((page - 1) * 100, page * 100))
    }
    if (method === 'POST' && /\/labels$/.test(path) && !/\/issues\//.test(path)) return result(1, '', '422 already_exists')
    if (method === 'POST' && /\/issues$/.test(path)) {
      const issue = { id: ++next, title: fields.title, body: fields.body, labels: [], isOpen: true }
      w.issues.push(issue)
      return json({ number: issue.id, id: uidOf(issue) })
    }
    const parentOf = byId(/\/issues\/(\d+)\/sub_issues?$/.exec(path))
    if (parentOf) {
      if (w.noNative) return result(1, '', '404 Not Found')
      if (w.subIssueRejects && method === 'POST') return result(1, '', '422 Validation Failed')
      // El id interno va tipado (-F), como número: con -f GitHub lo rechaza
      const flag = argv[argv.findIndex(a => a.startsWith('sub_issue_id=')) - 1]
      if (flag !== '-F') return result(1, '', '422 sub_issue_id must be an integer')
      const child = w.issues.find(i => uidOf(i) === Number(fields.sub_issue_id))!
      child.nativeParent = method === 'POST' ? parentOf.id : undefined
      return json({})
    }
    const labelled = byId(/\/issues\/(\d+)\/labels/.exec(path))
    if (method === 'POST' && labelled) {
      // GitHub reusa una etiqueta existente aunque difiera en mayúsculas
      if (!has(labelled, fields['labels[]'])) labelled.labels.push(fields['labels[]'])
      return json([])
    }
    if (method === 'DELETE' && labelled) {
      const name = decodeURIComponent(path.slice(path.lastIndexOf('/') + 1))
      if (!has(labelled, name)) return result(1, '', '404 Label does not exist')
      labelled.labels = labelled.labels.filter(l => l.toLowerCase() !== name.toLowerCase())
      return json([])
    }
    const one = byId(/\/issues\/(\d+)$/.exec(path))
    if (!one) return result(1, '', '404 Not Found')
    if (method === 'GET') {
      return json({
        id: uidOf(one),
        number: one.id,
        title: one.title,
        state: one.isOpen ? 'open' : 'closed',
        body: one.body,
        labels: one.labels.map(name => ({ name })),
        parent_issue_url: one.nativeParent ? `https://api.github.com/repos/micayael/demo/issues/${one.nativeParent}` : null,
      })
    }
    if (method === 'PATCH') {
      if (fields.body !== undefined) one.body = fields.body
      if (fields.state !== undefined) {
        if (w.failClose) return result(1, '', '502 Bad Gateway')
        one.isOpen = fields.state === 'open'
      }
      return json({ number: one.id })
    }
    return result(1, '', '405')
  })
  return w
}

// Lo que en una sesión responde el engine
function bottoms(on: On, panes: Map<string, boolean> = new Map()) {
  mock.store(on)
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('session.root', async () => ({ value: '/proyecto' }))
  on('command.register', async () => ({ value: { command: 'todo' } }))
  on('tool.register', async () => ({ value: { tool: TOOL } }))
  on('ui.open', async ($, e) => (panes.set(e.id, true), { value: { isPlaced: true } }) as never)
  on('ui.close', async ($, e) => (panes.delete(e.id), { value: undefined }) as never)
  on('ui.panes', async () => ({
    value: [...panes].map(([id, isPlaced]) => ({ id, title: id, isShown: isPlaced, isFocused: false, isPlaced })),
  }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  return panes
}

// Un Bash de mentira: lo que hace el comando con la rama principal del remoto
// moves: qué movió origin/master durante el comando, en orden (un pull y después un push, por ejemplo)
type Move = 'push' | 'fetch'
function fakeBash(on: On, w: World, effect: (command: string) => { isError?: boolean; moves?: readonly Move[] }) {
  on('tool.call', { tool: 'Bash' }, async ($, e) => {
    const { isError, moves = [] } = effect(String((e as { command?: string }).command))
    for (const move of moves) {
      w.tip = `${w.tip}+`
      w.reflog.unshift({ sha: w.tip, message: move === 'push' ? 'update by push' : 'pull: fast-forward' })
    }
    return (isError ? { result: 'error', isError: true } : { result: { stdout: '', stderr: '', interrupted: false } }) as never
  })
}

const issue = (id: number, title: string, labels: string[] = [], isOpen = true, body = ''): FakeIssue => ({ id, title, body, labels, isOpen })
const run = async ($: Engine, args: string) => String((await $.command.run({ command: 'todo', args } as never)).text)
const tool = async ($: Engine, input: Record<string, unknown>) =>
  String(((await $.tool.call({ tool: TOOL, tool_use_id: `t${Math.random()}`, ...input } as never)) as { result?: unknown }).result)
const start = ($: Engine) => $.session.start({ cwd: '/proyecto' } as never)
const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', tool_use_id: `b${Math.random()}`, command } as never)
const settle = async (until: () => boolean) => {
  for (let i = 0; i < 60 && !until(); i++) await new Promise(r => setTimeout(r, 5))
}
const idle = () => new Promise(r => setTimeout(r, 60))

// --- Funciones puras ---

test('reconoce remotos de GitHub y GitLab', async () => {
  expect(parseRemote('git@gitlab.com:micayael/drvale.git')).toEqual({ kind: 'gitlab', repo: 'micayael/drvale' })
  expect(parseRemote('https://github.com/dueño/repo')).toEqual({ kind: 'github', repo: 'dueño/repo' })
  expect(parseRemote('ssh://git@github.com/a/b.git')).toEqual({ kind: 'github', repo: 'a/b' })
  expect(parseRemote('ssh://git@gitlab.com:2222/a/b.git')).toEqual({ kind: 'gitlab', repo: 'a/b' })
  expect(parseRemote('git@gitlab.com:grupo/sub/repo.git')).toEqual({ kind: 'gitlab', repo: 'grupo/sub/repo' })
  expect(parseRemote('git@bitbucket.org:a/b.git')).toBe(undefined)
})

test('parseTitles: una línea es un título; la lista va una por línea', async () => {
  expect(parseTitles('Revisar el deploy')).toEqual(['Revisar el deploy'])
  expect(parseTitles('- Symfony 6.4 - 7.4')).toEqual(['Symfony 6.4 - 7.4'])
  expect(parseTitles('\n- uno\n- dos\n* tres')).toEqual(['uno', 'dos', 'tres'])
  expect(parseTitles('')).toEqual([])
})

// --- Lista y creación ---

test('la lista son los issues abiertos, con su estado según las etiquetas', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  fakeWorld(on, 'gitlab', [issue(12, 'Viejo'), issue(32, 'Agendas', ['In Process']), issue(33, 'Hecho', ['Testing']), issue(5, 'Cerrado', [], false)])
  await start($)
  expect(await tool($, { action: 'list' })).toBe('#32 [>] Agendas\n#12 [ ] Viejo\n#33 [x] Hecho')
})

test('lee más de 100 issues (paginado)', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  fakeWorld(on, 'gitlab', Array.from({ length: 150 }, (_, i) => issue(i + 1, `t${i + 1}`)))
  await start($)
  expect((await tool($, { action: 'list' })).split('\n').length).toBe(150)
})

test('new crea uno o varios issues y abre el panel', async ($, on) => {
  const panes = bottoms(on)
  mock.clock(on)
  const w = fakeWorld(on, 'gitlab')
  await start($)
  expect(panes.has('pendientes')).toBe(false)

  expect(await run($, 'new Revisar el deploy')).toContain('Creado: #41.')
  expect(await run($, 'new\n- uno\n- dos')).toContain('Creados: #42, #43.')
  expect(w.issues.map(i => i.title)).toEqual(['Revisar el deploy', 'uno', 'dos'])
  expect(panes.has('pendientes')).toBe(true)
})

// --- Estados ---

test('start: varias en curso a la vez; undo saca una', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  const w = fakeWorld(on, 'gitlab', [issue(1, 'a', ['In Process']), issue(2, 'b', ['Testing', CLOSE]), issue(3, 'c')])
  await start($)

  expect(await run($, 'start 2 3')).toContain('#2 en curso. #3 en curso.')
  expect(w.issues.map(i => i.labels)).toEqual([['In Process'], ['In Process'], ['In Process']])
  expect(await run($, 'start 1')).toContain('#1 ya estaba en curso.')
  expect(await run($, 'status')).toContain('En curso: #1 a\nEn curso: #2 b\nEn curso: #3 c')
  await run($, 'undo 1')
  expect(w.issues[0].labels).toEqual([])
})

test('done pone la etiqueta de hecho y la marca de cierre, y no cierra', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  const w = fakeWorld(on, 'gitlab', [issue(1, 'a', ['In Process']), issue(2, 'b')])
  await start($)

  expect(await run($, 'done 1 #2')).toContain('#1 tildado; se cierra con el próximo push a master.')
  expect(w.issues.map(i => [i.labels, i.isOpen])).toEqual([
    [['Testing', CLOSE], true],
    [['Testing', CLOSE], true],
  ])
  expect(await run($, 'status')).toContain('Se cierran con el próximo push a master: #1, #2')
})

test('done sobre algo que ya tenía "Testing" a mano le agrega la marca', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  const w = fakeWorld(on, 'gitlab', [issue(1, 'a', ['Testing']), issue(2, 'b', ['Testing'])])
  await start($)
  expect(await run($, 'status')).toContain('Con "Testing" puesta a mano (no se cierran solos): #1, #2')

  await run($, 'done 1')
  expect(w.issues[0].labels).toEqual(['Testing', CLOSE])
  expect(await run($, 'sync')).toBe('Cerrados: #1.')
  expect(w.issues.map(i => i.isOpen)).toEqual([false, true])
})

// --- Cierre con el push ---

test('un push que mueve la rama principal cierra los marcados', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  const w = fakeWorld(on, 'gitlab', [issue(1, 'a'), issue(2, 'b', ['Testing'])])
  fakeBash(on, w, () => ({ moves: ['push'] }))
  await start($)
  await run($, 'done 1')

  await bash($, 'git push origin master')
  await settle(() => !w.issues[0].isOpen)
  expect(w.issues.map(i => [i.isOpen, i.labels])).toEqual([
    [false, ['Testing']],
    [true, ['Testing']], // puesto a mano, sin marca: no se toca
  ])
})

for (const [name, command, effect] of [
  ['git stash push', 'git stash push -m "prueba"', {}],
  ['git push --dry-run', 'git push --dry-run', {}],
  ['un push que falla', 'git push', { isError: true }],
  ['un push de otra rama', 'git push origin feature/x', {}],
  ['un push en segundo plano (todavía no movió nada)', 'git push', {}],
  ['un commit que menciona push', 'git commit -m "antes del push"', {}],
  ['un pull que trae cambios y un push sin nada que subir', 'git pull && git push', { moves: ['fetch'] }],
  ['un fetch y un push de otra rama', 'git fetch && git push origin feature/x', { moves: ['fetch'] }],
] as const) {
  test(`no cierra con ${name}`, async ($, on) => {
    bottoms(on)
    mock.clock(on)
    const w = fakeWorld(on, 'gitlab', [issue(1, 'a')])
    fakeBash(on, w, () => effect)
    await start($)
    await run($, 'done 1')

    await bash($, command)
    await idle()
    expect(w.issues[0].isOpen).toBe(true)
  })
}

test('sync cierra los marcados, pero no los que perdieron "Testing" desde la web', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  const w = fakeWorld(on, 'gitlab', [issue(1, 'a'), issue(2, 'b')])
  await start($)
  await run($, 'done 1 2')
  w.issues[1].labels = [CLOSE] // alguien le sacó "Testing" desde la web

  expect(await run($, 'sync')).toBe('Cerrados: #1.')
  expect(w.issues.map(i => i.isOpen)).toEqual([false, true])
  expect(await run($, 'sync')).toBe('No hay tildados esperando cierre.')
})

test('sin red no cierra ni pierde las marcas; cierra cuando vuelve', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  const w = fakeWorld(on, 'gitlab', [issue(1, 'a')])
  await start($)
  await run($, 'done 1')

  w.failReads = true
  expect(await run($, 'sync')).toContain('No pude leer los issues de micayael/drvale: dial tcp: no route to host No cambié nada.')
  expect(await run($, 'done 1')).toContain('No cambié nada.')
  w.failReads = false
  expect(await run($, 'sync')).toBe('Cerrados: #1.')
})

// --- undo y remove ---

test('undo reabre lo que cerró el mod, pero no cualquier issue cerrado', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  const w = fakeWorld(on, 'gitlab', [issue(1, 'a', ['Testing']), issue(2, 'b', ['Testing', CLOSE], false), issue(7, 'viejo', [], false)])
  await start($)

  expect(await run($, 'undo 1 2 7')).toBe(
    '#1 vuelve a pendiente. #2 reabierto. #7 está cerrado pero no lo cerró este mod; si querés, reabrilo desde la web.\n\n#1 [ ] a\n#2 [ ] b',
  )
  expect(w.issues.map(i => [i.labels, i.isOpen])).toEqual([
    [[], true],
    [[], true],
    [[], false],
  ])
})

test('remove saca las etiquetas y cierra sin completar', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  const w = fakeWorld(on, 'gitlab', [issue(1, 'a', ['In Process'])])
  await start($)

  expect(await run($, 'remove 1')).toContain('#1 cerrado sin completar.')
  expect(w.issues[0]).toEqual({ id: 1, title: 'a', body: '', labels: [], isOpen: false })
})

// --- Configuración, errores, concurrencia ---

test('las etiquetas salen de la configuración', { options: { currentLabel: 'Doing', doneLabel: 'Hecho', closeLabel: 'auto' } }, async ($, on) => {
  bottoms(on)
  mock.clock(on)
  const w = fakeWorld(on, 'gitlab', [issue(1, 'a')])
  await start($)
  await run($, 'start 1')
  expect(w.issues[0].labels).toEqual(['Doing'])
  await run($, 'done 1')
  expect(w.issues[0].labels).toEqual(['Hecho', 'auto'])
})

test('errores de la API se muestran, no se tragan', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  const w = fakeWorld(on, 'gitlab', [issue(1, 'a')])
  await start($)
  w.failWrites = true

  expect(await run($, 'done 1')).toContain('#1: 403 Forbidden')
  expect(await run($, 'new algo')).toContain('No pude crear "algo": 403 Forbidden')
})

test('sin remoto en GitHub/GitLab lo avisa', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  on('process.run', async () => result(2, '', 'no remote'))
  await start($)
  expect(await run($, 'new algo')).toBe('Este proyecto no tiene un remoto origin en GitHub o GitLab.')
  expect(await run($, 'done 1')).toBe('Este proyecto no tiene un remoto origin en GitHub o GitLab.')
  expect(await run($, 'status')).toBe('Este proyecto no tiene un remoto origin en GitHub o GitLab.')
})

test('operaciones en paralelo van en fila y no se pisan', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  const w = fakeWorld(on, 'gitlab', [issue(1, 'a'), issue(2, 'b'), issue(3, 'c')])
  await start($)
  await Promise.all([run($, 'start 1'), run($, 'done 1'), run($, 'start 2'), run($, 'done 3'), run($, 'undo 2')])
  expect(w.issues.map(i => i.labels)).toEqual([['Testing', CLOSE], [], ['Testing', CLOSE]])
})

test('títulos que empiezan con - o @ o tienen = viajan tal cual', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  const w = fakeWorld(on, 'gitlab')
  await start($)
  await run($, 'new -X DELETE')
  await tool($, { action: 'add', text: '@/etc/passwd', description: 'a=b' })
  expect(w.issues.map(i => [i.title, i.body])).toEqual([
    ['-X DELETE', ''],
    ['@/etc/passwd', 'a=b'],
  ])
})

// --- GitHub ---

test('GitHub: sin PRs, etiquetas sin distinguir mayúsculas, cierre con PATCH', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  const w = fakeWorld(on, 'github', [issue(7, 'gh', ['testing'])])
  await start($)

  expect(await tool($, { action: 'list' })).toBe('#7 [x] gh')
  await run($, 'start 7')
  expect(w.issues[0].labels).toEqual(['In Process'])
  await run($, 'done 7')
  expect(w.issues[0].labels).toEqual(['Testing', CLOSE])
  expect(await run($, 'sync')).toBe('Cerrados: #7.')
  expect(w.issues[0]).toEqual({ id: 7, title: 'gh', body: '', labels: ['Testing'], isOpen: false })
  expect(w.calls.some(c => c.includes('repos/micayael/demo/issues/7') && c.includes('state=closed'))).toBe(true)
  expect(await tool($, { action: 'add', text: 'nuevo', description: 'detalle' })).toContain('Creado: #41.')
})

// --- Panel ---

test('/todo alterna el panel; uno que quedó sin dibujarse cuenta como cerrado', async ($, on) => {
  const panes = bottoms(on)
  mock.clock(on)
  fakeWorld(on, 'gitlab')
  await start($)

  panes.set('pendientes', false) // abierto solo al iniciar, esperando ancho
  expect(await run($, '')).toBe('Panel de pendientes abierto.')
  expect(await run($, '')).toBe('Panel de pendientes cerrado.')
  expect(await run($, '')).toBe('Panel de pendientes abierto.')
  expect(await run($, 'close')).toBe('Panel de pendientes cerrado.')
})

for (const [surface, placement] of [
  ['terminal', 'inline'],
  ['terminal', 'dock'],
  ['desktop', 'dock'],
] as const) {
  test(`panel ${surface}/${placement}`, async ($, on) => {
    bottoms(on)
    mock.clock(on)
    fakeWorld(on, 'gitlab', [issue(1, 'Pendiente'), issue(2, 'En curso', ['In Process']), issue(3, 'Hecha', ['Testing'])])
    await start($)
    await tool($, { action: 'list' })

    const ui = await $.ui.mount({
      plugin: 'pendientes',
      surface,
      component: 'Pane',
      requestId: 'pendientes',
      props: { title: 'Pendientes', placement } as never,
      viewport: { columns: 60, rows: 30 } as never,
    })
    expect((await ui.findAll({ text: /▶ #2 En curso/ })).length).toBeGreaterThan(0)
    expect((await ui.findAll({ text: /○ #1 Pendiente/ })).length).toBeGreaterThan(0)
    expect((await ui.findAll({ text: /2 pendientes · 1 tildada/ })).length).toBeGreaterThan(0)
    expect((await ui.findAll({ text: /#3 Hecha/ })).length > 0).toBe(placement === 'dock')
  })
}

test('el refresco periódico trae lo que cambió desde la web', async ($, on) => {
  bottoms(on)
  const clock = mock.clock(on)
  const w = fakeWorld(on, 'gitlab', [issue(1, 'a')])
  await start($)
  await idle()
  w.issues.push(issue(2, 'desde la web'))
  await clock.advance(2 * 60 * 1000)
  await idle()

  const ui = await $.ui.mount({
    plugin: 'pendientes',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'pendientes',
    props: { title: 'Pendientes', placement: 'dock' } as never,
    viewport: { columns: 60, rows: 30 } as never,
  })
  expect((await ui.findAll({ text: /#2 desde la web/ })).length).toBeGreaterThan(0)
})

test('comando desconocido muestra la ayuda', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  fakeWorld(on, 'gitlab')
  await start($)
  const out = await run($, 'hecho 2')
  expect(out).toContain('No entendí')
  expect(out).toContain('/todo new <título>')
})

test('refresh relee los issues: lo cerrado desde la web desaparece', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  const w = fakeWorld(on, 'gitlab', [issue(1, 'a'), issue(2, 'b', ['Testing'])])
  await start($)
  w.issues[0].isOpen = false // cerrado desde la web

  expect(await run($, 'refresh')).toBe('Lista actualizada: 1 issue abierto (0 sin tildar).')
  expect(await tool($, { action: 'list' })).toBe('#2 [x] b')

  w.failReads = true
  expect(await run($, 'refresh')).toContain('No pude leer los issues')
})

test('pull y después un push real: cierra', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  const w = fakeWorld(on, 'gitlab', [issue(1, 'a')])
  fakeBash(on, w, () => ({ moves: ['fetch', 'push'] }))
  await start($)
  await run($, 'done 1')
  await bash($, 'git pull --rebase && git push')
  await settle(() => !w.issues[0].isOpen)
  expect(w.issues[0].isOpen).toBe(false)
})

test('GitLab: el cierre por push saca la marca en la misma llamada', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  const w = fakeWorld(on, 'gitlab', [issue(1, 'a')])
  await start($)
  await run($, 'done 1')
  const before = w.calls.length
  await run($, 'sync')
  const writes = w.calls.slice(before).filter(c => c.includes('-X'))
  expect(writes.length).toBe(1)
  expect(writes[0]).toContain('state_event=close')
  expect(writes[0]).toContain(`remove_labels=${CLOSE}`)
})

test('GitHub: saca la marca antes de cerrar; si el cierre falla queda abierto sin marca', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  const w = fakeWorld(on, 'github', [issue(1, 'a')])
  await start($)
  await run($, 'done 1')
  w.failClose = true // el cierre falla, pero sacar la etiqueta anda
  expect(await run($, 'sync')).toBe('No pude cerrar #1: 502 Bad Gateway')
  expect(w.issues[0]).toEqual({ id: 1, title: 'a', body: '', labels: ['Testing'], isOpen: true })
})

test('start saca una marca de cierre suelta', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  const w = fakeWorld(on, 'gitlab', [issue(1, 'a', [CLOSE])])
  await start($)
  await run($, 'start 1')
  expect(w.issues[0].labels).toEqual(['In Process'])
})

test('undo no reabre lo cerrado a mano con "Testing" pero sin la marca', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  const w = fakeWorld(on, 'gitlab', [issue(5, 'cerrado desde el tablero', ['Testing'], false)])
  await start($)
  expect(await run($, 'undo 5')).toContain('#5 está cerrado pero no lo cerró este mod')
  expect(w.issues[0].isOpen).toBe(false)
})

test('GitHub: remove cierra como not planned; la etiqueta se crea una sola vez', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  const w = fakeWorld(on, 'github', [issue(1, 'a'), issue(2, 'b')])
  await start($)
  await run($, 'start 1 2')
  expect(w.calls.filter(c => c.includes('repos/micayael/demo/labels')).length).toBe(1)
  await run($, 'remove 1')
  expect(w.calls.some(c => c.includes('repos/micayael/demo/issues/1') && c.includes('state_reason=not_planned'))).toBe(true)
})

test('etiquetas con otra mayúscula se sacan con el nombre que tiene el issue', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  const w = fakeWorld(on, 'gitlab', [issue(1, 'a', ['testing', 'close on push'])])
  await start($)
  await run($, 'undo 1')
  expect(w.issues[0].labels).toEqual([])
})

// --- Subtareas (árbol) ---

test('parseParent / withParent', async () => {
  expect(parseParent('algo\n\nParte de #33')).toBe(33)
  expect(parseParent('  parte de #7  ')).toBe(7)
  expect(parseParent('Relacionado con #32.')).toBe(undefined)
  expect(withParent('detalle', 33)).toBe('detalle\n\nParte de #33')
  expect(withParent('', 33)).toBe('Parte de #33')
  expect(withParent('detalle\n\nParte de #33', 40)).toBe('detalle\n\nParte de #40')
  expect(withParent('detalle\n\nParte de #33\n', undefined)).toBe('detalle')
})

const task = (id: number, status: Task['status'], parent?: number): Task => ({ id, title: `t${id}`, status, willClose: false, labels: [], parent })
const shape = (list: Task[]) => treeRows(list).map(r => `${'  '.repeat(r.depth)}${r.task.id}`)

test('treeRows: subtareas debajo; arriba lo que tiene algo en curso', async () => {
  expect(
    shape([task(34, 'pending'), task(33, 'pending'), task(47, 'current', 33), task(48, 'pending', 33), task(49, 'done', 33), task(50, 'pending', 47)]),
  ).toEqual(['33', '  47', '    50', '  48', '  49', '34'])
})

test('treeRows: padre cerrado o ciclo dejan a la tarea como raíz', async () => {
  expect(shape([task(2, 'pending', 99), task(3, 'pending', 4), task(4, 'pending', 3)])).toEqual(['2', '3', '4'])
})

test('new --parent crea subtareas; link y unlink cambian la línea "Parte de"', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  const w = fakeWorld(on, 'gitlab', [issue(33, 'Terminar agenda', ['In Process']), issue(34, 'Pie', [], true, 'detalle del pie')])
  await start($)

  expect(await run($, 'new --parent 33\n- Fecha de corte\n- Reasignar citas')).toContain('Creados: #41, #42 (parte de #33).')
  // #33 es un Issue: las nuevas son Tasks hijas nativas, sin línea de texto
  expect(w.issues.find(i => i.id === 41)).toMatchObject({ isTask: true, nativeParent: 33, body: '' })

  const out = await run($, 'link 34 33')
  expect(out).toContain('#34 ahora es parte de #33 (por texto).')
  expect(w.issues.find(i => i.id === 34)!.body).toBe('detalle del pie\n\nParte de #33')
  expect(out).toContain('#33 [>] Terminar agenda\n  #34 [ ] Pie\n  #41 [ ] Fecha de corte\n  #42 [ ] Reasignar citas')

  expect(await run($, 'link 33 41')).toContain('#33 no puede ser parte de #41: quedaría en círculo.')
  expect(await run($, 'unlink 34')).toContain('#34 ya no es parte de ninguna.')
  expect(w.issues.find(i => i.id === 34)!.body).toBe('detalle del pie')
  expect(await run($, 'link 34 999')).toBe('#999 no existe en micayael/drvale. No cambié nada.')
})

test('la herramienta crea y engancha subtareas (GitHub)', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  const w = fakeWorld(on, 'github', [issue(10, 'Grande'), issue(11, 'Suelta')])
  await start($)
  expect(await tool($, { action: 'add', text: 'Parte uno', description: 'algo', parent: 10 })).toContain('Creado: #41 (parte de #10).')
  expect(w.issues.find(i => i.id === 41)).toMatchObject({ nativeParent: 10, body: 'algo' })
  expect(await tool($, { action: 'link', id: 11, parent: 10 })).toContain('#11 ahora es parte de #10.')
  expect(await tool($, { action: 'list' })).toBe('#10 [ ] Grande\n  #11 [ ] Suelta\n  #41 [ ] Parte uno')
  expect(await tool($, { action: 'link', id: 11 })).toBe('Falta el número de la tarea grande (parent).')
})

test('panel: las subtareas se dibujan con sangría debajo de su tarea', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  fakeWorld(on, 'gitlab', [issue(33, 'Grande'), issue(47, 'Hija', ['In Process'], true, 'Parte de #33'), issue(34, 'Otra')])
  await start($)
  await tool($, { action: 'list' })
  const ui = await $.ui.mount({
    plugin: 'pendientes',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'pendientes',
    props: { title: 'Pendientes', placement: 'dock' } as never,
    viewport: { columns: 60, rows: 30 } as never,
  })
  const texts = (await ui.findAll({ type: 'Text', text: /#\d+/ })).map(n => String((n as { text?: string }).text ?? ''))
  expect(texts.findIndex(t => t.includes('#33'))).toBeLessThan(texts.findIndex(t => t.includes('#47')))
  expect(texts.findIndex(t => t.includes('#47'))).toBeLessThan(texts.findIndex(t => t.includes('#34')))
  expect((await ui.findAll({ type: 'Box', key: '47' })).length).toBe(1)
})

// --- Subtareas nativas ---

test('firstJson e issueNumberFromUrl', async () => {
  expect(firstJson('{"a":{"b":"}"}}\nglab: error')).toBe('{"a":{"b":"}"}}')
  expect(firstJson('aviso\n{"s":"a\\"}]{"}  resto')).toBe('{"s":"a\\"}]{"}')
  expect(firstJson('sin json')).toBe('sin json')
  expect(issueNumberFromUrl('https://api.github.com/repos/a/b/issues/200', 'a/b')).toBe(200)
  expect(issueNumberFromUrl('https://api.github.com/repos/A/B/issues/200', 'a/b')).toBe(200)
  expect(issueNumberFromUrl('https://api.github.com/repos/a/otro/issues/12', 'a/b')).toBe(undefined)
  expect(issueNumberFromUrl(null, 'a/b')).toBe(undefined)
})

test('GitHub: subtareas nativas al crear, enganchar y soltar', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  const w = fakeWorld(on, 'github', [issue(10, 'Grande'), issue(11, 'Suelta', [], true, 'detalle\n\nParte de #10')])
  await start($)

  expect(await run($, 'new --parent 10 Parte uno')).toContain('Creado: #41 (parte de #10).')
  expect(w.issues.find(i => i.id === 41)).toMatchObject({ nativeParent: 10, body: '' })

  // Tenía la línea de texto: pasa a nativo y la línea se va
  expect(await run($, 'link 11 10')).toContain('#11 ya era parte de #10.')
  await run($, 'unlink 11')
  await run($, 'link 11 10')
  expect(w.issues.find(i => i.id === 11)).toMatchObject({ nativeParent: 10, body: 'detalle' })
  expect(await tool($, { action: 'list' })).toBe('#10 [ ] Grande\n  #11 [ ] Suelta\n  #41 [ ] Parte uno')

  expect(await run($, 'unlink 41')).toContain('#41 ya no es parte de ninguna.')
  expect(w.issues.find(i => i.id === 41)!.nativeParent).toBe(undefined)
})

test('GitHub: si no hay sub-issues, queda la línea "Parte de"', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  const w = fakeWorld(on, 'github', [issue(10, 'Grande')])
  w.noNative = true
  await start($)
  await run($, 'new --parent 10 Hija')
  expect(w.issues.find(i => i.id === 41)).toMatchObject({ body: 'Parte de #10' })
  expect(w.issues.find(i => i.id === 41)!.nativeParent).toBe(undefined)
  expect(await tool($, { action: 'list' })).toBe('#10 [ ] Grande\n  #41 [ ] Hija')
})

test('GitLab: las subtareas nuevas son Tasks hijas; el árbol se lee por GraphQL', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  const w = fakeWorld(on, 'gitlab', [issue(39, 'LTS'), issue(47, 'LTS 1/6', [], true, 'Parte de #39')])
  await start($)

  expect(await run($, 'new --parent 39 LTS 7/6')).toContain('Creado: #48 (parte de #39).')
  expect(w.issues.find(i => i.id === 48)).toMatchObject({ isTask: true, nativeParent: 39, body: '' })
  // #47 es un Issue enganchado por texto; #48 una Task nativa: los dos cuelgan de #39
  expect(await tool($, { action: 'list' })).toBe('#39 [ ] LTS\n  #47 [ ] LTS 1/6\n  #48 [ ] LTS 7/6')
})

test('GitLab: enganchar un Issue va por texto; una Task, nativo; soltar una Task la desengancha', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  const w = fakeWorld(on, 'gitlab', [issue(1, 'A'), issue(2, 'B'), issue(3, 'Issue suelto'), { ...issue(4, 'Task de A'), isTask: true, nativeParent: 1 }])
  await start($)

  await run($, 'link 3 1')
  expect(w.issues.find(i => i.id === 3)).toMatchObject({ body: 'Parte de #1' })
  expect(w.issues.find(i => i.id === 3)!.nativeParent).toBe(undefined)

  await run($, 'link 4 2')
  expect(w.issues.find(i => i.id === 4)).toMatchObject({ nativeParent: 2, body: '' })

  await run($, 'unlink 4')
  expect(w.issues.find(i => i.id === 4)!.nativeParent).toBe(undefined)
})

test('GitLab: sin GraphQL, o si el padre es una Task, se usa la línea de texto', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  const w = fakeWorld(on, 'gitlab', [issue(1, 'A'), { ...issue(2, 'Task'), isTask: true, nativeParent: 1 }])
  await start($)

  await run($, 'new --parent 2 Nieta')
  expect(w.issues.find(i => i.id === 41)).toMatchObject({ body: 'Parte de #2' })
  expect(w.issues.find(i => i.id === 41)!.isTask).toBe(undefined)

  // Sin GraphQL no se ve el árbol completo: no se cuelga nada y se avisa
  w.noNative = true
  expect(await run($, 'new --parent 1 Otra')).toBe('No pude leer las subtareas nativas de GitLab: graphql caído No cambié nada.')
  expect(await run($, 'link 41 1')).toBe('No pude leer las subtareas nativas de GitLab: graphql caído No cambié nada.')
  expect(w.issues.length).toBe(3)
  // La lista sigue andando (aplanada para lo nativo)
  expect(await tool($, { action: 'list' })).toBe('#1 [ ] A\n#2 [ ] Task\n  #41 [ ] Nieta')
})

// --- Cuarta revisión ---

test('new --parent y link: el padre tiene que existir y estar abierto', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  const w = fakeWorld(on, 'github', [issue(10, 'Abierta'), issue(11, 'Cerrada', [], false), issue(12, 'Suelta')])
  await start($)
  expect(await run($, 'new --parent 999 X')).toBe('#999 no existe en micayael/demo. No cambié nada.')
  expect(await run($, 'new --parent 11 X')).toBe('#11 está cerrado. No cambié nada.')
  expect(await run($, 'link 12 11')).toBe('#11 está cerrado. No cambié nada.')
  expect(w.issues.length).toBe(3)
})

test('GitHub: si rechaza el sub-issue, queda por texto y lo dice', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  const w = fakeWorld(on, 'github', [issue(10, 'Grande'), issue(11, 'Suelta')])
  w.subIssueRejects = true
  await start($)
  expect(await run($, 'link 11 10')).toContain('#11 ahora es parte de #10 (por texto).')
  expect(await run($, 'new --parent 10 Otra')).toContain('Creado: #41 (parte de #10, por texto).')
  expect(w.issues.find(i => i.id === 41)).toMatchObject({ body: 'Parte de #10' })
})

test('enganchar cuando el padre nativo ya coincide limpia una línea de texto vieja', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  const w = fakeWorld(on, 'github', [issue(10, 'A'), issue(20, 'B'), { ...issue(11, 'Hija', [], true, 'detalle\n\nParte de #20'), nativeParent: 10 }])
  await start($)
  expect(await run($, 'link 11 10')).toContain('#11 ya era parte de #10.')
  expect(w.issues.find(i => i.id === 11)).toMatchObject({ nativeParent: 10, body: 'detalle' })
})

test('ciclo mixto (nativo + texto) se detecta antes de escribir', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  const w = fakeWorld(on, 'gitlab', [issue(1, 'Issue'), { ...issue(2, 'Task'), isTask: true, nativeParent: 1 }])
  await start($)
  expect(await run($, 'link 1 2')).toContain('#1 no puede ser parte de #2: quedaría en círculo.')
  expect(w.issues[0].body).toBe('')
})

test('GitLab: errores dentro de la respuesta de la mutation se muestran', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  const w = fakeWorld(on, 'gitlab', [issue(1, 'A'), issue(2, 'B'), { ...issue(3, 'Task'), isTask: true, nativeParent: 1 }])
  await start($)
  w.mutationErrors = ['No tenés permiso']
  // Al crear cae a texto; al soltar una Task no hay respaldo: se muestra el error
  expect(await run($, 'new --parent 1 X')).toContain('Creado: #41 (parte de #1, por texto).')
  expect(await run($, 'unlink 3')).toContain('#3: No tenés permiso')
  expect(w.issues.find(i => i.id === 3)!.nativeParent).toBe(1)
})

test('GitLab: el árbol nativo se lee paginado; un Epic como padre no cuenta', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  const issues = [issue(1, 'Raíz'), ...Array.from({ length: 5 }, (_, k) => ({ ...issue(k + 2, `Task ${k + 2}`), isTask: true, nativeParent: 1 }))]
  issues.push({ ...issue(7, 'Hija de un Epic'), nativeParent: 950 })
  const w = fakeWorld(on, 'gitlab', issues)
  w.gqlPageSize = 2
  await start($)
  expect(await tool($, { action: 'list' })).toBe('#1 [ ] Raíz\n  #2 [ ] Task 2\n  #3 [ ] Task 3\n  #4 [ ] Task 4\n  #5 [ ] Task 5\n  #6 [ ] Task 6\n#7 [ ] Hija de un Epic')
})

test('la herramienta rechaza números de issue que no son enteros', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  fakeWorld(on, 'gitlab', [issue(1, 'A')])
  await start($)
  expect(await tool($, { action: 'done', id: 1.5 })).toBe('Falta el número de issue (id).')
  expect(await tool($, { action: 'add', text: 'x', parent: 2.5 })).toBe('parent tiene que ser un número de issue.')
})

test('treeRows: más de 8 niveles se siguen mostrando, sin más sangría', async () => {
  const chain = Array.from({ length: 12 }, (_, k) => task(k + 1, 'pending', k === 0 ? undefined : k))
  const rows = treeRows(chain)
  expect(rows.length).toBe(12)
  expect(rows.map(r => r.depth)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 8, 8, 8])
})

test('panel compacto: el hijo de una tarea tildada pasa a raíz; con aviso entra en el alto', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  const w = fakeWorld(on, 'gitlab', [
    issue(1, 'Grande tildada', ['Testing']),
    issue(2, 'Hija pendiente', [], true, 'Parte de #1'),
    ...Array.from({ length: 8 }, (_, k) => issue(k + 3, `Otra ${k + 3}`)),
  ])
  await start($)
  w.noNative = true
  await tool($, { action: 'list' }) // deja el aviso de GraphQL caído en el panel
  const ui = await $.ui.mount({
    plugin: 'pendientes',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'pendientes',
    props: { title: 'Pendientes', placement: 'inline' } as never,
    viewport: { columns: 60, rows: 30 } as never,
  })
  expect((await ui.findAll({ type: 'Box', key: '2' })).length).toBe(1)
  expect((await ui.findAll({ text: /Grande tildada/ })).length).toBe(0)
  // encabezado + aviso + 5 filas + "… y N más" = 8 filas
  expect((await ui.findAll({ type: 'Text', text: /^[○▶✓] #\d+/ })).length).toBe(5)
  expect((await ui.findAll({ text: /… y 4 más/ })).length).toBeGreaterThan(0)
})

// --- Alto del panel ---

const mountPane = ($: Engine, placement: 'dock' | 'inline', rows = 30, bodyColumns = 40) =>
  $.ui.mount({
    plugin: 'pendientes',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'pendientes',
    props: { title: 'Pendientes', placement, bodyColumns } as never,
    viewport: { columns: 120, rows } as never,
  })

type FakeAgent = { id: string; type: string; description: string; status: string }
function fakeAgents(on: On, list: FakeAgent[]) {
  on('agent.list', async () => ({ value: list.map(a => ({ ...a })) }) as never)
  on('agent.spawn', async ($, e) => {
    const id = `a${list.length + 1}`
    list.push({ id, type: (e as { subagentType?: string }).subagentType ?? 'general-purpose', description: String((e as { description?: string }).description), status: 'running' })
    return { model: 'm', agentId: id } as never
  })
}
const agentsOf = (n: number): FakeAgent[] => Array.from({ length: n }, (_, k) => ({ id: `x${k}`, type: 'Explore', description: `Agente ${k + 1}`, status: 'running' }))

test('wrapRows: corta por palabras al ancho, y parte palabras más largas', async () => {
  expect(wrapRows('uno dos tres cuatro', 9)).toEqual(['uno dos', 'tres', 'cuatro'])
  expect(wrapRows('a\nb c', 10)).toEqual(['a', 'b c'])
  expect(wrapRows('abcdefghij x', 4)).toEqual(['abcd', 'efgh', 'ij x'])
  expect(wrapRows('', 5)).toEqual([''])
})

test('sin agentes la lista usa todo el alto; con agentes les deja lugar abajo', async ($, on) => {
  bottoms(on)
  const clock = mock.clock(on)
  fakeWorld(on, 'gitlab', Array.from({ length: 30 }, (_, k) => issue(k + 1, `Tarea ${k + 1}`)))
  const list: FakeAgent[] = []
  fakeAgents(on, list)
  await start($)
  await tool($, { action: 'list' })

  const ui = await mountPane($, 'dock') // 40 columnas, 30 filas de terminal: alto 26
  // encabezado + tareas + "… y N más"
  expect((await ui.findAll({ type: 'Text', text: /^○ #\d+/ })).length).toBe(26 - 2)
  expect((await ui.findAll({ text: /Agentes trabajando/ })).length).toBe(0)

  list.push(...agentsOf(4))
  await clock.advance(5 * 1000)
  await idle()
  // encabezado + tareas + "… y N más" + separador + título + 4 agentes
  expect((await ui.findAll({ type: 'Text', text: /^○ #\d+/ })).length).toBe(26 - 2 - 2 - 4)
  expect((await ui.findAll({ text: /Explore · Agente 4/ })).length).toBeGreaterThan(0)
})

test('muchos agentes: se cortan con "… y N más" y quedan al menos 3 tareas', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  fakeWorld(on, 'gitlab', Array.from({ length: 10 }, (_, k) => issue(k + 1, `Tarea ${k + 1}`)))
  fakeAgents(on, agentsOf(30))
  await start($)
  await tool($, { action: 'list' })
  const ui = await mountPane($, 'dock', 20)
  expect((await ui.findAll({ type: 'Text', text: /^○ #\d+/ })).length).toBe(3)
  // alto 16 - encabezado - "… y N más" - 3 tareas - separador - título = 9 filas: 8 agentes y "… y 22 más"
  expect((await ui.findAll({ type: 'Text', text: /^⟳ Explore/ })).length).toBe(8)
  expect((await ui.findAll({ text: /… y 22 más/ })).length).toBeGreaterThan(0)
})

test('títulos largos: la tarea en curso entra sin desplazar el panel (caso his-interno)', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  const titles: Record<string, string> = {
    '1': 'Revisar con farmacia los 6 artículos con observación "Código de otro producto"',
    '2': 'agregar el rol para crear nuevos medicamentos y descartables.',
    '3': 'importar datos del lote y vencimientos para seleccionarlo en el inventario.',
    '4': 'intentar realizar la conversión de caja a comprimidos y permitir cantidad de comprimidos a mano también.',
    '5': 'importar costos al maestro de artículos.',
  }
  fakeWorld(on, 'gitlab', Object.entries(titles).map(([id, t]) => issue(Number(id), t, id === '4' ? ['In Process'] : [])))
  fakeAgents(on, agentsOf(6))
  await start($)
  await tool($, { action: 'list' })
  const ui = await mountPane($, 'dock', 22, 44)
  // La tarea en curso va primero y se ve, y los agentes también
  expect((await ui.findAll({ type: 'Text', text: /^▶ #4 intentar/ })).length).toBeGreaterThan(0)
  expect((await ui.findAll({ text: /Agentes trabajando/ })).length).toBeGreaterThan(0)
  // Las tareas que se dibujan, medidas con su alto real, entran en lo que dejan los agentes:
  // alto 18 (22 - 4) - encabezado - "… y N más" - separador - título - 6 agentes
  const ids = new Set((await ui.findAll({ type: 'Text', text: /^[○▶] #\d+ / })).map(n => /#(\d+)/.exec(String((n as { text?: string }).text))?.[1]))
  const taskRows = [...ids].reduce((sum, id) => sum + wrapRows(`○ #${id} ${titles[id!]}`, 44).length, 0)
  expect(ids.has('4')).toBe(true)
  expect(taskRows).toBeLessThanOrEqual(18 - 2 - 2 - 6)
})

// --- Títulos largos y contexto al empezar ---

const LONG =
  'agregá la opción desde el admin de usuarios, al entrar a cada usuario realizar el envío del correo para definir contraseña usando el mismo mecanismo que saliendo y dando la link de recordar contraseña.'

test('new con texto largo: título resumido por el modelo y el texto entero en la descripción', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  const prompts: string[] = []
  on('model.complete', async ($, e) => (prompts.push(e.prompt), { value: { isAnswered: true, text: '"Enviar correo de definir contraseña desde el admin."', usage: {} } }) as never)
  const w = fakeWorld(on, 'gitlab')
  await start($)

  const out = await run($, `new ${LONG}`)
  expect(out).toContain('Creado: #41.')
  expect(out).toContain('el texto entero quedó en la descripción')
  expect(w.issues[0].title).toBe('Enviar correo de definir contraseña desde el admin')
  expect(w.issues[0].body).toBe(LONG)
  expect(prompts[0]).toContain(LONG)
})

test('new con texto largo y sin modelo: el título se corta en una palabra', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  on('model.complete', async () => ({ value: { isAnswered: false, reason: 'aborted', usage: {} } }) as never)
  const w = fakeWorld(on, 'gitlab')
  await start($)

  await run($, `new ${LONG}`)
  const title = w.issues[0].title
  expect(title.length <= 80).toBe(true)
  expect(title.endsWith('…')).toBe(true)
  expect(LONG.startsWith(title.slice(0, -1))).toBe(true)
  expect(w.issues[0].body).toBe(LONG)
})

test('la herramienta: título largo con descripción, el texto va antes del detalle', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  on('model.complete', async () => ({ value: { isAnswered: true, text: 'Enviar correo de contraseña', usage: {} } }) as never)
  const w = fakeWorld(on, 'gitlab')
  await start($)

  await tool($, { action: 'add', text: LONG, description: 'Llevarlo también a la plantilla.' })
  expect(w.issues[0].title).toBe('Enviar correo de contraseña')
  expect(w.issues[0].body).toBe(`${LONG}\n\nLlevarlo también a la plantilla.`)
})

test('start le pasa al modelo la descripción de la tarea', async ($, on) => {
  bottoms(on)
  mock.clock(on)
  fakeWorld(on, 'gitlab', [issue(1, 'a', [], true, 'Detalle de a'), issue(2, 'b', ['In Process'])])
  await start($)

  const r = await $.command.run({ command: 'todo', args: 'start 1 2' } as never)
  expect(String(r.text)).toContain('#1 en curso. #2 ya estaba en curso.')
  expect(String(r.text).includes('Detalle de a')).toBe(false)
  expect(r.context).toEqual(['Tarea #1 en curso: a\n\nDescripción del issue:\nDetalle de a', 'Tarea #2 en curso: b\n\nDescripción del issue:\n(sin descripción)'])

  const done = await $.command.run({ command: 'todo', args: 'done 1' } as never)
  expect(done.context).toBe(undefined)

  expect(await tool($, { action: 'start', id: 1 })).toContain('Descripción del issue:\nDetalle de a')
})

// --- Agentes trabajando ---

import { elapsed } from './register'

test('elapsed', async () => {
  expect(elapsed(5000)).toBe('5s')
  expect(elapsed(80 * 1000)).toBe('1m 20s')
  expect(elapsed(2 * 3600 * 1000 + 5 * 60 * 1000)).toBe('2h 5m')
})

for (const placement of ['dock', 'inline'] as const) {
  test(`panel ${placement}: los agentes trabajando se ven abajo, y al terminar se van`, async ($, on) => {
    bottoms(on)
    const clock = mock.clock(on)
    fakeWorld(on, 'gitlab', [issue(1, 'a')])
    const list: FakeAgent[] = [{ id: 'x', type: 'Explore', description: 'Buscar el render', status: 'running' }, { id: 'y', type: 'Plan', description: 'Ya está', status: 'completed' }]
    fakeAgents(on, list)
    await start($)

    const ui = await mountPane($, placement)
    expect((await ui.findAll({ text: /Explore · Buscar el render/ })).length).toBeGreaterThan(0)
    expect((await ui.findAll({ text: /Ya está/ })).length).toBe(0)

    await $.agent.spawn({ prompt: 'p', description: 'Revisar tests', subagentType: 'Explore' } as never)
    await clock.advance(80 * 1000)
    await idle()
    expect((await ui.findAll({ text: /Explore · Revisar tests · 1m 20s/ })).length).toBeGreaterThan(0)

    for (const a of list) a.status = 'completed'
    await clock.advance(5 * 1000)
    await idle()
    expect((await ui.findAll({ text: /Revisar tests/ })).length).toBe(0)
    expect((await ui.findAll({ text: /Agentes|agentes|Agente:/ })).length).toBe(0)
  })
}
