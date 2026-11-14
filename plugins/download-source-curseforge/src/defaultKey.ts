import { CURSEFORGE_API_KEY } from '@mics/build-secrets'

/**
 * 构建期注入的 CurseForge 默认 API Key。
 *
 * 值来自构建脚本读到的 `MICS_CURSEFORGE_API_KEY`（本地 `.env.local` 或 CI
 * secret），源码与仓库里都不出现真实值；空串表示这次构建没有默认 Key。
 *
 * 只在用户没有填写 Key、且接口是官方地址时使用：自建代理换了 hostname，
 * 不能把官方 Key 交给它。
 */
export const BUILD_CURSEFORGE_API_KEY = CURSEFORGE_API_KEY.trim()
