export interface ComfyClient {
  isUp(): Promise<boolean>
  interrupt(): Promise<void>
}
