# claude-mods

Mods propios para Claude Code, agrupados en el marketplace `micayael-mods`.

| Mod | Qué hace |
| --- | --- |
| `tablero` | Panel lateral y línea arriba del prompt con modelo y esfuerzo, contexto, límites de 5 h y semanal, costo, caché (aciertos y vencimiento) y sub-agentes (modelo, tiempo, pasos, última herramienta). `/tablero` abre o cierra el panel. |
| `pendientes` | Lista de pendientes del proyecto como issues de GitHub o GitLab, en un panel lateral. |
| `resumen` | Resumen del trabajo en curso con `/resumen` y una banda sobre el prompt. Depende de `pendientes`. |
| `separador` | Línea separadora arriba de lo que otros mods dibujan sobre el prompt (solo en terminal). |

## Instalar en otra máquina

```bash
claude plugin marketplace add micayael/claude-mods
claude plugin install tablero@micayael-mods
```

Repetir `claude plugin install` con cada mod que se quiera (`pendientes`, `resumen`, `separador`).

## Actualizar

Después de cambiar un mod, subir `version` en su `.claude-plugin/plugin.json` y correr:

```bash
claude plugin marketplace update micayael-mods
claude plugin update <mod>@micayael-mods
```

## Probar

```bash
claude plugin validate <mod>
claude plugin test <mod>
```
