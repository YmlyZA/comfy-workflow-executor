import type { ParamType } from '@cwe/shared'

export interface SuggestedParam {
  nodeId: string
  inputName: string
  key: string
  type: ParamType
}

const TEXT_ENCODE_TYPES = new Set(['CLIPTextEncode', 'CLIPTextEncodeSDXL'])

/** 导入后自动预选的高价值参数:正/负提示词(经采样器连线回溯)与 seed */
export function suggestParams(json: Record<string, any>): SuggestedParam[] {
  const out: SuggestedParam[] = []
  const seen = new Set<string>()
  const used = new Map<string, number>()

  const push = (nodeId: string, inputName: string, base: string, type: ParamType) => {
    const id = `${nodeId}.${inputName}`
    if (seen.has(id)) return
    seen.add(id)
    const n = (used.get(base) ?? 0) + 1
    used.set(base, n)
    out.push({ nodeId, inputName, key: n === 1 ? base : `${base}_${n}`, type })
  }

  // 1. 采样器的 positive/negative 连线 → CLIPTextEncode.text
  for (const node of Object.values(json)) {
    if (!/KSampler/.test(String(node?.class_type))) continue
    for (const role of ['positive', 'negative'] as const) {
      const link = node.inputs?.[role]
      if (!Array.isArray(link)) continue
      const targetId = String(link[0])
      const target = json[targetId]
      if (!target || !TEXT_ENCODE_TYPES.has(String(target.class_type))) continue
      if (typeof target.inputs?.text !== 'string') continue
      push(targetId, 'text', role === 'positive' ? 'prompt' : 'negative_prompt', 'text')
    }
  }

  // 2. 数值型 seed 输入
  for (const [nodeId, node] of Object.entries(json)) {
    for (const [inputName, value] of Object.entries(
      (node?.inputs ?? {}) as Record<string, unknown>,
    )) {
      if (typeof value === 'number' && inputName.toLowerCase().includes('seed')) {
        push(nodeId, inputName, 'seed', 'seed')
      }
    }
  }

  return out
}
