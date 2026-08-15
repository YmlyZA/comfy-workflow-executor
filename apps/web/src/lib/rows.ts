import type { ParamValues } from '@cwe/shared'

/**
 * 表格 tab 的一行:id 是稳定标识,只用于 React key 与定位补丁,不进入提交数据。
 * 用行 id 而非数组下标做 key,删行后 React 才会把组件实例跟着行走——否则实例被
 * 复用给下移的行,单元格内部状态(尺寸探测 effect 等)会误覆盖该行手改的值。
 */
export interface EntryRow {
  id: string
  values: ParamValues
}

/** 行 id 发号器:每个表格实例一个,单调递增,不跨实例共享 */
export function createRowIdGen(): () => string {
  let n = 0
  return () => `r${n++}`
}

/** 外部传入的裸值数组(如「以此新建」预填)转成带 id 的行 */
export function toRows(values: ParamValues[], nextId: () => string): EntryRow[] {
  return values.map((v) => ({ id: nextId(), values: v }))
}

/** 提交用:丢掉 id,并过滤全空行 */
export function toJobs(rows: EntryRow[]): ParamValues[] {
  return rows.filter((r) => Object.keys(r.values).length > 0).map((r) => r.values)
}

/** 行内补丁:只重建目标行,其余行对象身份保持不变;无匹配行时连数组身份一起保持(不触发重渲染) */
export function patchRow(rows: EntryRow[], id: string, patch: ParamValues): EntryRow[] {
  if (!rows.some((r) => r.id === id)) return rows
  return rows.map((r) => (r.id === id ? { id: r.id, values: { ...r.values, ...patch } } : r))
}

export function removeRow(rows: EntryRow[], id: string): EntryRow[] {
  return rows.filter((r) => r.id !== id)
}

export function appendRow(rows: EntryRow[], nextId: () => string): EntryRow[] {
  return [...rows, { id: nextId(), values: {} }]
}
