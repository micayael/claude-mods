// La versión corta guardada por /resumen para el proyecto de la sesión; null si no hay
export type Corto = string | null

declare module 'claude-code' {
  interface PluginState {
    resumen: {
      corto: Corto
      // Rama de git del proyecto; '' fuera de un repo
      rama: string
      // Si la banda se muestra (la elección se guarda en $.store)
      visible: boolean
    }
  }
}
