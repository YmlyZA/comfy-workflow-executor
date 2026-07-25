import type { ParamType } from '@cwe/shared'

export interface NodeInputRow {
  nodeId: string
  classType: string
  inputName: string
  value: string | number
}

/** API-format JSON → 所有字面量输入（数组值是节点连线，跳过） */
export function parseNodeInputs(json: Record<string, any>): NodeInputRow[] {
  return Object.entries(json).flatMap(([nodeId, node]) => {
    if (!node || typeof node !== 'object' || typeof node.inputs !== 'object' || node.inputs === null) return []
    return Object.entries(node.inputs as Record<string, unknown>)
      .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
      .map(([inputName, value]) => ({
        nodeId,
        classType: String(node.class_type ?? '?'),
        inputName,
        value: value as string | number,
      }))
  })
}

export function guessType(row: NodeInputRow): ParamType {
  if (row.inputName.toLowerCase().includes('seed')) return 'seed'
  if (row.classType === 'LoadImage' && row.inputName === 'image') return 'image'
  if (typeof row.value === 'number') return 'number'
  return 'text'
}

export type WorkflowFormat = 'graph' | 'api' | 'unknown'

/** 区分 ComfyUI 的 UI/graph 导出与 API(prompt)导出 */
export function detectFormat(json: unknown): WorkflowFormat {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return 'unknown'
  const obj = json as Record<string, any>
  if (Array.isArray(obj.nodes) && Array.isArray(obj.links)) return 'graph'
  const nodes = Object.values(obj)
  if (nodes.length > 0 && nodes.every((v) => v && typeof v === 'object' && typeof v.class_type === 'string')) {
    return 'api'
  }
  return 'unknown'
}
