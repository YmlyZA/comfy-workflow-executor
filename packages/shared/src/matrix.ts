import type { ParamValues } from './types.js'

export function expandMatrix(axes: Record<string, Array<string | number>>): ParamValues[] {
  const keys = Object.keys(axes).filter((k) => (axes[k] ?? []).length > 0)
  if (keys.length === 0) return []
  return keys.reduce<ParamValues[]>(
    (acc, key) => acc.flatMap((row) => (axes[key] ?? []).map((v) => ({ ...row, [key]: v }))),
    [{}],
  )
}
