import type { AccountSummary } from '@mics/sdk'

/** 设备码登录：主进程返回给渲染进程的首次信息 */
export interface DeviceLoginStart {
  flowId: string
  /** 展示给用户的验证码，例如 `ABCD-EFGH` */
  userCode: string
  /** 浏览器验证地址 */
  verificationUri: string
  /** 设备码过期时间戳 */
  expiresAt: number
  /** 建议轮询间隔（秒） */
  interval: number
}

/** 设备码登录：每次轮询的结果 */
export interface DeviceLoginPoll {
  status: 'pending' | 'done' | 'error'
  account?: AccountSummary
  error?: string
}
