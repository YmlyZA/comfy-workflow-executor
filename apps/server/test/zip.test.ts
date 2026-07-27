import { createWriteStream, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import archiver from 'archiver'
import { describe, expect, it } from 'vitest'
import { extractZip, safeEntryPath } from '../src/zip.js'

/** 打一个内存构造的 zip 到临时文件,返回路径 */
async function buildZip(entries: Array<{ name: string; content: string }>): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'cwe-zip-'))
  const zipPath = join(dir, 'test.zip')
  const archive = archiver('zip')
  const done = pipeline(archive, createWriteStream(zipPath))
  for (const e of entries) archive.append(e.content, { name: e.name })
  await archive.finalize()
  await done
  return zipPath
}

describe('safeEntryPath', () => {
  it('合法相对路径原样(规范化)通过', () => {
    expect(safeEntryPath('a.txt')).toBe('a.txt')
    expect(safeEntryPath('sub/b.txt')).toBe(join('sub', 'b.txt'))
  })

  it('绝对路径与越界路径拒绝', () => {
    expect(safeEntryPath('/abs.txt')).toBeNull()
    expect(safeEntryPath('C:/win.txt')).toBeNull()
    expect(safeEntryPath('../up.txt')).toBeNull()
    expect(safeEntryPath('a/../../up.txt')).toBeNull()
    expect(safeEntryPath('..')).toBeNull()
    expect(safeEntryPath('a\\..\\..\\up.txt')).toBeNull()
  })
})

describe('extractZip', () => {
  it('往返解压:目录结构与内容一致', async () => {
    const zipPath = await buildZip([
      { name: 'db.sqlite', content: 'not-really-a-db' },
      { name: 'uploads/u.png', content: 'img-bytes' },
      { name: 'outputs/1/o.png', content: 'out-bytes' },
    ])
    const dest = mkdtempSync(join(tmpdir(), 'cwe-extract-'))
    await extractZip(zipPath, dest)
    expect(readFileSync(join(dest, 'db.sqlite'), 'utf8')).toBe('not-really-a-db')
    expect(readFileSync(join(dest, 'uploads', 'u.png'), 'utf8')).toBe('img-bytes')
    expect(readFileSync(join(dest, 'outputs', '1', 'o.png'), 'utf8')).toBe('out-bytes')
  })

  it('zip-slip 条目名 reject', async () => {
    // archiver 会规范化条目名,无法直接造毒 zip;
    // 构造合法 zip 后把 4 字节文件名 'evil' 二进制替换为等长的 '../e'
    // (文件名在 local header 与 central directory 各出现一次,长度字段不变)
    const zipPath = await buildZip([{ name: 'evil', content: 'x' }])
    const patched = Buffer.from(readFileSync(zipPath))
    let idx: number
    while ((idx = patched.indexOf('evil')) !== -1) patched.write('../e', idx)
    const evilPath = join(mkdtempSync(join(tmpdir(), 'cwe-evil-')), 'evil.zip')
    writeFileSync(evilPath, patched)
    const dest = mkdtempSync(join(tmpdir(), 'cwe-extract2-'))
    // yauzl 自带校验先拦(invalid relative path);safeEntryPath 是兜底层——任一层拦下都算防住
    await expect(extractZip(evilPath, dest)).rejects.toThrow(/非法 zip 条目|invalid relative path/)
  })

  it('非 zip 文件 reject', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cwe-notzip-'))
    const notZip = join(dir, 'x.zip')
    writeFileSync(notZip, 'this is not a zip')
    await expect(extractZip(notZip, join(dir, 'out'))).rejects.toThrow()
  })
})
