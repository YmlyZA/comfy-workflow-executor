import type { ObjectInfoMap } from './client.js'

export interface ValidationWarning {
  nodeId: string
  classType: string
  inputName: string
  value: string
  message: string
}

export interface EnumInputRef {
  nodeId: string
  classType: string
  inputName: string
}

/** classType.inputName 的枚举可选值;非枚举输入返回 null */
export function enumOptions(
  info: ObjectInfoMap,
  classType: string,
  inputName: string,
): string[] | null {
  const def = info[classType]
  for (const section of [def?.input?.required, def?.input?.optional]) {
    const spec = section?.[inputName]
    if (spec && Array.isArray(spec[0])) return (spec[0] as unknown[]).map(String)
  }
  return null
}

/** 对照 object_info 检查 API 格式 workflow:枚举值存在性 + 节点类型存在性 */
export function validateApiJson(
  comfyJson: Record<string, any>,
  info: ObjectInfoMap,
): { warnings: ValidationWarning[]; enumInputs: EnumInputRef[] } {
  const warnings: ValidationWarning[] = []
  const enumInputs: EnumInputRef[] = []
  for (const [nodeId, node] of Object.entries(comfyJson)) {
    const classType = String(node?.class_type ?? '')
    if (!info[classType]) {
      warnings.push({ nodeId, classType, inputName: '', value: '', message: '节点类型在服务器上不存在' })
      continue
    }
    for (const [inputName, value] of Object.entries(
      (node.inputs ?? {}) as Record<string, unknown>,
    )) {
      if (Array.isArray(value)) continue // 连线
      const options = enumOptions(info, classType, inputName)
      if (!options) continue
      enumInputs.push({ nodeId, classType, inputName })
      if (!options.includes(String(value))) {
        warnings.push({
          nodeId, classType, inputName,
          value: String(value),
          message: '当前值不在服务器可选值中',
        })
      }
    }
  }
  return { warnings, enumInputs }
}
