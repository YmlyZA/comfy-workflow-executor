const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** 从 ComfyUI 生成的 PNG 提取内嵌元数据(tEXt/iTXt chunk 的 prompt=API 格式、workflow=UI 格式) */
export function extractComfyMetadata(buf: ArrayBuffer): { prompt?: string; workflow?: string } {
  const bytes = new Uint8Array(buf)
  if (bytes.length < 8 || PNG_SIG.some((b, i) => bytes[i] !== b)) return {}
  const view = new DataView(buf)
  const out: { prompt?: string; workflow?: string } = {}

  let pos = 8
  while (pos + 8 <= bytes.length) {
    const length = view.getUint32(pos)
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8))
    const dataStart = pos + 8
    if (dataStart + length > bytes.length) break
    if (type === 'IEND') break

    if (type === 'tEXt' || type === 'iTXt') {
      const data = bytes.subarray(dataStart, dataStart + length)
      const nul = data.indexOf(0)
      if (nul > 0) {
        const keyword = new TextDecoder('latin1').decode(data.subarray(0, nul))
        if (keyword === 'prompt' || keyword === 'workflow') {
          let text: string | undefined
          if (type === 'tEXt') {
            text = new TextDecoder('latin1').decode(data.subarray(nul + 1))
          } else if (data[nul + 1] === 0) {
            // iTXt 未压缩:keyword\0 compFlag compMethod lang\0 translated\0 text
            let p = data.indexOf(0, nul + 3)
            if (p !== -1) p = data.indexOf(0, p + 1)
            if (p !== -1) text = new TextDecoder().decode(data.subarray(p + 1))
          }
          if (text) out[keyword] = text
        }
      }
    }
    pos = dataStart + length + 4 // 跳过 CRC
  }
  return out
}
