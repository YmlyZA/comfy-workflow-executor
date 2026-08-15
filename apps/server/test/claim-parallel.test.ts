import { describe, expect, it } from 'vitest'
import { createDb } from '../src/db/index.js'
import * as repo from '../src/db/repo.js'

const TEMPLATE = {
  name: 't',
  comfyJson: { '1': { class_type: 'X', inputs: {} } },
  params: [{ key: 'p', label: 'p', nodeId: '1', inputName: 'seed', type: 'seed' as const }],
}

function setup() {
  const db = createDb(':memory:')
  const tpl = repo.createTemplate(db, TEMPLATE)
  const a = repo.createHost(db, { name: 'A', url: 'http://a:8188' })
  const b = repo.createHost(db, { name: 'B', url: 'http://b:8188' })
  return { db, tpl, a, b }
}

describe('claimNextJob 按主机认领', () => {
  it('两台主机各领一个,不重不漏', () => {
    const { db, tpl, a, b } = setup()
    repo.createBatch(db, tpl.id, { name: 'x', jobs: [{ p: 1 }, { p: 2 }] })
    const first = repo.claimNextJob(db, a.id)
    const second = repo.claimNextJob(db, b.id)
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(first!.job.id).not.toBe(second!.job.id)
    expect(first!.job.hostId).toBe(a.id)
    expect(second!.job.hostId).toBe(b.id)
    expect(repo.claimNextJob(db, a.id)).toBeUndefined()
  })

  it('锁定批次只被指定主机认领', () => {
    const { db, tpl, a, b } = setup()
    repo.createBatch(db, tpl.id, { name: 'pinned', jobs: [{ p: 1 }] }, b.id)
    expect(repo.claimNextJob(db, a.id)).toBeUndefined()
    const claimed = repo.claimNextJob(db, b.id)
    expect(claimed?.job.hostId).toBe(b.id)
  })

  it('锁定批次不挡住后面的非锁定批次', () => {
    const { db, tpl, a, b } = setup()
    repo.createBatch(db, tpl.id, { name: 'pinned', jobs: [{ p: 1 }] }, b.id)
    repo.createBatch(db, tpl.id, { name: 'free', jobs: [{ p: 2 }] })
    // A 跳过锁定给 B 的批次,直接取后面那个
    const claimed = repo.claimNextJob(db, a.id)
    expect(claimed?.job.params).toEqual({ p: 2 })
  })
})

describe('resetJobToPending', () => {
  it('回池时清空 host_id(pending 任务不该声称属于某台主机)', () => {
    const { db, tpl, a } = setup()
    repo.createBatch(db, tpl.id, { name: 'x', jobs: [{ p: 1 }] })
    const claimed = repo.claimNextJob(db, a.id)!
    repo.resetJobToPending(db, claimed.job.id)
    const after = repo.getJob(db, claimed.job.id)!
    expect(after.status).toBe('pending')
    expect(after.hostId).toBeNull()
    expect(after.comfyPromptId).toBeNull()
  })
})

describe('reclaimOrphanJobs', () => {
  it('重置无主的 running job,保留活跃主机的', () => {
    const { db, tpl, a, b } = setup()
    repo.createBatch(db, tpl.id, { name: 'x', jobs: [{ p: 1 }, { p: 2 }] })
    const onA = repo.claimNextJob(db, a.id)!
    const onB = repo.claimNextJob(db, b.id)!
    const n = repo.reclaimOrphanJobs(db, [a.id]) // 只有 A 还活着
    expect(n).toBe(1)
    expect(repo.getJob(db, onB.job.id)!.status).toBe('pending')
    expect(repo.getJob(db, onA.job.id)!.status).toBe('running')
  })

  it('host_id 为 NULL 的历史 running job 也回收', () => {
    const { db, tpl, a } = setup()
    repo.createBatch(db, tpl.id, { name: 'x', jobs: [{ p: 1 }] })
    const claimed = repo.claimNextJob(db, a.id)!
    // 模拟历史数据:running 但没盖主机章
    db.$client.prepare(`UPDATE jobs SET host_id = NULL WHERE id = ?`).run(claimed.job.id)
    expect(repo.reclaimOrphanJobs(db, [a.id])).toBe(1)
  })
})

describe('主机启停', () => {
  it('停用写入原因,启用清空原因', () => {
    const { db, a } = setup()
    repo.setHostEnabled(db, a.id, false, '连续 3 次任务失败')
    let host = repo.getHost(db, a.id)!
    expect(host.enabled).toBe(0)
    expect(host.disabledReason).toBe('连续 3 次任务失败')
    repo.setHostEnabled(db, a.id, true)
    host = repo.getHost(db, a.id)!
    expect(host.enabled).toBe(1)
    expect(host.disabledReason).toBeNull()
  })

  it('listEnabledHosts 只返回参与调度的', () => {
    const { db, a, b } = setup()
    repo.setHostEnabled(db, b.id, false, 'x')
    expect(repo.listEnabledHosts(db).map((h) => h.id)).toEqual([a.id])
  })
})

describe('countPinnedUnfinishedBatches', () => {
  it('只数未完成的锁定批次', () => {
    const { db, tpl, b } = setup()
    const open = repo.createBatch(db, tpl.id, { name: 'open', jobs: [{ p: 1 }] }, b.id)
    const done = repo.createBatch(db, tpl.id, { name: 'done', jobs: [{ p: 2 }] }, b.id)
    db.$client.prepare(`UPDATE batches SET status='completed' WHERE id = ?`).run(done.id)
    expect(repo.countPinnedUnfinishedBatches(db, b.id)).toBe(1)
    expect(open.pinnedHostId).toBe(b.id)
  })
})
