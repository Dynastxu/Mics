/**
 * `@mics/build-secrets` 由 scripts/build-plugins.mjs 在构建期生成
 * （node_modules/.mics/build-secrets.js，别名见 makeViteAliases）。
 *
 * 这里只声明形状；真实值来自构建环境变量 MICS_CURSEFORGE_API_KEY，
 * 不存在于源码中，也不能用 `pnpm typecheck` 推断出来。
 */
declare module '@mics/build-secrets' {
  /** 构建时 MICS_CURSEFORGE_API_KEY 的值；未配置时为空串 */
  export const CURSEFORGE_API_KEY: string
}
