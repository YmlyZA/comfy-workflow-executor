export interface Config {
  port: number
  dataDir: string
  comfyUrl: string
  authToken: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  let authToken = env.AUTH_TOKEN
  if (!authToken) {
    if (env.NODE_ENV === 'production') throw new Error('AUTH_TOKEN is required in production')
    authToken = 'dev-token'
  }
  return {
    port: Number(env.PORT ?? 8080),
    dataDir: env.DATA_DIR ?? './data',
    comfyUrl: (env.COMFYUI_URL ?? 'http://127.0.0.1:8188').replace(/\/+$/, ''),
    authToken,
  }
}
