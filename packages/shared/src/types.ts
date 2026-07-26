import { z } from 'zod'

export const paramTypeSchema = z.enum(['text', 'number', 'seed', 'image', 'enum'])
export type ParamType = z.infer<typeof paramTypeSchema>

/** enum 参数指向的 object_info 输入(用于批量填参时拉取可选值) */
export const enumRefSchema = z.object({
  classType: z.string().min(1),
  inputName: z.string().min(1),
})
export type EnumRef = z.infer<typeof enumRefSchema>

export const paramDefSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  nodeId: z.string().min(1),
  inputName: z.string().min(1),
  type: paramTypeSchema,
  enumRef: enumRefSchema.optional(),
  default: z.union([z.string(), z.number()]).optional(),
})
export type ParamDef = z.infer<typeof paramDefSchema>

export const paramValuesSchema = z.record(z.string(), z.union([z.string(), z.number()]))
export type ParamValues = z.infer<typeof paramValuesSchema>

export const createTemplateSchema = z.object({
  name: z.string().min(1),
  comfyJson: z.record(z.string(), z.any()),
  params: z.array(paramDefSchema).min(1),
})
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>

export const createBatchSchema = z.object({
  name: z.string().min(1),
  jobs: z.array(paramValuesSchema).min(1),
})
export type CreateBatchInput = z.infer<typeof createBatchSchema>

export const batchStatusSchema = z.enum(['pending', 'running', 'completed', 'canceled'])
export type BatchStatus = z.infer<typeof batchStatusSchema>

export const jobStatusSchema = z.enum(['pending', 'running', 'succeeded', 'failed', 'canceled'])
export type JobStatus = z.infer<typeof jobStatusSchema>

export interface OutputFile {
  /** 相对 outputs 根目录的路径，如 "3/0-cat-00001.png" */
  path: string
  filename: string
  /** GPU 侧引用(type 恒为 output 不存);旧数据无此字段 → GPU 侧删除跳过 */
  gpu?: { filename: string; subfolder: string }
}
