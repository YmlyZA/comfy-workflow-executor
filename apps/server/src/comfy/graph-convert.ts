import type { ObjectInfoMap } from './client.js'

export interface GraphNode {
  id: number
  type: string
  /** 0=正常 2=muted(never) 4=bypassed */
  mode?: number
  title?: string
  inputs?: Array<{ name: string; type: string | number; link: number | null; widget?: { name: string } }>
  outputs?: Array<{ name: string; type: string | number; links?: number[] | null }>
  widgets_values?: unknown[] | Record<string, unknown>
}

/** [linkId, srcNodeId, srcSlot, dstNodeId, dstSlot, type] */
export type GraphLink = [number, number, number, number, number, unknown]

export interface GraphJson {
  nodes: GraphNode[]
  links: Array<GraphLink | null>
}

export class ConvertError extends Error {
  constructor(
    message: string,
    readonly missingTypes: string[] = [],
  ) {
    super(message)
  }
}

/** 前端虚拟节点:不进执行图 */
const VIRTUAL_TYPES = new Set(['Reroute', 'PrimitiveNode', 'Note', 'MarkdownNote'])
/** object_info 中会渲染为 widget 的标量类型(数组=COMBO 枚举) */
const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO'])

const MODE_MUTED = 2
const MODE_BYPASSED = 4

interface WidgetSlot {
  name: string
  /** seed 的 control_after_generate、LoadImage 的 image_upload 等伪 widget 会在 widgets_values 里多占一位 */
  extraSlot: boolean
}

function widgetSlots(def: ObjectInfoMap[string]): WidgetSlot[] {
  const out: WidgetSlot[] = []
  for (const section of [def.input?.required, def.input?.optional]) {
    for (const [name, spec] of Object.entries(section ?? {})) {
      const type = spec?.[0]
      const opts = (spec?.[1] ?? {}) as Record<string, unknown>
      const isWidget = Array.isArray(type) || (typeof type === 'string' && WIDGET_TYPES.has(type))
      if (!isWidget) continue
      const extraSlot =
        Boolean(opts.control_after_generate) ||
        Boolean(opts.image_upload) ||
        (type === 'INT' && (name === 'seed' || name === 'noise_seed'))
      out.push({ name, extraSlot })
    }
  }
  return out
}

type Source = { link: [string, number] } | { value: unknown } | null

/** 沿 Reroute/Primitive/bypass 链回溯连线的真实源;muted 或断链返回 null */
function resolveSource(
  nodeById: Map<number, GraphNode>,
  linkById: Map<number, GraphLink>,
  linkId: number,
  seen: Set<number>,
): Source {
  if (seen.has(linkId)) return null
  seen.add(linkId)
  const link = linkById.get(linkId)
  if (!link) return null
  const [, srcId, srcSlot] = link
  const src = nodeById.get(srcId)
  if (!src || src.mode === MODE_MUTED) return null
  if (src.type === 'Reroute') {
    const upstream = src.inputs?.[0]?.link
    return upstream == null ? null : resolveSource(nodeById, linkById, upstream, seen)
  }
  if (src.type === 'PrimitiveNode') {
    const wv = src.widgets_values
    return { value: Array.isArray(wv) ? wv[0] : wv }
  }
  if (src.mode === MODE_BYPASSED) {
    const outType = src.outputs?.[srcSlot]?.type
    const passthrough = src.inputs?.find((i) => i.type === outType && i.link != null)
    return passthrough?.link == null
      ? null
      : resolveSource(nodeById, linkById, passthrough.link, seen)
  }
  return { link: [String(srcId), srcSlot] }
}

export function convertGraphToApi(
  graph: GraphJson,
  objectInfo: ObjectInfoMap,
): Record<string, any> {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]))
  const linkById = new Map<number, GraphLink>()
  for (const l of graph.links ?? []) if (l) linkById.set(l[0], l)

  const real = graph.nodes.filter(
    (n) => !VIRTUAL_TYPES.has(n.type) && n.mode !== MODE_MUTED && n.mode !== MODE_BYPASSED,
  )
  const missing = [...new Set(real.filter((n) => !objectInfo[n.type]).map((n) => n.type))]
  if (missing.length > 0) {
    throw new ConvertError(`服务器缺少节点类型定义: ${missing.join(', ')}`, missing)
  }

  const api: Record<string, any> = {}
  for (const node of real) {
    const def = objectInfo[node.type]!
    const inputs: Record<string, unknown> = {}

    // Collect widgets converted to inputs (new frontend omits them from widgets_values)
    const converted = new Set(
      (node.inputs ?? [])
        .filter((inp) => inp.widget?.name)
        .map((inp) => inp.widget!.name)
    )

    const slots = widgetSlots(def)
    const fullLen = slots.reduce((a, s) => a + (s.extraSlot ? 2 : 1), 0)
    // New frontend (2025-04+): omits converted widgets from array; length < fullLen detects this
    const skipConverted = converted.size > 0 && node.widgets_values instanceof Array && node.widgets_values.length < fullLen

    const wv = node.widgets_values
    if (Array.isArray(wv)) {
      let i = 0
      for (const w of slots) {
        // Skip converted widgets in new frontend behavior (don't advance i, don't write)
        if (skipConverted && converted.has(w.name)) {
          continue
        }
        if (i >= wv.length) break
        inputs[w.name] = wv[i]
        i += w.extraSlot ? 2 : 1
      }
    } else if (wv && typeof wv === 'object') {
      Object.assign(inputs, wv)
    }

    for (const inp of node.inputs ?? []) {
      if (inp.link == null) continue
      const src = resolveSource(nodeById, linkById, inp.link, new Set())
      if (src === null) {
        delete inputs[inp.name]
        continue
      }
      inputs[inp.name] = 'value' in src ? src.value : src.link
    }

    api[String(node.id)] = {
      class_type: node.type,
      inputs,
      _meta: { title: node.title ?? node.type },
    }
  }
  return api
}
