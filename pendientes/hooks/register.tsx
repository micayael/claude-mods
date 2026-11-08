import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, Task } from '../types'
import { CLI, firstJson, issueNumberFromUrl, parseParent, parseRemote, parseTitles, withParent, wrapRows } from './forge'
import { ancestors, treeRows } from './tree'
import type { Forge } from './forge'

// Los pendientes son los issues abiertos del repo (GitHub o GitLab): no hay copia local.
// En curso lleva una etiqueta; tildar le pone la de "hecho" más una marca propia del mod,
// y los marcados se cierran cuando la rama principal llega al remoto con un push.

const PANE = 'pendientes'
const TITLE = 'Pendientes'
// Ancho pedido para el panel lateral; si lo arrastrás a mano, gana tu ancho
const WIDTH = 52
// Alto pedido cuando la terminal es angosta y el panel va arriba del prompt
const INLINE_ROWS = 8
const TOOL = 'pendientes'
// Cada cuánto se relee la lista, por si cambió desde la web
const REFRESH_MS = 2 * 60 * 1000
// Una llamada a gh/glab que tarda más que esto se da por fallida (sin red, por ejemplo)
const API_TIMEOUT_MS = 15 * 1000
// git es local: si tarda más que esto, algo anda mal
const GIT_TIMEOUT_MS = 5 * 1000
// gh/glab devuelven de a 100; más de esto no se lee
const MAX_PAGES = 10
// Un texto más largo que esto se resume para el título y va entero a la descripción
const TITLE_MAX = 80
const TITLE_TIMEOUT_MS = 20 * 1000
// Lo que se le pasa al modelo de la descripción de una tarea que empieza
const CONTEXT_MAX = 8000
const tasks = atom({ plugin: 'pendientes', key: 'tasks' } as const, [])
const problem = atom({ plugin: 'pendientes', key: 'problem' } as const, '')
const agents = atom({ plugin: 'pendientes', key: 'agents' } as const, [] as AgentRow[])
// Cada cuánto se relee la lista de agentes (es local; también corre el tiempo que llevan)
const AGENTS_MS = 5 * 1000

// Las etiquetas salen de la configuración del mod (userConfig)
let CURRENT = 'In Process'
let DONE = 'Testing'
let CLOSE = 'Close on push'

// Las operaciones van en fila: dos cambios de etiquetas a la vez se pisarían
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.catch(() => undefined)
  return run
}

// GitHub no distingue mayúsculas en las etiquetas: "testing" es "Testing"
const hasLabel = (labels: readonly string[], name: string) => labels.some(l => l.toLowerCase() === name.toLowerCase())

// --- git ---

async function git($: EngineInterface, args: string[]): Promise<string | undefined> {
  const { exitCode, stdout } = await $.process.run(['git', ...args], { cwd: await $.session.root(), timeoutMs: GIT_TIMEOUT_MS })
  return exitCode === 0 ? stdout.trim() : undefined
}

async function detect($: EngineInterface): Promise<Forge | undefined> {
  const url = await git($, ['remote', 'get-url', 'origin'])
  return url === undefined ? undefined : parseRemote(url)
}

