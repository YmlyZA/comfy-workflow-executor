export type Theme = 'light' | 'dark' | 'system'

export const THEME_STORAGE_KEY = 'cwe-theme'

export function parseTheme(raw: string | null): Theme {
  return raw === 'light' || raw === 'dark' ? raw : 'system'
}

export function resolveTheme(pref: Theme, systemDark: boolean): 'light' | 'dark' {
  if (pref === 'system') return systemDark ? 'dark' : 'light'
  return pref
}
