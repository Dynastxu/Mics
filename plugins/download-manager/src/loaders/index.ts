import { isLoaderSourceKind } from '@mics/sdk'
import type { LoaderSourceKind, LoaderVersion } from '@mics/sdk'
import { fabricProvider } from './fabric'
import { forgeProvider, neoforgeProvider } from './forge'
import type { LoaderEnvironment, LoaderInstallInput, LoaderInstallPlan, LoaderProvider } from './types'

const PROVIDERS: Record<LoaderSourceKind, LoaderProvider> = {
  fabric: fabricProvider,
  forge: forgeProvider,
  neoforge: neoforgeProvider,
}

export function loaderProvider(kind: LoaderSourceKind): LoaderProvider {
  return PROVIDERS[kind]
}

/** IPC 入参来自渲染进程，运行时仍需把加载器类型限制在已知范围 */
export function safeLoaderKind(value: unknown): LoaderSourceKind | null {
  return isLoaderSourceKind(value) ? value : null
}

export function listLoaderVersions(
  kind: LoaderSourceKind,
  gameVersion: string,
  env: LoaderEnvironment,
): Promise<LoaderVersion[]> {
  return loaderProvider(kind).listVersions(gameVersion, env)
}

export function prepareLoaderInstall(
  kind: LoaderSourceKind,
  input: LoaderInstallInput,
  env: LoaderEnvironment,
): Promise<LoaderInstallPlan> {
  return loaderProvider(kind).install(input, env)
}