// La rama principal según el remoto (origin/HEAD), o origin/main / origin/master si no está
async function defaultRef($: EngineInterface): Promise<string | undefined> {
  const head = await git($, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (head) return head
  for (const ref of ['origin/main', 'origin/master']) {
    if ((await git($, ['rev-parse', '--verify', '--quiet', ref])) !== undefined) return ref
  }
  return undefined
}

// Dónde está la rama principal en el remoto, según lo último que git sabe de él
async function pushedTip($: EngineInterface): Promise<{ ref: string; sha: string } | undefined> {
  const ref = await defaultRef($)
  const sha = ref === undefined ? undefined : await git($, ['rev-parse', ref])
  return ref === undefined || sha === undefined ? undefined : { ref, sha }
}

// Si entre `since` y ahora la rama remota la movió un push (no un fetch o un pull): git lo
// anota en el reflog del ref remoto como "update by push"
async function movedByPush($: EngineInterface, ref: string, since: string): Promise<boolean> {
  const log = await git($, ['reflog', 'show', '--format=%H%x09%gs', '-n', '50', `refs/remotes/${ref}`])
  for (const line of (log ?? '').split('\n')) {
    const [sha, message = ''] = line.split('\t')
    if (sha === since) break
    if (message.startsWith('update by push')) return true
  }
  return false
}

const branchName = (ref: string | undefined) => (ref ?? 'la rama principal').replace(/^origin\//, '')

// --- GitHub / GitLab ---

async function api($: EngineInterface, f: Forge, args: string[]): Promise<unknown> {
  const { exitCode, stdout, stderr } = await $.process.run([CLI[f.kind], 'api', ...args], {
    cwd: await $.session.root(),
    timeoutMs: API_TIMEOUT_MS,
  })
  if (exitCode !== 0) throw new Error((stderr || stdout).trim().split('\n')[0] || `${CLI[f.kind]} falló`)
  return stdout.trim() === '' ? null : JSON.parse(stdout)
}

const project = (f: Forge) => `projects/${encodeURIComponent(f.repo)}`
const issuePath = (f: Forge, id: number) => (f.kind === 'github' ? `repos/${f.repo}/issues/${id}` : `${project(f)}/issues/${id}`)

// uid: el id interno de GitHub (los sub-issues se enganchan por él, no por el número)
type Issue = {
  id: number
  title: string
  labels: string[]
  isOpen: boolean
  body: string
  uid?: number
  nativeParent?: number
  isTask?: boolean
  gid?: string
}

type GithubIssue = {
  id: number
  number: number
  title: string
  state: string
  body?: string | null
  labels: { name: string }[]
  parent_issue_url?: string | null
  pull_request?: unknown
}
type GitlabIssue = { iid: number; title: string; state: string; description?: string | null; labels: string[]; issue_type?: string }

const fromGithub = (i: GithubIssue, repo: string): Issue => ({
  id: i.number,
  title: i.title,
  labels: i.labels.map(l => l.name),
  isOpen: i.state === 'open',
  body: i.body ?? '',
  uid: i.id,
  nativeParent: issueNumberFromUrl(i.parent_issue_url, repo),
})
const fromGitlab = (i: GitlabIssue): Issue => ({
  id: i.iid,
  title: i.title,
  labels: i.labels,
  isOpen: i.state === 'opened',
  body: i.description ?? '',
  isTask: i.issue_type === 'task',
})

// treeError: GitLab no pudo leer la jerarquía nativa (el árbol puede estar incompleto)
async function listIssues($: EngineInterface, f: Forge): Promise<{ issues: Issue[]; treeError?: string }> {
  const all: Issue[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const path =
      f.kind === 'github'
        ? `repos/${f.repo}/issues?state=open&per_page=100&page=${page}&direction=asc`
        : `${project(f)}/issues?state=opened&per_page=100&page=${page}&order_by=created_at&sort=asc`
    const batch = (await api($, f, [path])) as (GithubIssue | GitlabIssue)[]
    for (const i of batch) {
      if (f.kind === 'github') {
        // En GitHub los PRs también salen como issues
        if ((i as GithubIssue).pull_request === undefined) all.push(fromGithub(i as GithubIssue, f.repo))
      } else {
        all.push(fromGitlab(i as GitlabIssue))
      }
    }
    if (batch.length < 100) break
  }
  if (f.kind === 'gitlab') {
    // Las Tasks hijas solo se ven por GraphQL; si falla, queda la línea "Parte de #N"
    try {
      const hierarchy = await gitlabHierarchy($, f)
      for (const i of all) {
        const h = hierarchy.get(i.id)
        if (h === undefined) continue
        i.nativeParent = h.parent
        i.isTask = h.isTask
        i.gid = h.gid
      }
    } catch (err) {
      return { issues: all, treeError: (err as Error).message }
    }
  }
  return { issues: all }
}

async function getIssue($: EngineInterface, f: Forge, id: number): Promise<Issue> {
  const r = await api($, f, [issuePath(f, id)])
  return f.kind === 'github' ? fromGithub(r as GithubIssue, f.repo) : fromGitlab(r as GitlabIssue)
}

async function createIssue($: EngineInterface, f: Forge, title: string, body: string): Promise<{ id: number; uid?: number }> {
  if (f.kind === 'github') {
    const r = (await api($, f, ['-X', 'POST', `repos/${f.repo}/issues`, '-f', `title=${title}`, '-f', `body=${body}`])) as { number: number; id: number }
    return { id: r.number, uid: r.id }
  }
  const r = (await api($, f, ['-X', 'POST', `${project(f)}/issues`, '-f', `title=${title}`, '-f', `description=${body}`])) as { iid: number }
  return { id: r.iid }
}

async function setBody($: EngineInterface, f: Forge, id: number, body: string): Promise<void> {
  if (f.kind === 'github') await api($, f, ['-X', 'PATCH', issuePath(f, id), '-f', `body=${body}`])
  else await api($, f, ['-X', 'PUT', issuePath(f, id), '-f', `description=${body}`])
}

// --- Subtareas nativas ---

// GitHub: sub-issues por REST, con el id interno del hijo
async function setGithubParent($: EngineInterface, f: Forge, uid: number, parent: number | undefined, current: number | undefined): Promise<void> {
  if (parent === undefined) {
    if (current !== undefined) await api($, f, ['-X', 'DELETE', `repos/${f.repo}/issues/${current}/sub_issue`, '-F', `sub_issue_id=${uid}`])
    return
  }
  await api($, f, ['-X', 'POST', `repos/${f.repo}/issues/${parent}/sub_issues`, '-F', `sub_issue_id=${uid}`, '-F', 'replace_parent=true'])
}

// GitLab: GraphQL. Los errores pueden venir en la respuesta aunque glab termine bien
async function gql($: EngineInterface, query: string, vars: Record<string, string>): Promise<Record<string, unknown>> {
  const args = ['glab', 'api', 'graphql', '-f', `query=${query}`]
  for (const [k, v] of Object.entries(vars)) args.push('-f', `${k}=${v}`)
  const { exitCode, stdout, stderr } = await $.process.run(args, { cwd: await $.session.root(), timeoutMs: API_TIMEOUT_MS })
  let parsed: { data?: Record<string, unknown>; errors?: { message: string }[] } | undefined
  try {
    parsed = JSON.parse(firstJson(stdout))
  } catch {
    parsed = undefined
  }
  const error = parsed?.errors?.[0]?.message
  if (exitCode !== 0 || error !== undefined || parsed?.data === undefined) {
    throw new Error(error ?? ((stderr || stdout).trim().split('\n')[0] || 'GraphQL falló'))
  }
  return parsed.data
}

type Hierarchy = Map<number, { gid: string; parent?: number; isTask: boolean }>

async function gitlabHierarchy($: EngineInterface, f: Forge): Promise<Hierarchy> {
  const out: Hierarchy = new Map()
  let after: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = `query($p: ID!${after ? ', $after: String' : ''}) { project(fullPath: $p) { workItems(state: opened, first: 100${after ? ', after: $after' : ''}) { pageInfo { hasNextPage endCursor } nodes { id iid workItemType { name } widgets { ... on WorkItemWidgetHierarchy { parent { iid workItemType { name } } } } } } } }`
    const data = await gql($, query, after ? { p: f.repo, after } : { p: f.repo })
    type Node = { id: string; iid: string; workItemType: { name: string }; widgets: { parent?: { iid: string; workItemType?: { name: string } } | null }[] }
    const items = (data.project as { workItems: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: Node[] } }).workItems
    for (const n of items.nodes) {
      const parent = n.widgets.find(w => w.parent !== undefined)?.parent
      // Solo cuenta un padre de tipo Issue del proyecto: un Epic (de grupo) tiene otra numeración
      const isLocal = parent != null && (parent.workItemType?.name ?? 'Issue') === 'Issue'
      out.set(Number(n.iid), { gid: n.id, parent: isLocal ? Number(parent.iid) : undefined, isTask: n.workItemType.name === 'Task' })
    }
    if (!items.pageInfo.hasNextPage) break
    after = items.pageInfo.endCursor
  }
  return out
}

type Ref = { gid: string; type: string }

// El id del tipo Task de cada proyecto (no cambia: se pide una vez por sesión)
const taskTypes = new Map<string, string>()

