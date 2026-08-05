import type { ParamDef, ParamValues } from '@cwe/shared'

/** 解析 image 参数实际值:job 值缺失回退模板 default(与执行器取值逻辑一致);非字符串返回空串 */
export function imageParamValue(def: ParamDef, values: ParamValues): string {
  const v = values[def.key] ?? def.default
  return typeof v === 'string' ? v : ''
}

/** 过滤出可对比的 image 参数(解析值为非空字符串),保持模板定义顺序 */
export function imageParamsOf(defs: ParamDef[], values: ParamValues): ParamDef[] {
  return defs.filter((p) => p.type === 'image' && imageParamValue(p, values) !== '')
}
