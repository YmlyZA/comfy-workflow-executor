import { describe, expect, it } from 'vitest'
import { parseTheme, resolveTheme } from './theme'

describe('parseTheme', () => {
  it('合法值原样返回', () => {
    expect(parseTheme('light')).toBe('light')
    expect(parseTheme('dark')).toBe('dark')
    expect(parseTheme('system')).toBe('system')
  })
  it('null/非法值回退 system', () => {
    expect(parseTheme(null)).toBe('system')
    expect(parseTheme('')).toBe('system')
    expect(parseTheme('blue')).toBe('system')
  })
})

describe('resolveTheme', () => {
  it('显式 light/dark 不受系统影响', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })
  it('system 跟随系统', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })
})
