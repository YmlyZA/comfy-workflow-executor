import { api } from './api'

export type PromptRow = { id: number; key: string; content: string; updatedAt: string }

export function fetchPrompts() {
  return api<{ prompts: PromptRow[] }>('/prompts')
}
