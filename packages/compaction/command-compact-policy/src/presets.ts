/** Literal preset inspection without evaluating Loader-owned expressions. */
import { isJsExpr } from '@deepseek-ai/cordis-plugin-loader'
import { resolveConfig } from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'

/** One editable backend row inside a raw preset's plugin list. */
export interface BasicRow {
  readonly label: string
  readonly row: Record<string, unknown>
  readonly config: BasicCompactionConfig
}

/** Literal backend candidates and skipped branches of one preset. */
export interface PresetScan {
  readonly rows: BasicRow[]
  readonly notes: string[]
}

/**
 * Narrow one raw Loader value to a property record.
 * @param value - raw configuration value.
 * @returns whether the value is a non-array object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Inspect a raw config for expressions without executing them.
 * @param value - raw Loader value, including nested arrays and objects.
 * @returns whether any nested value is a Loader expression.
 */
export function hasExpression(value: unknown): boolean {
  if (isJsExpr(value)) return true
  if (Array.isArray(value)) return value.some(hasExpression)
  return isRecord(value) && Object.values(value).some(hasExpression)
}

/**
 * Inspect literal compaction-basic rows, recursively through ordinary groups.
 * @param config - raw outer agent-preset configuration.
 * @returns editable rows and reasons for skipped branches; invalid literal configs throw.
 */
export function scanPreset(config: Record<string, unknown>): PresetScan {
  const rows: BasicRow[] = []
  const notes: string[] = []
  const walk = (plugins: unknown, parent: string): void => {
    if (!Array.isArray(plugins)) {
      notes.push(`${parent}: skipped ${hasExpression(plugins) ? 'expression' : 'non-literal plugin list'}`)
      return
    }
    for (const [index, value] of plugins.entries()) {
      if (!isRecord(value)) {
        notes.push(`${parent}[${index}]: skipped non-literal row`)
        continue
      }
      const label = `${parent}/${typeof value.id === 'string' ? value.id : index}`
      if (isJsExpr(value.disabled)) {
        notes.push(`${label}: skipped conditional row`)
        continue
      }
      if (value.disabled === true) {
        notes.push(`${label}: skipped disabled row`)
        continue
      }
      if (value.group === true) {
        walk(value.config, label)
        continue
      }
      if (value.name !== '@deepseek-ai/dsh-compaction-basic') continue
      const raw: unknown = value.config ?? {}
      if (hasExpression(raw) || !isRecord(raw)) {
        notes.push(`${label}: skipped ${hasExpression(raw) ? 'expression config' : 'non-literal config'}`)
        continue
      }
      // The backend validates policy values before this literal record is used.
      const config = raw as BasicCompactionConfig
      resolveConfig(config)
      rows.push({ label, row: value, config })
    }
  }
  walk(config.plugins, 'plugins')
  if (rows.length === 0) notes.push('no editable compaction-basic backend')
  return { rows, notes }
}
