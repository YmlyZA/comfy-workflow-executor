import type { ParamDef, ParamValues } from './types.js'

export function buildPrompt(
  comfyJson: Record<string, any>,
  params: ParamDef[],
  values: ParamValues,
): Record<string, any> {
  const prompt = structuredClone(comfyJson)
  for (const def of params) {
    const value = values[def.key] ?? def.default
    if (value === undefined) throw new Error(`missing value for param "${def.key}"`)
    const node = prompt[def.nodeId]
    if (!node) throw new Error(`node ${def.nodeId} not found for param "${def.key}"`)
    node.inputs[def.inputName] =
      def.type === 'number' || def.type === 'seed' ? Number(value) : value
  }
  return prompt
}
