export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Usage = {
  tokens: number
  window: number
  percent: number
  limits: Limit[]
  usd?: number
}

export type Cache = { read: number; write: number; fresh: number }

export type Main = { model: string; effort?: string }

export type Agent = {
  id: string
  description: string
  type: string
  model: string
  effort?: string
  tokens: number
  window: number
  isDone: boolean
  startedAt: number
  endedAt?: number
  steps: number
  tools: number
  lastTool?: string
}

declare module 'claude-code' {
  interface PluginState {
    tablero: {
      usage: Shaped<Usage | null>
      cache: Shaped<Cache>
      agents: Shaped<Agent[]>
      cacheAt: Shaped<number | null>
      tick: number
      main: Shaped<Main | null>
    }
  }
}
