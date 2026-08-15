import { describe, expect, it } from 'vitest'
import {
  appendRow,
  createRowIdGen,
  patchRow,
  removeRow,
  toJobs,
  toRows,
  type EntryRow,
} from './rows'

const gen = () => createRowIdGen()

describe('createRowIdGen', () => {
  it('单调递增且同一发号器内不重复', () => {
    const next = gen()
    expect([next(), next(), next()]).toEqual(['r0', 'r1', 'r2'])
  })
})

describe('toRows / toJobs', () => {
  it('裸值数组转行后逐行发 id,值对象身份不变', () => {
    const a = { w: 512 }
    const rows = toRows([a, { h: 768 }], gen())
    expect(rows.map((r) => r.id)).toEqual(['r0', 'r1'])
    expect(rows[0]!.values).toBe(a)
  })

  it('提交时丢掉 id 并过滤全空行', () => {
    const rows: EntryRow[] = [
      { id: 'r0', values: {} },
      { id: 'r1', values: { w: 512 } },
      { id: 'r2', values: {} },
    ]
    expect(toJobs(rows)).toEqual([{ w: 512 }])
  })
})

describe('patchRow', () => {
  it('合并进目标行,不覆盖该行其他键', () => {
    const rows: EntryRow[] = [{ id: 'r0', values: { w: 512, seed: 1 } }]
    expect(patchRow(rows, 'r0', { w: 768, h: 1024 })).toEqual([
      { id: 'r0', values: { w: 768, h: 1024, seed: 1 } },
    ])
  })

  it('其余行对象身份不变(避免无谓重渲染)', () => {
    const other: EntryRow = { id: 'r1', values: { w: 512 } }
    const next = patchRow([{ id: 'r0', values: {} }, other], 'r0', { w: 1 })
    expect(next[1]).toBe(other)
  })

  it('id 不存在时原样返回各行', () => {
    const rows: EntryRow[] = [{ id: 'r0', values: { w: 512 } }]
    expect(patchRow(rows, 'nope', { w: 1 })).toEqual(rows)
  })
})

describe('removeRow', () => {
  it('删中间行后,后续行保留原 id', () => {
    const rows: EntryRow[] = [
      { id: 'r0', values: { img: 'a.png', w: 512 } },
      { id: 'r1', values: { img: 'b.png', w: 768 } },
    ]
    const next = removeRow(rows, 'r0')
    // 关键回归:剩下那行仍是 r1(而非顶到下标 0),React 才不会把 r0 的单元格实例
    // 复用给它——实例复用会让尺寸探测 effect 用新图尺寸覆盖手改的 768。
    expect(next).toEqual([rows[1]])
    expect(next[0]!.id).toBe('r1')
    expect(next[0]).toBe(rows[1])
  })

  it('id 不存在时不删任何行', () => {
    const rows: EntryRow[] = [{ id: 'r0', values: {} }]
    expect(removeRow(rows, 'r9')).toHaveLength(1)
  })
})

describe('appendRow', () => {
  it('追加空行并取新 id,不与既有行冲突', () => {
    const next = gen()
    let rows = toRows([{ w: 1 }], next)
    rows = appendRow(rows, next)
    expect(rows.map((r) => r.id)).toEqual(['r0', 'r1'])
    expect(rows[1]!.values).toEqual({})
  })
})