// Ids globales (gid://gitlab/WorkItem/…) y tipo de unos issues: los que ya trajo la lista, y el
// resto por GraphQL. Los números van en la consulta: son enteros, no texto del usuario
async function gitlabRefs($: EngineInterface, f: Forge, list: readonly Task[], iids: readonly number[]): Promise<Map<number, Ref>> {
  const out = new Map<number, Ref>()
  for (const t of list) if (iids.includes(t.id) && t.gid) out.set(t.id, { gid: t.gid, type: t.isTask ? 'Task' : 'Issue' })
  const missing = iids.filter(n => !out.has(n) && Number.isInteger(n))
  const needsType = !taskTypes.has(f.repo)
  if (missing.length === 0 && !needsType) return out
  const listed = missing.map(n => `"${n}"`).join(', ')
  const data = await gql(
    $,
    `query($p: ID!) { project(fullPath: $p) { workItemTypes(name: TASK) { nodes { id } } workItems(iids: [${listed}]) { nodes { id iid workItemType { name } } } } }`,
    { p: f.repo },
  )
  const project = data.project as { workItemTypes: { nodes: { id: string }[] }; workItems: { nodes: { id: string; iid: string; workItemType: { name: string } }[] } }
  const task = project.workItemTypes.nodes[0]?.id
  if (task) taskTypes.set(f.repo, task)
  for (const n of missing.length > 0 ? project.workItems.nodes : []) out.set(Number(n.iid), { gid: n.id, type: n.workItemType.name })
  return out
}

const mutationErrors = (payload: unknown) => {
  const r = payload as { errors?: string[] } | null
  return r === null ? ['GitLab no respondió'] : (r.errors ?? [])
}

// Crea una Task hija de `parent` (que tiene que ser de tipo Issue)
async function createGitlabTask($: EngineInterface, f: Forge, list: readonly Task[], title: string, body: string, parent: number): Promise<number> {
  const p = (await gitlabRefs($, f, list, [parent])).get(parent)
  const type = taskTypes.get(f.repo)
  if (p === undefined || p.type !== 'Issue' || type === undefined) throw new Error(`#${parent} no puede tener tareas hijas`)
  const data = await gql(
    $,
    'mutation($p: ID!, $title: String!, $body: String, $type: WorkItemsTypeID!, $parent: WorkItemID!) { workItemCreate(input: { namespacePath: $p, title: $title, descriptionWidget: { description: $body }, workItemTypeId: $type, hierarchyWidget: { parentId: $parent } }) { workItem { iid } errors } }',
    { p: f.repo, title, body, type, parent: p.gid },
  )
  const errors = mutationErrors(data.workItemCreate)
  const made = (data.workItemCreate as { workItem?: { iid: string } | null } | null)?.workItem
  if (errors.length > 0 || !made) throw new Error(errors[0] ?? 'no se creó')
  return Number(made.iid)
}

// Engancha o suelta una Task de su padre
async function setGitlabParent($: EngineInterface, f: Forge, list: readonly Task[], id: number, parent: number | undefined): Promise<void> {
  const refs = await gitlabRefs($, f, list, parent === undefined ? [id] : [id, parent])
  const child = refs.get(id)
  if (child === undefined) throw new Error(`#${id} no existe`)
  const target = parent === undefined ? undefined : refs.get(parent)
  if (parent !== undefined && (target === undefined || target.type !== 'Issue')) throw new Error(`#${parent} no puede tener tareas hijas`)
  const data =
    target === undefined
      ? await gql($, 'mutation($id: WorkItemID!) { workItemUpdate(input: { id: $id, hierarchyWidget: { parentId: null } }) { errors } }', { id: child.gid })
      : await gql($, 'mutation($id: WorkItemID!, $parent: WorkItemID!) { workItemUpdate(input: { id: $id, hierarchyWidget: { parentId: $parent } }) { errors } }', { id: child.gid, parent: target.gid })
  const errors = mutationErrors(data.workItemUpdate)
  if (errors.length > 0) throw new Error(errors[0])
}

// Las etiquetas que GitHub ya tiene creadas en esta sesión (para no pedir crearlas cada vez)
const ensuredLabels = new Set<string>()

// `now` son las etiquetas que tiene el issue: solo se agrega lo que falta y se sacan los nombres
// tal como están escritos en el issue (por si difieren en mayúsculas)
async function setLabels(
  $: EngineInterface,
  f: Forge,
  id: number,
  now: readonly string[],
  add: readonly string[],
  remove: readonly string[],
): Promise<void> {
  const adding = add.filter(name => !hasLabel(now, name))
  const removing = now.filter(label => remove.some(name => name.toLowerCase() === label.toLowerCase()))
  if (adding.length === 0 && removing.length === 0) return
  if (f.kind === 'gitlab') {
    const args = ['-X', 'PUT', issuePath(f, id)]
    if (adding.length > 0) args.push('-f', `add_labels=${adding.join(',')}`)
    if (removing.length > 0) args.push('-f', `remove_labels=${removing.join(',')}`)
    await api($, f, args)
    return
  }
  for (const name of adding) {
    // GitHub no crea la etiqueta sola: si ya existe, esto falla y no importa
    const key = `${f.repo}\n${name.toLowerCase()}`
    if (!ensuredLabels.has(key)) {
      await api($, f, ['-X', 'POST', `repos/${f.repo}/labels`, '-f', `name=${name}`, '-f', 'color=ededed']).catch(() => undefined)
      ensuredLabels.add(key)
    }
    await api($, f, ['-X', 'POST', `${issuePath(f, id)}/labels`, '-f', `labels[]=${name}`])
  }
  for (const name of removing) {
    await api($, f, ['-X', 'DELETE', `${issuePath(f, id)}/labels/${encodeURIComponent(name)}`]).catch(() => undefined)
  }
}

// asPlanned false: cerrado sin completar (GitHub lo distingue como "not planned")
async function setClosed($: EngineInterface, f: Forge, id: number, isClosed: boolean, asPlanned = true): Promise<void> {
  if (f.kind === 'github') {
    const args = ['-X', 'PATCH', issuePath(f, id), '-f', `state=${isClosed ? 'closed' : 'open'}`]
    if (isClosed && !asPlanned) args.push('-f', 'state_reason=not_planned')
    await api($, f, args)
  } else {
    await api($, f, ['-X', 'PUT', issuePath(f, id), '-f', `state_event=${isClosed ? 'close' : 'reopen'}`])
  }
}

// Cierre por push: primero se saca la marca, así un cierre fallido no deja un issue marcado que
// se volvería a cerrar solo si alguien lo reabre. En GitLab va todo en una llamada
async function closeAndUnmark($: EngineInterface, f: Forge, id: number, now: readonly string[]): Promise<void> {
  const marks = now.filter(label => label.toLowerCase() === CLOSE.toLowerCase())
  if (f.kind === 'gitlab') {
    const args = ['-X', 'PUT', issuePath(f, id), '-f', 'state_event=close']
    if (marks.length > 0) args.push('-f', `remove_labels=${marks.join(',')}`)
    await api($, f, args)
    return
  }
  await setLabels($, f, id, now, [], [CLOSE])
  await setClosed($, f, id, true)
}

