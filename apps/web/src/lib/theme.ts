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
 * 同一组值另有两处副本,改动需三处同步:index.html 的防闪烁内联脚本(那里无法 import)、
 * public/manifest.webmanifest 的 theme_color/background_color(静态文件,无法跟随应用内主题——
 * 已安装 PWA 的启动画面与任务切换器配色因此始终是浅色,属已知限制)。
 */
export const THEME_COLORS: Record<'light' | 'dark', string> = {
  light: '#f8fafc',
  dark: '#020617',
}

/** 应用内主题偏好决定浏览器 UI 色——强制深色时即便系统是浅色也要给深色 */
export function themeColor(pref: Theme, systemDark: boolean): string {
  return THEME_COLORS[resolveTheme(pref, systemDark)]
}
