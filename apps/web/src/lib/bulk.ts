import type { BatchStatus } from '@cwe/shared'

export interface BulkResult {
  ok: number
  failed: Array<{ name: string; message: string }>
}

/** api() 抛出的 Error message 是响应体 JSON 文本,提取其中的 error 字段 */
export function apiErrorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  try {
    const parsed = JSON.parse(msg) as { error?: string }
    return parsed.error ?? msg
  } catch {
    return msg
  }
}

/** 并发执行,部分失败不中断其余项 */
export async function runBulk<T>(
  items: T[],
  name: (item: T) => string,
  fn: (item: T) => Promise<unknown>,
): Promise<BulkResult> {
  const settled = await Promise.allSettled(items.map(fn))
  const failed: BulkResult['failed'] = []
  settled.forEach((s, i) => {
    if (s.status === 'rejected') failed.push({ name: name(items[i]!), message: apiErrorText(s.reason) })
  })
  return { ok: items.length - failed.length, failed }
}

export function summarizeBulk(action: string, r: BulkResult): string {
  if (r.failed.length === 0) return `${action}成功 ${r.ok} 个`
  const detail = r.failed.map((f) => `${f.name}(${f.message})`).join('、')
  return `${action}成功 ${r.ok} 个，失败 ${r.failed.length} 个：${detail}`
}

/** 选中批次决定批量按钮启停 */
export function batchBulkActions(
  selected: Array<{ status: BatchStatus; failed: number }>,
): { cancel: boolean; retry: boolean; del: boolean } {
  return {
    cancel: selected.some((b) => b.status === 'pending' || b.status === 'running'),
    retry: selected.some((b) => b.failed > 0),
    del: selected.length > 0,
  }
}
