import { describe, expect, it } from 'vitest'
import { extractComfyMetadata } from './png-meta'

/** 手工构造最小 PNG:签名 + 若干 chunk + IEND(解析器不校验 CRC,填 0) */
function makePng(chunks: Array<{ type: string; data: Uint8Array }>): ArrayBuffer {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const parts: Uint8Array[] = [sig]
  for (const { type, data } of [...chunks, { type: 'IEND', data: new Uint8Array(0) }]) {
    const head = new Uint8Array(8)
    new DataView(head.buffer).setUint32(0, data.length)
    for (let i = 0; i < 4; i++) head[4 + i] = type.charCodeAt(i)
    parts.push(head, data, new Uint8Array(4)) // 尾部 4 字节假 CRC
  }
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let pos = 0
  for (const p of parts) {
    out.set(p, pos)
    pos += p.length
  }
  return out.buffer
}

function textChunk(keyword: string, text: string): { type: string; data: Uint8Array } {
  const enc = new TextEncoder()
  const kw = enc.encode(keyword)
  const body = enc.encode(text)
  const data = new Uint8Array(kw.length + 1 + body.length)
  data.set(kw, 0)
  data[kw.length] = 0
  data.set(body, kw.length + 1)
  return { type: 'tEXt', data }
}

function itxtChunk(keyword: string, text: string): { type: string; data: Uint8Array } {
  const enc = new TextEncoder()
  const kw = enc.encode(keyword)
  const body = enc.encode(text)
  // keyword\0 compFlag(0) compMethod(0) lang\0 translated\0 text
  const data = new Uint8Array(kw.length + 5 + body.length)
  data.set(kw, 0)
  // kw.length..kw.length+4 均为 0
  data.set(body, kw.length + 5)
  return { type: 'iTXt', data }
}

describe('extractComfyMetadata', () => {
  it('提取 tEXt 中的 prompt 与 workflow', () => {
    const png = makePng([
      textChunk('prompt', '{"1":{}}'),
      textChunk('workflow', '{"nodes":[]}'),
    ])
    expect(extractComfyMetadata(png)).toEqual({ prompt: '{"1":{}}', workflow: '{"nodes":[]}' })
  })

  it('提取 iTXt(未压缩)', () => {
    const png = makePng([itxtChunk('prompt', '{"2":{}}')])
    expect(extractComfyMetadata(png)).toEqual({ prompt: '{"2":{}}' })
  })

  it('忽略无关 keyword', () => {
    const png = makePng([textChunk('parameters', 'sd-webui 格式')])
    expect(extractComfyMetadata(png)).toEqual({})
  })

  it('非 PNG 返回空对象', () => {
    expect(extractComfyMetadata(new TextEncoder().encode('not a png').buffer as ArrayBuffer)).toEqual({})
  })

  it('截断的 chunk 不越界', () => {
    const good = makePng([textChunk('prompt', '{"1":{}}')])
    const truncated = good.slice(0, (good.byteLength / 2) | 0)
    expect(() => extractComfyMetadata(truncated)).not.toThrow()
  })
})
