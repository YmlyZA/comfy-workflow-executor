import { extname } from 'node:path'

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
}

/** 按扩展名给常见图片 Content-Type,未知回退 octet-stream */
export function imageMime(name: string): string {
  return IMAGE_MIME[extname(name).toLowerCase()] ?? 'application/octet-stream'
}
