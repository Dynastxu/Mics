import type { MicsBridge } from './contract/bridge'

declare global {
  interface Window {
    /** 由 preload/contextBridge 注入 */
    mics: MicsBridge
  }
}

export {}
