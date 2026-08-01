export interface Config {
  port: number
  dataDir: string
  comfyUrl: string
  authToken: string
  inputHistoryLimit: number
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  let authToken = env.AUTH_TOKEN
  if (!authToken) {
    if (env.NODE_ENV === 'production') throw new Error('AUTH_TOKEN is required in production')
    authToken = 'dev-token'
  }
  return {
    // 显式设置的 PORT 非法时报错退出,静默回退默认值只会让人找不到服务在哪
    port: (() => {
      if (env.PORT === undefined) return 8080
      const n = Number(env.PORT)
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`PORT 非法: ${env.PORT}`)
      return n
    })(),
    dataDir: env.DATA_DIR ?? './data',
    comfyUrl: (env.COMFYUI_URL ?? 'http://127.0.0.1:8188').replace(/\/+$/, ''),
    authToken,
    inputHistoryLimit: (() => {
      const n = Number(env.INPUT_HISTORY_LIMIT ?? 100)
      return Number.isInteger(n) && n > 0 ? n : 100
    })(),
  }
}