// --- Estado ---

const toTask = (i: Issue): Task => ({
  id: i.id,
  title: i.title,
  status: hasLabel(i.labels, DONE) ? 'done' : hasLabel(i.labels, CURRENT) ? 'current' : 'pending',
  willClose: hasLabel(i.labels, CLOSE),
  labels: i.labels,
  // Lo nativo manda; si no hay, la línea "Parte de #N"
  parent: i.nativeParent ?? parseParent(i.body),
  nativeParent: i.nativeParent,
  isTask: i.isTask,
  gid: i.gid,
})

const NO_REMOTE = 'Este proyecto no tiene un remoto origin en GitHub o GitLab.'

// isTreeFresh: también se leyó el árbol nativo (en GitLab va por GraphQL y puede fallar aparte)
type Snapshot = { f?: Forge; list: Task[]; isFresh: boolean; isTreeFresh: boolean }

// Relee los issues abiertos. Si falla, el panel conserva la última lista, pero isFresh avisa
// que no sirve para decidir nada: con ella no se cierra, reabre ni etiqueta
async function refresh($: EngineInterface): Promise<Snapshot> {
  const f = await detect($)
  if (f === undefined) {
    await update($, problem, () => NO_REMOTE)
    await update($, tasks, () => [])
    return { list: [], isFresh: false, isTreeFresh: false }
  }
  try {
    const { issues, treeError } = await listIssues($, f)
    const list = issues.map(toTask)
    await update($, tasks, () => list)
    await update($, problem, () => (treeError ? `No pude leer las subtareas nativas de GitLab: ${treeError}` : ''))
    return { f, list, isFresh: true, isTreeFresh: treeError === undefined }
  } catch (err) {
    await update($, problem, () => `No pude leer los issues de ${f.repo}: ${(err as Error).message}`)
    return { f, list: await read($, tasks), isFresh: false, isTreeFresh: false }
  }
}

const stale = async ($: EngineInterface, s: Snapshot) => (s.f === undefined ? NO_REMOTE : `${await read($, problem)} No cambié nada.`)

const mark = (t: Task) => (t.status === 'done' ? 'x' : t.status === 'current' ? '>' : ' ')

// Para el modelo: el mismo árbol del panel, con dos espacios por nivel
const describe = (list: readonly Task[]) =>
  list.length === 0
    ? 'No hay issues abiertos.'
    : treeRows(list)
        .map(({ task: t, depth }) => `${'  '.repeat(depth)}#${t.id} [${mark(t)}] ${t.title}`)
        .join('\n')

const openPane = ($: EngineInterface) =>
  $.ui.open({ id: PANE, title: TITLE, columns: WIDTH, rows: INLINE_ROWS }).catch(() => undefined)

// --- Operaciones ---

type Action = 'add' | 'start' | 'done' | 'undo' | 'remove' | 'list'

// Crea el issue; con padre, como subtarea nativa si se puede, y si no con la línea "Parte de #N".
// note: algo que avisar aunque el issue se haya creado
type Created = { id: number; isNative: boolean; note?: string }

async function createChild($: EngineInterface, f: Forge, list: readonly Task[], title: string, body: string, parent: number | undefined): Promise<Created> {
  if (parent === undefined) return { id: (await createIssue($, f, title, body)).id, isNative: false }
  if (f.kind === 'gitlab') {
    try {
      return { id: await createGitlabTask($, f, list, title, body, parent), isNative: true }
    } catch {
      return { id: (await createIssue($, f, title, withParent(body, parent))).id, isNative: false }
    }
  }
  const made = await createIssue($, f, title, body)
  try {
    await setGithubParent($, f, made.uid!, parent, undefined)
    return { id: made.id, isNative: true }
  } catch {
    try {
      await setBody($, f, made.id, withParent(body, parent))
      return { id: made.id, isNative: false }
    } catch (err) {
      return { id: made.id, isNative: false, note: `#${made.id} quedó sin enganchar a #${parent}: ${(err as Error).message}` }
    }
  }
}

// El padre tiene que existir y estar abierto
async function checkParent($: EngineInterface, f: Forge, list: readonly Task[], parent: number): Promise<string | undefined> {
  if (list.some(t => t.id === parent)) return undefined
  try {
    const p = await getIssue($, f, parent)
    return p.isOpen ? undefined : `#${parent} está cerrado. No cambié nada.`
  } catch {
    return `#${parent} no existe en ${f.repo}. No cambié nada.`
  }
}

// Corta en el último espacio antes del máximo
function cutTitle(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= TITLE_MAX) return flat
  const head = flat.slice(0, TITLE_MAX - 1)
  const space = head.lastIndexOf(' ')
  return `${(space > TITLE_MAX / 2 ? head.slice(0, space) : head).replace(/[\s,.;:]+$/, '')}…`
}

