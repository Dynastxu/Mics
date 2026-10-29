export { validateManifest, isSafeRelativePath } from './manifest'
export type { ValidationResult } from './manifest'
export {
  scanPlugins,
  readPluginDirectory,
  resolveEntry,
  importPluginEntry,
  STAGING_DIR,
} from './discovery'
export type { PluginRoot, PluginDirectoryResult } from './discovery'
export { installPluginFromDirectory, PluginInstallError } from './install'
export type { InstallPluginOptions, InstallPluginResult } from './install'
export {
  runUninstallScript,
  removePluginFiles,
  pluginStorageFile,
  UNINSTALL_TIMEOUT_MS,
} from './uninstall'
export type { UninstallScriptContext, UninstallScript, RunUninstallOptions } from './uninstall'
