import { describe, expect, it } from 'vitest'
import { apiErrorText, batchBulkActions, runBulk, summarizeBulk } from './bulk'

describe('apiErrorText', () => {
  it('解析 JSON 响应体错误', () => {
    expect(apiErrorText(new Error('{"error":"batch is running"}'))).toBe('batch is running')
  })
  it('非 JSON 原样返回', () => {
    expect(apiErrorText(new Error('network down'))).toBe('network down')
  })
})

describe('runBulk + summarizeBulk', () => {
  it('全成功', async () => {
    const r = await runBulk([1, 2], String, async () => 'ok')
    expect(r).toEqual({ ok: 2, failed: [] })
    expect(summarizeBulk('删除', r)).toBe('删除成功 2 个')
  })
  it('部分失败不中断其余, 汇总含原因', async () => {
    const r = await runBulk([1, 2, 3], (n) => `B${n}`, async (n) => {
      if (n === 2) throw new Error('{"error":"batch is running"}')
    })
    expect(r.ok).toBe(2)
    expect(r.failed).toEqual([{ name: 'B2', message: 'batch is running' }])
    expect(summarizeBulk('删除', r)).toBe('删除成功 2 个，失败 1 个：B2(batch is running)')
  })
})

describe('batchBulkActions', () => {
  it('按选中项状态判定按钮启停', () => {
    expect(batchBulkActions([])).toEqual({ cancel: false, retry: false, del: false })
    expect(batchBulkActions([{ status: 'completed', failed: 0 }])).toEqual({
      cancel: false, retry: false, del: true,
    })
    expect(batchBulkActions([{ status: 'running', failed: 0 }])).toEqual({
      cancel: true, retry: false, del: true,
    })
    expect(
      batchBulkActions([
        { status: 'completed', failed: 2 },
        { status: 'pending', failed: 0 },
      ]),
    ).toEqual({ cancel: true, retry: true, del: true })
  })
})
