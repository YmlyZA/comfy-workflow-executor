export type Theme = 'light' | 'dark' | 'system'

export const THEME_STORAGE_KEY = 'cwe-theme'

export function parseTheme(raw: string | null): Theme {
  return raw === 'light' || raw === 'dark' ? raw : 'system'
}

export function resolveTheme(pref: Theme, systemDark: boolean): 'light' | 'dark' {
  if (pref === 'system') return systemDark ? 'dark' : 'light'
  return pref
}

/**
 * 浏览器 UI 色(Android 状态栏 / PWA 标题栏)。
 * 同一组值在 index.html 的防闪烁内联脚本里另有一份(那里无法 import),改动需两处同步。
 */
export const THEME_COLORS: Record<'light' | 'dark', string> = {
  light: '#f8fafc',
  dark: '#020617',
}

/** 应用内主题偏好决定浏览器 UI 色——强制深色时即便系统是浅色也要给深色 */
export function themeColor(pref: Theme, systemDark: boolean): string {
  return THEME_COLORS[resolveTheme(pref, systemDark)]
}
