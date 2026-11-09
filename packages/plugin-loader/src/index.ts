export { validateManifest, isSafeRelativePath } from './manifest'
export type { ValidationResult } from './manifest'
export { validatePermissions } from './permissions'
export {
  scanPlugins,
  readPluginDirectory,
  resolveEntry,
  importPluginEntry,
  STAGING_DIR
} from './discovery'
export type { PluginRoot, PluginDirectoryResult, ReadPluginOptions, ScanOptions } from './discovery'
export { installPluginFromDirectory, PluginInstallError } from './install'
export type { InstallPluginOptions, InstallPluginResult } from './install'
export {
  runUninstallScript,
  removePluginFiles,
  pluginStorageFile,
  UNINSTALL_TIMEOUT_MS
} from './uninstall'
export type { UninstallScriptContext, UninstallScript, RunUninstallOptions } from './uninstall'
export { buildPluginTree, mainEntryUrl } from './tree'
export type { PluginTreeEntry, BuildPluginTreeOptions } from './tree'
