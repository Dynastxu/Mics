import path from 'node:path'
import type { PluginContributions, PluginManifest, ViewRegion } from '@mics/sdk'

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
const ACTIVATION_PATTERN = /^(\*|onStartup|onView:.+|onCommand:.+)$/
const REGIONS: ViewRegion[] = ['sidebar', 'main', 'panel']

export interface ValidationResult {
  manifest?: PluginManifest
  errors: string[]
  warnings: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

export function isSafeRelativePath(value: string): boolean {
  if (!value || path.isAbsolute(value)) return false
  return !value
    .replace(/\\/g, '/')
    .split('/')
    .some((segment) => segment === '..')
}

function validateContributions(
  raw: unknown,
  errors: string[],
  warnings: string[],
): PluginContributions | undefined {
  if (raw === undefined) return undefined
  if (!isRecord(raw)) {
    errors.push('contributes 必须是对象')
    return undefined
  }

  const contributions: PluginContributions = {}

  if (raw.views !== undefined) {
    if (!Array.isArray(raw.views)) {
      errors.push('contributes.views 必须是数组')
    } else {
      const views: NonNullable<PluginContributions['views']> = []
      for (const view of raw.views) {
        if (!isRecord(view) || typeof view.id !== 'string' || typeof view.title !== 'string') {
          errors.push('contributes.views 条目需要 id 与 title 字符串')
          continue
        }
        const region = view.region
        if (region !== undefined && !REGIONS.includes(region as ViewRegion)) {
          errors.push(`视图 ${view.id} 的 region 必须是 sidebar/main/panel`)
          continue
        }
        views.push({
          id: view.id,
          title: view.title,
          region: region as ViewRegion | undefined,
          icon: typeof view.icon === 'string' ? view.icon : undefined,
          order: typeof view.order === 'number' ? view.order : undefined,
          group: typeof view.group === 'string' ? view.group : undefined,
        })
      }
      contributions.views = views
    }
  }

  if (raw.commands !== undefined) {
    if (!Array.isArray(raw.commands)) {
      errors.push('contributes.commands 必须是数组')
    } else {
      const commands: NonNullable<PluginContributions['commands']> = []
      for (const command of raw.commands) {
        if (!isRecord(command) || typeof command.id !== 'string' || typeof command.title !== 'string') {
          errors.push('contributes.commands 条目需要 id 与 title 字符串')
          continue
        }
        commands.push({
          id: command.id,
          title: command.title,
          category: typeof command.category === 'string' ? command.category : undefined,
          keybinding: typeof command.keybinding === 'string' ? command.keybinding : undefined,
          icon: typeof command.icon === 'string' ? command.icon : undefined,
        })
      }
      contributions.commands = commands
    }
  }

  if (raw.statusBar !== undefined) {
    if (!Array.isArray(raw.statusBar)) {
      errors.push('contributes.statusBar 必须是数组')
    } else {
      const items: NonNullable<PluginContributions['statusBar']> = []
      for (const item of raw.statusBar) {
        if (!isRecord(item) || typeof item.id !== 'string' || typeof item.text !== 'string') {
          errors.push('contributes.statusBar 条目需要 id 与 text 字符串')
          continue
        }
        const alignment = item.alignment
        if (alignment !== undefined && alignment !== 'left' && alignment !== 'right') {
          errors.push(`状态栏条目 ${item.id} 的 alignment 必须是 left/right`)
          continue
        }
        items.push({
          id: item.id,
          text: item.text,
          alignment: alignment as 'left' | 'right' | undefined,
          order: typeof item.order === 'number' ? item.order : undefined,
          tooltip: typeof item.tooltip === 'string' ? item.tooltip : undefined,
          command: typeof item.command === 'string' ? item.command : undefined,
        })
      }
      contributions.statusBar = items
    }
  }

  if (raw.themes !== undefined) {
    if (!Array.isArray(raw.themes)) {
      errors.push('contributes.themes 必须是数组')
    } else {
      const themes: NonNullable<PluginContributions['themes']> = []
      for (const theme of raw.themes) {
        if (!isRecord(theme) || typeof theme.id !== 'string' || typeof theme.label !== 'string') {
          errors.push('contributes.themes 条目需要 id 与 label 字符串')
          continue
        }
        if (!isRecord(theme.variables)) {
          errors.push(`主题 ${theme.id} 的 variables 必须是对象`)
          continue
        }
        const variables: Record<string, string> = {}
        for (const [key, value] of Object.entries(theme.variables)) {
          if (typeof value !== 'string') {
            warnings.push(`主题 ${theme.id} 的变量 ${key} 不是字符串，已忽略`)
            continue
          }
          variables[key] = value
        }
        const type = theme.type
        if (type !== undefined && type !== 'dark' && type !== 'light') {
          errors.push(`主题 ${theme.id} 的 type 必须是 dark/light`)
          continue
        }
        themes.push({ id: theme.id, label: theme.label, type: type as 'dark' | 'light' | undefined, variables })
      }
      contributions.themes = themes
    }
  }

  if (raw.layout !== undefined) {
    if (!isRecord(raw.layout) || typeof raw.layout.id !== 'string') {
      errors.push('contributes.layout 需要 id')
    } else {
      const regions = raw.layout.regions
      contributions.layout = {
        id: raw.layout.id,
        label: typeof raw.layout.label === 'string' ? raw.layout.label : undefined,
        regions: isRecord(regions)
          ? {
              sidebar: isRecord(regions.sidebar)
                ? {
                    width: typeof regions.sidebar.width === 'number' ? regions.sidebar.width : undefined,
                    defaultView:
                      typeof regions.sidebar.defaultView === 'string'
                        ? regions.sidebar.defaultView
                        : undefined,
                  }
                : undefined,
            }
          : undefined,
      }
    }
  }

  return contributions
}

/** 校验并规范化 plugin.json 内容 */
export function validateManifest(raw: unknown): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  if (!isRecord(raw)) {
    return { errors: ['plugin.json 必须是 JSON 对象'], warnings }
  }

