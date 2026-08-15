import { describe, expect, it } from 'vitest'
import { THEME_COLORS, parseTheme, resolveTheme, themeColor } from './theme'

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

describe('themeColor', () => {
  it('应用内强制的主题优先于系统(媒体查询版 theme-color 修不了的那个 case)', () => {
    expect(themeColor('dark', false)).toBe(THEME_COLORS.dark)
    expect(themeColor('light', true)).toBe(THEME_COLORS.light)
  })
  it('system 跟随系统', () => {
    expect(themeColor('system', true)).toBe(THEME_COLORS.dark)
    expect(themeColor('system', false)).toBe(THEME_COLORS.light)
  })
})