// Un título corto para un texto largo; si el modelo no responde, el texto cortado
async function shortTitle($: EngineInterface, text: string): Promise<string> {
  try {
    const r = await $.model.complete({
      model: 'haiku',
      system: 'Escribís títulos de issues.',
      prompt: [
        `Resumí este pedido en un título de issue de ${TITLE_MAX - 20} caracteres como máximo, en el mismo idioma,`,
        'empezando con un verbo. Respondé solo el título, en una línea, sin comillas ni punto final.',
        '',
        text,
      ].join('\n'),
      maxTokens: 100,
      timeoutMs: TITLE_TIMEOUT_MS,
    })
    const line = r.isAnswered ? (r.text.trim().split('\n')[0] ?? '').replace(/^["'«“]+|["'»”.]+$/g, '').trim() : ''
    if (line !== '' && line.length <= TITLE_MAX) return line
  } catch {
    // Sigue con el corte
  }
  return cutTitle(text)
}

// Una tarea pedida: el título, y el texto entero en la descripción si hubo que resumirlo
async function splitTitle($: EngineInterface, text: string, body: string): Promise<{ title: string; body: string; isShortened: boolean }> {
  if (text.length <= TITLE_MAX && !text.includes('\n')) return { title: text, body, isShortened: false }
  const title = await shortTitle($, text)
  return { title, body: [text, body].filter(Boolean).join('\n\n'), isShortened: true }
}

async function addTasks($: EngineInterface, titles: readonly string[], body = '', parent?: number): Promise<string> {
  const clean = titles.map(t => t.trim()).filter(Boolean)
  if (clean.length === 0) return 'Falta el título de la tarea.'
  let f = await detect($)
  if (f === undefined) return NO_REMOTE
  let known: readonly Task[] = []
  if (parent !== undefined) {
    // Para colgar subtareas hace falta ver el árbol completo
    const snapshot = await refresh($)
    if (!snapshot.isFresh || !snapshot.isTreeFresh || snapshot.f === undefined) return stale($, snapshot)
    f = snapshot.f
    known = snapshot.list
    const wrong = await checkParent($, f, known, parent)
    if (wrong !== undefined) return wrong
  }
  const made: Created[] = []
  let failure = ''
  for (const text of clean) {
    const one = await splitTitle($, text, body)
    try {
      const m = await createChild($, f, known, one.title, one.body, parent)
      made.push(one.isShortened ? { ...m, note: [`#${m.id}: "${one.title}" (el texto entero quedó en la descripción).`, m.note].filter(Boolean).join(' ') } : m)
    } catch (err) {
      failure = `No pude crear "${one.title}": ${(err as Error).message}`
      break
    }
  }
  const { list } = await refresh($)
  // Al agregar tareas, el panel se muestra aunque estuviera cerrado
  if (made.length > 0) void openPane($)
  const byText = made.some(m => !m.isNative)
  const of = parent === undefined ? '' : ` (parte de #${parent}${byText ? ', por texto' : ''})`
  const ids = made.map(m => `#${m.id}`).join(', ')
  const notes = made.map(m => m.note).filter(Boolean)
  const head = [made.length > 0 ? `${made.length === 1 ? 'Creado' : 'Creados'}: ${ids}${of}.` : '', ...notes, failure]
  return `${head.filter(Boolean).join(' ')}\n\n${describe(list)}`
}

// Lo que el modelo lee de las tareas que empiezan: título y descripción
async function startContext($: EngineInterface, f: Forge, ids: readonly number[]): Promise<string[]> {
  const out: string[] = []
  for (const id of ids) {
    try {
      const i = await getIssue($, f, id)
      const body = i.body.trim()
      const text = body.length > CONTEXT_MAX ? `${body.slice(0, CONTEXT_MAX)}\n… (descripción cortada)` : body
      out.push(`Tarea #${id} en curso: ${i.title}\n\nDescripción del issue:\n${text || '(sin descripción)'}`)
    } catch {
      // Sin la descripción, queda el título en la lista
    }
  }
  return out
}

type Changed = { text: string; context: string[] }

async function changeTasks($: EngineInterface, action: 'start' | 'done' | 'undo' | 'remove', ids: readonly number[]): Promise<Changed> {
  const snapshot = await refresh($)
  if (!snapshot.isFresh || snapshot.f === undefined) return { text: await stale($, snapshot), context: [] }
  const f = snapshot.f
  const open = new Map(snapshot.list.map(t => [t.id, t]))
  const branch = branchName(await defaultRef($))
  const messages: string[] = []
  // Las que quedan en curso (también las que ya lo estaban): su descripción va de contexto
  const started: number[] = []

  for (const id of ids) {
    const task = open.get(id)
    try {
      if (task === undefined) {
        if (action !== 'undo') {
          messages.push(`#${id} no es un issue abierto.`)
          continue
        }
        // Reabre solo lo que cerró el mod (lleva su marca); un número equivocado, o algo que se
        // cerró a mano desde el tablero, no se reabre
        const closed = await getIssue($, f, id)
        if (closed.isOpen || !hasLabel(closed.labels, CLOSE)) {
          messages.push(`#${id} está cerrado pero no lo cerró este mod; si querés, reabrilo desde la web.`)
          continue
        }
        await setClosed($, f, id, false)
        await setLabels($, f, id, closed.labels, [], [DONE, CURRENT, CLOSE])
        messages.push(`#${id} reabierto.`)
        continue
      }

      if (action === 'start') {
        // Puede haber varias en curso a la vez (tareas relacionadas que se resuelven juntas)
        if (task.status === 'current') {
          messages.push(`#${id} ya estaba en curso.`)
          started.push(id)
          continue
        }
        // También se va una marca de cierre que haya quedado suelta
        await setLabels($, f, id, task.labels, [CURRENT], [DONE, CLOSE])
        messages.push(`#${id} en curso.`)
        started.push(id)
      } else if (action === 'done') {
        // También para lo que ya tenía la etiqueta de hecho (puesta a mano o desde otra máquina):
        // tildarlo con el mod es pedir que se cierre con el push
        if (task.status === 'done' && task.willClose) {
          messages.push(`#${id} ya estaba tildado; se cierra con el próximo push a ${branch}.`)
          continue
        }
        await setLabels($, f, id, task.labels, [DONE, CLOSE], [CURRENT])
        messages.push(`#${id} tildado; se cierra con el próximo push a ${branch}.`)
      } else if (action === 'undo') {
        await setLabels($, f, id, task.labels, [], [DONE, CURRENT, CLOSE])
        messages.push(`#${id} vuelve a pendiente.`)
      } else {
        await setLabels($, f, id, task.labels, [], [DONE, CURRENT, CLOSE])
        await setClosed($, f, id, true, false)
        messages.push(`#${id} cerrado sin completar.`)
      }
    } catch (err) {
      messages.push(`#${id}: ${(err as Error).message}`)
    }
  }

  const after = await refresh($)
  return { text: `${messages.join(' ')}\n\n${describe(after.list)}`, context: await startContext($, f, started) }
}

// Engancha (o suelta, con parent undefined) subtareas: nativo donde se puede, si no con la línea
// "Parte de #N" de la descripción
async function linkTasks($: EngineInterface, ids: readonly number[], parent: number | undefined): Promise<string> {
  const snapshot = await refresh($)
  // Sin el árbol completo no se puede saber si un enganche arma un círculo
  if (!snapshot.isFresh || !snapshot.isTreeFresh || snapshot.f === undefined) return stale($, snapshot)
  const f = snapshot.f
  if (parent !== undefined) {
    const wrong = await checkParent($, f, snapshot.list, parent)
    if (wrong !== undefined) return wrong
  }
  const messages: string[] = []
  for (const id of ids) {
    try {
      if (parent === id || (parent !== undefined && ancestors(snapshot.list, parent).includes(id))) {
        messages.push(`#${id} no puede ser parte de #${parent}: quedaría en círculo.`)
        continue
      }
      const issue = await getIssue($, f, id)
      const known = snapshot.list.find(t => t.id === id)
      const native = known?.nativeParent ?? issue.nativeParent
      const isTask = known?.isTask ?? issue.isTask
      const text = parseParent(issue.body)
      if ((native ?? text) === parent) {
        // Si el padre nativo ya coincide, una línea de texto (a otro padre o al mismo) sobra
        if (native !== undefined && text !== undefined) await setBody($, f, id, withParent(issue.body, undefined))
        messages.push(parent === undefined ? `#${id} no era parte de ninguna.` : `#${id} ya era parte de #${parent}.`)
        continue
      }
      // Nativo donde se puede: GitHub siempre; GitLab solo si el hijo ya es una Task
      let isNative = false
      if (f.kind === 'github' || isTask || native !== undefined) {
        try {
          if (f.kind === 'github') await setGithubParent($, f, issue.uid!, parent, native)
          else await setGitlabParent($, f, snapshot.list, id, parent)
          isNative = parent !== undefined
        } catch (err) {
          // Al soltar no hay respaldo posible: el error se muestra. Al enganchar, queda la línea de texto
          if (parent === undefined || native !== undefined) throw err
        }
      }
      // La línea de texto queda solo si no hubo relación nativa
      const body = withParent(issue.body, isNative ? undefined : parent)
      if (body !== issue.body.trimEnd()) await setBody($, f, id, body)
      messages.push(
        parent === undefined ? `#${id} ya no es parte de ninguna.` : `#${id} ahora es parte de #${parent}${isNative ? '' : ' (por texto)'}.`,
      )
    } catch (err) {
      messages.push(`#${id}: ${(err as Error).message}`)
    }
  }
  const after = await refresh($)
  return `${messages.join(' ')}\n\n${describe(after.list)}`
}

// Cierra los que el mod tildó (marca + etiqueta de hecho). Si alguien les sacó la etiqueta de
// hecho desde la web, no se cierran
async function closeMarked($: EngineInterface): Promise<string> {
  const snapshot = await refresh($)
  if (!snapshot.isFresh || snapshot.f === undefined) return snapshot.f === undefined ? '' : stale($, snapshot)
  const f = snapshot.f
  const closed: string[] = []
  const failed: string[] = []
  for (const t of snapshot.list) {
    if (!t.willClose || t.status !== 'done') continue
    try {
      await closeAndUnmark($, f, t.id, t.labels)
      closed.push(`#${t.id}`)
    } catch (err) {
      failed.push(`#${t.id}: ${(err as Error).message}`)
    }
  }
  if (closed.length > 0) await refresh($)
  return [closed.length > 0 ? `Cerrados: ${closed.join(', ')}.` : '', failed.length > 0 ? `No pude cerrar ${failed.join('; ')}` : '']
    .filter(Boolean)
    .join(' ')
}

async function status($: EngineInterface): Promise<string> {
  const snapshot = await refresh($)
  if (snapshot.f === undefined) return NO_REMOTE
  const { f, list } = snapshot
  const branch = branchName(await defaultRef($))
  const open = list.filter(t => t.status !== 'done').length
  const lines = [
    `Repo: ${f.kind === 'github' ? 'GitHub' : 'GitLab'} ${f.repo} · rama principal: ${branch}`,
    `Etiquetas: en curso "${CURRENT}", hecha "${DONE}", marca de cierre "${CLOSE}"`,
    `Issues abiertos: ${list.length} (${open} pendiente${open === 1 ? '' : 's'}, ${list.length - open} tildado${list.length - open === 1 ? '' : 's'})`,
  ]
  for (const t of list.filter(t => t.status === 'current')) lines.push(`En curso: #${t.id} ${t.title}`)
  const marked = list.filter(t => t.willClose && t.status === 'done')
  if (marked.length > 0) lines.push(`Se cierran con el próximo push a ${branch}: ${marked.map(t => `#${t.id}`).join(', ')}`)
  const manual = list.filter(t => !t.willClose && t.status === 'done')
  if (manual.length > 0) lines.push(`Con "${DONE}" puesta a mano (no se cierran solos): ${manual.map(t => `#${t.id}`).join(', ')}`)
  if (!snapshot.isFresh) lines.push(await read($, problem))
  return lines.join('\n')
}

// --- Agentes trabajando ---

// Cuándo arrancó cada agente, por id (solo los que el mod vio arrancar)
const startedAt = new Map<string, number>()
const ACTIVE = new Set(['pending', 'running', 'waiting'])

async function loadAgents($: EngineInterface): Promise<void> {
  const list = await $.agent.list()
  const rows: AgentRow[] = list
    .filter(a => ACTIVE.has(a.status))
    .map(a => ({ id: a.id, type: a.type, description: a.description, status: a.status as AgentRow['status'], since: startedAt.get(a.id) }))
  const before = await read($, agents)
  // Sin agentes antes ni ahora no hay nada que redibujar
  if (rows.length === 0 && before.length === 0) return
  await update($, agents, () => rows)
}

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

const AGENT_ICON: Record<AgentRow['status'], string> = { running: '⟳', waiting: '⏸', pending: '…' }
const agentLine = (a: AgentRow, now: number) =>
  [`${AGENT_ICON[a.status]} ${a.type}`, a.description, a.since === undefined ? '' : elapsed(now - a.since)].filter(Boolean).join(' · ')

const HELP = [
  'Comandos de /todo (las tareas son los issues abiertos del repo):',
  '  /todo                  abre o cierra el panel',
  '  /todo close            cierra el panel',
  '  /todo new <título>     crea un issue (o varios: lista con guiones, una por línea)',
  '      --parent N         como subtareas de #N',
  '  /todo link N… P        hace a #N… subtareas de #P (el último número es el padre)',
  '  /todo unlink N…        las suelta de su tarea grande',
  '  /todo start N [M…]     marca en curso (pueden ser varias a la vez)',
  '  /todo done N [M…]      tilda; se cierran cuando la rama principal llega al remoto',
  '  /todo undo N [M…]      vuelve a pendiente (reabre si lo había cerrado el mod)',
  '  /todo remove N [M…]    cierra sin completar',
  '  /todo refresh          relee los issues del remoto (por si cambiaron desde la web)',
  '  /todo sync             pusheaste la rama principal por fuera: cierra los tildados',
  '  /todo status           repo, etiquetas y qué falta cerrar',
  '',
  'Abajo del panel se ven los agentes que están trabajando o esperando.',
].join('\n')

const ID_VERBS = { start: 'start', done: 'done', undo: 'undo', remove: 'remove' } as const

export const register: Register = (on, options) => {
  const label = (value: unknown, fallback: string) => (typeof value === 'string' && value.trim() ? value.trim() : fallback)
  CURRENT = label(options.currentLabel, CURRENT)
  DONE = label(options.doneLabel, DONE)
  CLOSE = label(options.closeLabel, CLOSE)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'todo',
      description: 'Pendientes del proyecto (issues de GitHub/GitLab): panel, crear, empezar, tildar',
      argumentHint: '[close | new [--parent P] <título> | link N P | unlink N | start N | done N | undo N | remove N | refresh | sync | status | help]',
    })
    await $.tool.register({
      name: TOOL,
      isDeferred: false,
      description: [
        'Pendientes del proyecto: son los issues abiertos de su repo en GitHub o GitLab, y el usuario los ve en un panel lateral.',
        'Usala cuando el usuario te pida recordar, anotar o agendar algo para después (action "add": crea un issue).',
        'Cuando empieces a trabajar en uno, marcalo en curso ("start"); cuando lo termines, tildalo ("done"):',
        'no lo cierres vos, se cierra solo cuando la rama principal llega al remoto. Puede haber varios en curso a la vez;',
        'si dejás uno sin terminarlo, devolvelo a pendiente ("undo").',
        'Si una tarea grande se divide en partes, creá las partes como subtareas (add con parent) o engánchalas (link): el panel las muestra en árbol.',
        'Los ids son los números de issue. Si no conocés el número, pedí la lista ("list").',
        'Al marcar una en curso, la respuesta trae la descripción del issue: usala como contexto de la tarea.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['add', 'start', 'done', 'undo', 'remove', 'link', 'unlink', 'list'],
            description: 'add: crear issue; start: marcar en curso; done: tildar; undo: volver a pendiente; remove: cerrar sin completar; link: hacer al issue id subtarea de parent; unlink: soltarlo de su tarea grande; list: ver la lista (en árbol)',
          },
          text: { type: 'string', description: `Título corto del issue (${TITLE_MAX} caracteres como máximo), para add` },
          description: { type: 'string', description: 'Descripción del issue, para add: el detalle de lo pedido que no entra en el título' },
          id: { type: 'number', description: 'Número de issue, para start, done, undo, remove, link y unlink' },
          parent: { type: 'number', description: 'Número de la tarea grande: para add (crearlo como subtarea) y para link' },
        },
        required: ['action'],
      },
    })

    // La lista llega de la red: no frena el arranque
    void serial(() => refresh($))
      .then(({ list }) => {
        // Solo se abre solo si hay algo sin tildar; si no, se pide con /todo
        if (list.some(t => t.status !== 'done')) void openPane($)
      })
      .catch(() => undefined)
    $.clock.every(REFRESH_MS, () => void serial(() => refresh($)).catch(() => undefined))
    await loadAgents($).catch(() => undefined)
    $.clock.every(AGENTS_MS, () => void loadAgents($).catch(() => undefined))

    return next(e)
  })

  // Un comando de Bash que pudo ser un push: si después la rama principal del remoto la movió un
  // push (según el reflog), cierra los tildados. Así no cuentan stash push, --dry-run, pushes
  // fallidos o en segundo plano, los de otra rama u otro repo, ni un pull/fetch en el mismo comando
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const mayPush = /\bgit\b/.test(e.command) && /\bpush\b/.test(e.command)
    const before = mayPush ? await pushedTip($) : undefined
    const ran = await next(e)
    if (before !== undefined && ran.deny === undefined && ran.isError !== true) {
      void (async () => {
        const after = await pushedTip($)
        if (after === undefined || after.sha === before.sha) return
        if (!(await movedByPush($, before.ref, before.sha))) return
        const text = await serial(() => closeMarked($))
        if (text) $.ui.toast(`Pendientes: ${text}`)
      })().catch(() => undefined)
    }
    return ran
  }).catch(($, e, next) => next(e))

  // Un agente que arranca o termina se ve en el panel enseguida
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.agentId !== undefined) {
      startedAt.set(r.agentId, await $.clock.now())
      await loadAgents($).catch(() => undefined)
    }
    return r
  }).catch(($, e, next) => next(e))
  on('classic.SubagentStop', async ($, e, next) => {
    const r = await next(e)
    void loadAgents($).catch(() => undefined)
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__pendientes__pendientes' }, async ($, e) => {
    const input = e as unknown as { action: Action | 'link' | 'unlink'; text?: string; description?: string; id?: number; parent?: number }
    if (input.action === 'list') {
      const snapshot = await serial(() => refresh($))
      return { result: snapshot.isFresh ? describe(snapshot.list) : await stale($, snapshot) }
    }
    const isIssueNumber = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0
    if (input.parent !== undefined && !isIssueNumber(input.parent)) return { result: 'parent tiene que ser un número de issue.' }
    if (input.action === 'add') {
      return { result: await serial(() => addTasks($, [input.text ?? ''], input.description ?? '', input.parent)) }
    }
    if (!isIssueNumber(input.id)) return { result: 'Falta el número de issue (id).' }
    if (input.action === 'link' || input.action === 'unlink') {
      if (input.action === 'link' && typeof input.parent !== 'number') return { result: 'Falta el número de la tarea grande (parent).' }
      const id = input.id
      const parent = input.action === 'link' ? input.parent : undefined
      return { result: await serial(() => linkTasks($, [id], parent)) }
    }
    const action = input.action
    const id = input.id
    const changed = await serial(() => changeTasks($, action, [id]))
    return { result: [changed.text, ...changed.context].join('\n\n') }
  }).catch(() => ({ result: 'El mod de pendientes falló al procesar el pedido.' }))

  on('command.run', { command: 'todo' }, async ($, e) => {
    const args = e.args.trim()
    const verb = (/^\S*/.exec(args)?.[0] ?? '').toLowerCase()
    const rest = args.slice(verb.length).trim()

    if (verb === '') {
      // /todo alterna; un panel que quedó esperando sin dibujarse cuenta como cerrado
      const pane = (await $.ui.panes()).find(p => p.id === PANE)
      if (pane !== undefined && pane.isPlaced) {
        await $.ui.close({ id: PANE })
        return { text: 'Panel de pendientes cerrado.' }
      }
      await openPane($)
      void serial(() => refresh($)).catch(() => undefined)
      return { text: 'Panel de pendientes abierto.' }
    }
    if (verb === 'help') return { text: HELP }
    if (verb === 'status') return { text: await serial(() => status($)) }
    if (verb === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'Panel de pendientes cerrado.' }
    }
    if (verb === 'new') {
      const flag = /(^|\s)--parent(?:=|\s+)#?(\d+)(?=\s|$)/.exec(rest)
      const parent = flag === null ? undefined : Number(flag[2])
      const titles = parseTitles(flag === null ? rest : rest.replace(flag[0], flag[1]))
      return { text: await serial(() => addTasks($, titles, '', parent)) }
    }
    if (verb === 'link' || verb === 'unlink') {
      const nums = rest.split(/[\s,#]+/).filter(w => /^\d+$/.test(w)).map(Number)
      if (verb === 'unlink' && nums.length > 0) return { text: await serial(() => linkTasks($, nums, undefined)) }
      if (verb === 'link' && nums.length > 1) return { text: await serial(() => linkTasks($, nums.slice(0, -1), nums[nums.length - 1])) }
    }
    if (verb === 'refresh') {
      const snapshot = await serial(() => refresh($))
      if (!snapshot.isFresh) return { text: await stale($, snapshot) }
      const open = snapshot.list.filter(t => t.status !== 'done').length
      const n = snapshot.list.length
      return { text: `Lista actualizada: ${n} issue${n === 1 ? '' : 's'} abierto${n === 1 ? '' : 's'} (${open} sin tildar).` }
    }
    if (verb === 'sync') return { text: (await serial(() => closeMarked($))) || 'No hay tildados esperando cierre.' }

    const action = (ID_VERBS as Record<string, keyof typeof ID_VERBS | undefined>)[verb]
    const ids = rest.split(/[\s,#]+/).filter(w => /^\d+$/.test(w)).map(Number)
    if (action !== undefined && ids.length > 0) {
      const changed = await serial(() => changeTasks($, action, ids))
      return changed.context.length > 0 ? { text: changed.text, context: changed.context } : { text: changed.text }
    }

    return { text: `No entendí "/todo ${args}".\n\n${HELP}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const all = await read($, tasks)
    const issue = await read($, problem)
    const open = all.filter(t => t.status !== 'done').length
    // Arriba del prompt (terminal angosta) va compacto: sin las tildadas y con poco alto
    const isInline = e.props.placement === 'inline'
    // Sin las tildadas antes de armar el árbol: un hijo de una tildada pasa a raíz, no queda colgando
    const rows = treeRows(isInline ? all.filter(t => t.status !== 'done') : all)

    // Todo se mide en filas con el ancho real: un título largo ocupa varias. Si el contenido fuera
    // más alto que el panel, el panel se desplaza y lo de arriba (la tarea en curso) queda oculto
    // Abajo, los agentes que están trabajando o esperando (si hay)
    const working = await read($, agents)
    const now = working.length > 0 ? await $.clock.now() : 0
    const showAgents = working.length > 0
    const width = Math.max(10, e.props.bodyColumns ?? WIDTH)
    const height = isInline ? INLINE_ROWS : (e.viewport?.rows ?? 24) - 4
    const fixed = 2 + (issue !== '' ? 1 : 0) // encabezado y "… y N más"
    const heightOf = ({ task: t, depth }: (typeof rows)[number]) =>
      isInline ? 1 : wrapRows(`○ #${t.id} ${t.title}`, width - depth * 2).length
    const heights = rows.map(heightOf)

    // Los agentes van abajo, debajo de las primeras tareas; si no entran todos, "… y N más"
    const MIN_TASKS = 3
    const minTaskRows = heights.slice(0, MIN_TASKS).reduce((a, b) => a + b, 0)
    let agentRows: string[] = []
    if (showAgents && !isInline) {
      const fits = Math.max(1, height - fixed - minTaskRows - 2)
      const lines = working.map(a => agentLine(a, now))
      agentRows = lines.length <= fits ? lines : [...lines.slice(0, fits - 1), `… y ${lines.length - fits + 1} más`]
    }
    const footer = !showAgents ? 0 : isInline ? 1 : 2 + agentRows.length

    // Entran las tareas que caben en lo que queda, en orden (la que está en curso va primero)
    let budget = height - fixed - footer
    let room = 0
    while (room < rows.length && heights[room] <= budget) budget -= heights[room++]
    room = Math.max(1, room)

    return (
      // Al costado ocupa todo el alto, así los agentes quedan al fondo
      <Box flexDirection="column" minHeight={isInline ? undefined : height}>
        <Text dimColor>
          {open} pendiente{open === 1 ? '' : 's'} · {all.length - open} tildada{all.length - open === 1 ? '' : 's'}
        </Text>
        {issue !== '' && <Text color="warning">{issue}</Text>}
        {all.length === 0 && issue === '' && (
          <Text dimColor>Sin issues abiertos. Pedime que anote algo, {'o usá /todo new <título>.'}</Text>
        )}
        {rows.slice(0, room).map(({ task: t, depth }) => (
          // Las subtareas van con sangría debajo de su tarea grande
          <Box key={String(t.id)} paddingLeft={depth * 2}>
            {t.status === 'current' ? (
              <Text color="claude" bold>
                ▶ #{t.id} {t.title}
              </Text>
            ) : t.status === 'done' ? (
              <Text dimColor strikethrough>
                <Text color="success">✓</Text> #{t.id} {t.title}
              </Text>
            ) : (
              <Text>
                ○ #{t.id} {t.title}
              </Text>
            )}
          </Box>
        ))}
        {rows.length > room && <Text dimColor>… y {rows.length - room} más</Text>}
        {showAgents && isInline && (
          <Box key="agents">
            <Text wrap="truncate-end">
              <Text bold>{working.length === 1 ? 'Agente: ' : `${working.length} agentes: `}</Text>
              {working.map(a => agentLine(a, now)).join('  ·  ')}
            </Text>
          </Box>
        )}
        {showAgents && !isInline && (
          <Box key="agents" flexDirection="column" flexGrow={1} justifyContent="flex-end">
            <Text dimColor>{'─'.repeat(width)}</Text>
            <Text>
              <Text bold>Agentes trabajando</Text>
              <Text dimColor>{`  ${working.length}`}</Text>
            </Text>
            {agentRows.map(row => (
              <Text wrap="truncate-end">{row}</Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
