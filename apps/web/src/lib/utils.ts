import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** DB 的 datetime('now') 是无时区标记的 UTC 串;补 Z 后按本地时区格式化 */
export function formatUtcDateTime(s: string): string {
  const d = new Date(`${s.replace(' ', 'T')}Z`)
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString('zh-CN', { hour12: false })
}
