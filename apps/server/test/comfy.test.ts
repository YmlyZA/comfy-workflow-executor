import { describe, expect, it } from 'vitest'
import { extractOutputRefs } from '../src/comfy/client.js'

describe('extractOutputRefs', () => {
  it('collects file refs across nodes and array keys', () => {
    const refs = extractOutputRefs({
      outputs: {
        '9': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] },
        '12': {
          gifs: [{ filename: 'b.webp', subfolder: 'sub', type: 'output' }],
          text: ['not a file'],
        },
      },
    })
    expect(refs).toEqual([
      { filename: 'a.png', subfolder: '', type: 'output' },
      { filename: 'b.webp', subfolder: 'sub', type: 'output' },
    ])
  })

  it('skips temp previews and empty outputs', () => {
    expect(
      extractOutputRefs({
        outputs: { '9': { images: [{ filename: 't.png', subfolder: '', type: 'temp' }] } },
      }),
    ).toEqual([])
    expect(extractOutputRefs({})).toEqual([])
  })
})
