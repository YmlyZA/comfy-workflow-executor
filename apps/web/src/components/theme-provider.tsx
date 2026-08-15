import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { parseTheme, resolveTheme, THEME_COLORS, THEME_STORAGE_KEY, type Theme } from '@/lib/theme'

interface ThemeContextValue {
  theme: Theme
  resolved: 'light' | 'dark'
  setTheme: (t: Theme) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function readStored(): Theme {
  try {
    return parseTheme(localStorage.getItem(THEME_STORAGE_KEY))
  } catch {
    return 'system' // 隐私模式等 localStorage 不可用:不持久化,仅本次生效
  }
}

const media = () => window.matchMedia('(prefers-color-scheme: dark)')

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStored)
  const [systemDark, setSystemDark] = useState(() => media().matches)

  useEffect(() => {
    const m = media()
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    m.addEventListener('change', onChange)
    return () => m.removeEventListener('change', onChange)
  }, [])

  const resolved = resolveTheme(theme, systemDark)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolved === 'dark')
    // index.html 里那两条 theme-color 由 prefers-color-scheme 驱动,应用内强制主题时会跟错;
    // JS 就位后由这里统一接管(静态那两条只作首帧兜底)。
    const color = THEME_COLORS[resolved]
    document
      .querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
      .forEach((m) => (m.content = color))
  }, [resolved])

  const setTheme = (t: Theme) => {
    setThemeState(t)
    try {
      localStorage.setItem(THEME_STORAGE_KEY, t)
    } catch {
      /* 存不进就只在内存里生效 */
    }
  }

  return (
    <ThemeContext.Provider value={{ theme, resolved, setTheme }}>{children}</ThemeContext.Provider>
  )
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme 必须在 ThemeProvider 内使用')
  return ctx
}