  if (typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) {
    errors.push('id 必须匹配 /^[a-z0-9][a-z0-9._-]*$/')
  }
  if (typeof raw.name !== 'string' || !raw.name.trim()) {
    errors.push('name 必须是非空字符串')
  }
  if (typeof raw.version !== 'string' || !VERSION_PATTERN.test(raw.version)) {
    errors.push('version 必须是 semver 形式，例如 0.1.0')
  }
  if (errors.length) return { errors, warnings }

  const manifest: PluginManifest = {
    id: raw.id as string,
    name: raw.name as string,
    version: raw.version as string,
  }

  if (typeof raw.description === 'string') manifest.description = raw.description
  if (typeof raw.author === 'string') manifest.author = raw.author
  if (typeof raw.homepage === 'string') manifest.homepage = raw.homepage
  if (isStringArray(raw.keywords)) manifest.keywords = raw.keywords
  if (raw.core === true) manifest.core = true

  for (const field of ['main', 'renderer'] as const) {
    const value = raw[field]
    if (value === undefined) continue
    if (typeof value !== 'string' || !isSafeRelativePath(value)) {
      errors.push(`${field} 必须是插件目录内的相对路径`)
      continue
    }
    manifest[field] = value
  }

  if (raw.styles !== undefined) {
    if (!isStringArray(raw.styles) || !raw.styles.every(isSafeRelativePath)) {
      errors.push('styles 必须是插件目录内相对路径组成的数组')
    } else {
      manifest.styles = raw.styles
    }
  }

  if (raw.activation !== undefined) {
    if (!isStringArray(raw.activation) || !raw.activation.every((item) => ACTIVATION_PATTERN.test(item))) {
      errors.push('activation 必须是 * / onStartup / onView:<id> / onCommand:<id> 组成的数组')
    } else {
      manifest.activation = raw.activation as NonNullable<PluginManifest['activation']>
    }
  }

  if (raw.dependencies !== undefined) {
    if (!isStringArray(raw.dependencies) || !raw.dependencies.every((item) => ID_PATTERN.test(item))) {
      errors.push('dependencies 必须是插件 id 组成的数组')
    } else {
      manifest.dependencies = raw.dependencies
    }
  }

  if (raw.permissions !== undefined) {
    if (!isStringArray(raw.permissions)) {
      errors.push('permissions 必须是字符串数组')
    } else {
      manifest.permissions = raw.permissions as NonNullable<PluginManifest['permissions']>
    }
  }

  const contributions = validateContributions(raw.contributes, errors, warnings)
  if (contributions) manifest.contributes = contributions

  return errors.length ? { errors, warnings } : { manifest, errors, warnings }
}
