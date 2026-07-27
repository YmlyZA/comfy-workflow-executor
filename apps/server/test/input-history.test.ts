import { EventEmitter } from 'node:events'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDb, type Db } from '../src/db/index.js'
import { inputHistory } from '../src/db/schema.js'

let db: Db
let app: ReturnType<typeof createApp>
const H = { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }

function makeApp(dbi: Db, extraEnv: Record<string, string> = {}) {
  return createApp({
    config: loadConfig({ AUTH_TOKEN: 'secret', ...extraEnv }),
    db: dbi,
    comfy: null,
    events: new EventEmitter(),
  })
}

beforeEach(() => {
  db = createDb(':memory:')
  app = makeApp(db)
})

const templateBody = {
  name: 'T',
  comfyJson: {
    '3': { class_type: 'KSampler', inputs: { steps: 4 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'x' } },
  },
  params: [
    { key: 'prompt', label: 'Prompt', nodeId: '6', inputName: 'text', type: 'text' },
    { key: 'steps', label: 'Steps', nodeId: '3', inputName: 'steps', type: 'number' },
  ],
}

async function createTemplate(a = app) {
  const res = await a.request('/api/templates', {
    method: 'POST',
    headers: H,
    body: JSON.stringify(templateBody),
  })
  expect(res.status).toBe(201)
  return (await res.json()) as { id: number }
}

async function createBatch(templateId: number, jobs: Array<Record<string, unknown>>, a = app) {
  const res = await a.request(`/api/templates/${templateId}/batches`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ name: 'B', jobs }),
  })
  expect(res.status).toBe(201)
}

async function getHistory(key: string, a = app): Promise<string[]> {
  const res = await a.request(`/api/input-history?key=${encodeURIComponent(key)}`, { headers: H })
  expect(res.status).toBe(200)
  return ((await res.json()) as { values: string[] }).values
}

describe('input history', () => {
  it('建批记录 text 值,最近使用在前', async () => {
    const t = await createTemplate()
    await createBatch(t.id, [{ prompt: 'a', steps: 1 }, { prompt: 'b' }])
    expect(await getHistory('prompt')).toEqual(['b', 'a'])
  })

  it('仅 text 参数入历史', async () => {
    const t = await createTemplate()
    await createBatch(t.id, [{ prompt: 'a', steps: 7 }])
    expect(await getHistory('steps')).toEqual([])
  })

  it('空白与非 string 值不记录', async () => {
    const t = await createTemplate()
    await createBatch(t.id, [{ prompt: '' }, { prompt: '   ' }, { prompt: 5 }])
    expect(await getHistory('prompt')).toEqual([])
  })

  it('同批重复只记一次,跨批 upsert 刷新排序与计数', async () => {
    const t = await createTemplate()
    await createBatch(t.id, [{ prompt: 'x' }, { prompt: 'x' }])
    let rows = db.select().from(inputHistory).where(eq(inputHistory.paramKey, 'prompt')).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.useCount).toBe(1)
    await createBatch(t.id, [{ prompt: 'y' }])
    await createBatch(t.id, [{ prompt: 'x' }])
    rows = db.select().from(inputHistory).where(eq(inputHistory.paramKey, 'prompt')).all()
    expect(rows.find((r) => r.value === 'x')!.useCount).toBe(2)
    expect(await getHistory('prompt')).toEqual(['x', 'y'])
  })

  it('超过 INPUT_HISTORY_LIMIT 按最近使用修剪', async () => {
    const smallDb = createDb(':memory:')
    const smallApp = makeApp(smallDb, { INPUT_HISTORY_LIMIT: '3' })
    const t = await createTemplate(smallApp)
    for (const v of ['a', 'b', 'c', 'd']) {
      await createBatch(t.id, [{ prompt: v }], smallApp)
    }
    expect(await getHistory('prompt', smallApp)).toEqual(['d', 'c', 'b'])
    const rows = smallDb.select().from(inputHistory).all()
    expect(rows).toHaveLength(3)
  })

  it('GET 缺 key 返回 400', async () => {
    const res = await app.request('/api/input-history', { headers: H })
    expect(res.status).toBe(400)
  })

  it('DELETE 删除单条,幂等,缺参 400', async () => {
    const t = await createTemplate()
    await createBatch(t.id, [{ prompt: 'a' }, { prompt: 'b' }])
    const del = await app.request(
      `/api/input-history?key=prompt&value=${encodeURIComponent('a')}`,
      { method: 'DELETE', headers: H },
    )
    expect(del.status).toBe(200)
    expect(await getHistory('prompt')).toEqual(['b'])
    const again = await app.request(
      `/api/input-history?key=prompt&value=${encodeURIComponent('a')}`,
      { method: 'DELETE', headers: H },
    )
    expect(again.status).toBe(200)
    const missing = await app.request('/api/input-history?key=prompt', {
      method: 'DELETE',
      headers: H,
    })
    expect(missing.status).toBe(400)
  })
})
