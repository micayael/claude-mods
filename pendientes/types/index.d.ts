export type TaskStatus = 'pending' | 'current' | 'done'
// Un issue abierto del repo: current lleva la etiqueta de "en curso", done la de "hecho";
// willClose: tiene la marca del mod para cerrarse con el próximo push a la rama principal
// parent: la tarea grande de la que es parte: la relación nativa (sub-issue de GitHub, Task hija en
// GitLab) o, si no hay, la línea "Parte de #N" de la descripción. nativeParent: solo la nativa.
// isTask: en GitLab, si es de tipo Task (las únicas que pueden ser hijas nativas de un Issue)
export type Task = {
  id: number
  title: string
  status: TaskStatus
  willClose: boolean
  labels: string[]
  parent?: number
  nativeParent?: number
  isTask?: boolean
  // gid: en GitLab, el id global (gid://gitlab/WorkItem/…) para enganchar por GraphQL
  gid?: string
}

// Un agente de la sesión que está trabajando; since: cuándo arrancó (ms), si el mod lo vio arrancar
export type AgentRow = {
  id: string
  type: string
  description: string
  status: 'pending' | 'running' | 'waiting'
  since?: number
}

declare module 'claude-code' {
  interface PluginState {
    pendientes: {
      tasks: Task[]
      // Por qué no hay lista: sin remoto, sin red, sin permisos
      problem: string
      // Los agentes que están trabajando o esperando; se ven abajo del panel
      agents: AgentRow[]
    }
  }
}
