import { describe, expect, it } from 'vitest'
import { expandMatrix } from '../src/index.js'

describe('expandMatrix', () => {
  it('expands cartesian product in stable order', () => {
    const rows = expandMatrix({ prompt: ['a', 'b'], seed: [1, 2, 3] })
    expect(rows).toHaveLength(6)
    expect(rows[0]).toEqual({ prompt: 'a', seed: 1 })
    expect(rows[5]).toEqual({ prompt: 'b', seed: 3 })
  })

  it('single axis returns one row per value', () => {
    expect(expandMatrix({ prompt: ['x'] })).toEqual([{ prompt: 'x' }])
  })

  it('empty axes object returns empty list', () => {
    expect(expandMatrix({})).toEqual([])
  })

  it('ignores axes with no values', () => {
    expect(expandMatrix({ prompt: ['a'], seed: [] })).toEqual([{ prompt: 'a' }])
  })
})
