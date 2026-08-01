import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { ComfyClient, ComfyHistoryEntry, ObjectInfoMap, OutputRef, SystemStats } from '../src/comfy/client.js'

export class FakeComfy implements ComfyClient {
  up = true
  submitted: Array<Record<string, any>> = []
  uploads: string[] = []
  history = new Map<string, ComfyHistoryEntry>()
  queued = new Set<string>()
  /** 每个 promptId 在返回存好的 history 结果之前，getHistory 需要被调用几次（模拟 history 延迟填充） */
  historyDelayPolls = 0
  private pollCounts = new Map<string, number>()
  private n = 0
  /** 每次 submit 后自动写入的 history 结果；null 表示留空（pending 中） */
  nextResult: ComfyHistoryEntry | null = {
    status: { completed: true },
    outputs: { '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } },
  }

  objectInfo: ObjectInfoMap = {}
  objectInfoCalls = 0
  inputImages: Record<string, Buffer> = {}
  cwePingVersion = 2
  outputFiles: Array<{ filename: string; subfolder: string; size: number; mtime: number }> = []
  outputImages: Record<string, Buffer> = {}
  cweDeleted: Array<Array<{ filename: string; subfolder: string }>> = []
  cweDeleteResult: { deleted: number; missing: number; failed: string[] } | null = null
  systemStats: SystemStats = {
    system: { os: 'linux', comfyui_version: '0.3.0', python_version: '3.12' },
    devices: [{ name: 'FakeGPU', vram_total: 8 * 1024 ** 3, vram_free: 4 * 1024 ** 3 }],
  }
  queueCounts = { running: 0, pending: 0 }
  interrupts = 0

  async isUp() {
    return this.up
  }
  async interrupt() {
    this.interrupts++
  }
  async uploadImage(filePath: string) {
    this.uploads.push(filePath)
    return `uploaded-${basename(filePath)}`
  }
  async submit(prompt: Record<string, any>) {
    this.submitted.push(prompt)
    const id = `p${++this.n}`
    if (this.nextResult) {
      this.history.set(id, this.nextResult)
      this.queued.add(id)
    }
    return id
  }
  async getHistory(promptId: string) {
    if (!this.history.has(promptId)) return null
    const count = (this.pollCounts.get(promptId) ?? 0) + 1
    this.pollCounts.set(promptId, count)
    if (count <= this.historyDelayPolls) return null
    const entry = this.history.get(promptId)!
    this.queued.delete(promptId)
    return entry
  }
  async getQueuedIds() {
    return this.queued
  }
  async downloadOutput(_ref: OutputRef, destPath: string) {
    await writeFile(destPath, 'png-bytes')
  }
  async getObjectInfo() {
    this.objectInfoCalls++
    return this.objectInfo
  }
  async getInputImage(name: string): Promise<ArrayBuffer | null> {
    const buf = this.inputImages[name]
    return buf ? (Uint8Array.from(buf).buffer as ArrayBuffer) : null
  }
  async cwePing() {
    return this.cwePingVersion
  }
  async cweListOutputFiles() {
    return this.outputFiles
  }
  async getOutputImage(name: string): Promise<ArrayBuffer | null> {
    const buf = this.outputImages[name]
    return buf ? (Uint8Array.from(buf).buffer as ArrayBuffer) : null
  }
  async cweDeleteOutputFiles(refs: Array<{ filename: string; subfolder: string }>) {
    this.cweDeleted.push(refs)
    return this.cweDeleteResult ?? { deleted: refs.length, missing: 0, failed: [] }
  }
  connectEvents() {
    return () => {}
  }
  async getSystemStats() {
    return this.systemStats
  }
  async getQueueCounts() {
    return this.queueCounts
  }
}
