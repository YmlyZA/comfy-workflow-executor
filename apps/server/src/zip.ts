import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join, normalize, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import yauzl from 'yauzl'

/** zip entry 名 → 目标目录内安全相对路径;绝对路径/盘符/越界(..)返回 null */
export function safeEntryPath(name: string): string | null {
  const unified = name.replaceAll('\\', '/')
  if (unified.startsWith('/') || /^[a-zA-Z]:/.test(unified)) return null
  const norm = normalize(unified)
  if (norm === '..' || norm.split(sep).includes('..')) return null
  return norm
}

/** 流式解压 zip 到 destDir;含非法条目名时 reject 且不再继续写 */
export function extractZip(zipPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('zip 打开失败'))
      const fail = (e: Error) => {
        zip.close()
        reject(e)
      }
      zip.on('error', fail)
      zip.on('end', () => resolve())
      zip.on('entry', (entry: yauzl.Entry) => {
        const rel = safeEntryPath(entry.fileName)
        if (rel === null) return fail(new Error(`非法 zip 条目: ${entry.fileName}`))
        const dest = join(destDir, rel)
        if (entry.fileName.endsWith('/')) {
          mkdir(dest, { recursive: true }).then(() => zip.readEntry(), fail)
          return
        }
        zip.openReadStream(entry, (err2, stream) => {
          if (err2 || !stream) return fail(err2 ?? new Error('zip 条目读取失败'))
          mkdir(dirname(dest), { recursive: true })
            .then(() => pipeline(stream, createWriteStream(dest)))
            .then(() => zip.readEntry(), fail)
        })
      })
      zip.readEntry()
    })
  })
}
