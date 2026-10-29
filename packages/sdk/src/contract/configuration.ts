import type { PluginId } from './manifest'

/**
 * 清单里的配置 schema（JSON Schema 的一个子集）。
 *
 * 只覆盖设置页真正需要的几类值：字符串、数字、整数、布尔与枚举。
 * 复杂结构（例如下载源的数组对象）继续由插件自己的设置页处理，
 * 但读写仍然经过 `ctx.storage`，因此会继承这里的默认值与校验。
 */

export type ConfigurationValue = string | number | boolean

export type ConfigurationType = 'string' | 'number' | 'integer' | 'boolean' | 'enum'

export interface ConfigurationOption {
  value: string | number
  label?: string
}

export interface ConfigurationProperty {
  type: ConfigurationType
  title?: string
  description?: string
  default?: ConfigurationValue
  /** 仅 number / integer 有效 */
  minimum?: number
  /** 仅 number / integer 有效 */
  maximum?: number
  /** 仅 enum 有效 */
  options?: ConfigurationOption[]
  /** 数值单位，例如 MB、秒；只用于展示 */
  unit?: string
}

export interface ConfigurationContribution {
  title?: string
  description?: string
  properties: Record<string, ConfigurationProperty>
}

/** 当前值的来源：用户保存、profile 默认、schema 默认，或尚未设置 */
export type ConfigurationSource = 'user' | 'profile' | 'default'

export interface ConfigurationPropertyInfo extends ConfigurationProperty {
  key: string
  value?: ConfigurationValue
  source: ConfigurationSource | 'unset'
}

/** 某个插件的配置说明与当前值；设置页与 agent 共用这一份 */
export interface PluginConfigurationInfo {
  pluginId: PluginId
  name: string
  title?: string
  description?: string
  properties: ConfigurationPropertyInfo[]
}

export type ConfigurationValueResult =
  | { ok: true; value: ConfigurationValue }
  | { ok: false; error: string }

const TYPES = new Set<ConfigurationType>(['string', 'number', 'integer', 'boolean', 'enum'])
const KEY_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$.-]*$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPrimitive(value: unknown): value is ConfigurationValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

/** 按 schema 归一化一个值；数字类允许数字字符串，布尔允许 'true'/'false' */
export function normalizeConfigurationValue(
  property: ConfigurationProperty,
  raw: unknown,
): ConfigurationValueResult {
  switch (property.type) {
    case 'string':
      if (typeof raw === 'string') return { ok: true, value: raw }
      return { ok: false, error: '需要字符串' }
    case 'boolean':
      if (typeof raw === 'boolean') return { ok: true, value: raw }
      if (raw === 'true') return { ok: true, value: true }
      if (raw === 'false') return { ok: true, value: false }
      return { ok: false, error: '需要布尔值' }
    case 'number':
    case 'integer': {
      const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN
      if (!Number.isFinite(value)) return { ok: false, error: '需要数字' }
      if (property.type === 'integer' && !Number.isInteger(value)) {
        return { ok: false, error: '需要整数' }
      }
      if (property.minimum !== undefined && value < property.minimum) {
        return { ok: false, error: `不能小于 ${property.minimum}` }
      }
      if (property.maximum !== undefined && value > property.maximum) {
        return { ok: false, error: `不能大于 ${property.maximum}` }
      }
      return { ok: true, value }
    }
    case 'enum': {
      const options = property.options ?? []
      const matched = options.find((option) => option.value === raw)
      if (matched) return { ok: true, value: matched.value }
      if (typeof raw === 'string' && raw.trim()) {
        const numeric = Number(raw)
        if (Number.isFinite(numeric)) {
          const byNumber = options.find((option) => option.value === numeric)
          if (byNumber) return { ok: true, value: byNumber.value }
        }
      }
      return { ok: false, error: '不在允许的选项里' }
    }
  }
}

/** schema 的默认值（已按类型归一化）；没有默认值时返回 undefined */
export function defaultConfigurationValue(
  property: ConfigurationProperty,
): ConfigurationValue | undefined {
  return property.default
}

/** 校验并规范化 `contributes.configuration` */
export function validateConfigurationContribution(raw: unknown): {
  configuration?: ConfigurationContribution
  errors: string[]
  warnings: string[]
} {
  const errors: string[] = []
  const warnings: string[] = []

  if (!isRecord(raw)) {
    errors.push('contributes.configuration 必须是对象')
    return { errors, warnings }
  }

  if (raw.title !== undefined && typeof raw.title !== 'string') {
    errors.push('configuration.title 必须是字符串')
  }
  if (raw.description !== undefined && typeof raw.description !== 'string') {
    errors.push('configuration.description 必须是字符串')
  }
  if (!isRecord(raw.properties)) {
    errors.push('configuration.properties 必须是对象')
    return { errors, warnings }
  }

  const properties: Record<string, ConfigurationProperty> = {}
  for (const [key, value] of Object.entries(raw.properties)) {
    const errorsBefore = errors.length
    if (!KEY_PATTERN.test(key)) {
      errors.push(`配置键 ${key} 不合法`)
      continue
    }
    if (!isRecord(value)) {
      errors.push(`配置 ${key} 必须是对象`)
      continue
    }
    if (typeof value.type !== 'string' || !TYPES.has(value.type as ConfigurationType)) {
      errors.push(`配置 ${key}.type 必须是 ${[...TYPES].join(' / ')}`)
      continue
    }
    const type = value.type as ConfigurationType
    const property: ConfigurationProperty = { type }

    if (value.title !== undefined) {
      if (typeof value.title !== 'string') errors.push(`配置 ${key}.title 必须是字符串`)
      else property.title = value.title
    }
    if (value.description !== undefined) {
      if (typeof value.description !== 'string') {
        errors.push(`配置 ${key}.description 必须是字符串`)
      } else property.description = value.description
    }
    if (value.unit !== undefined) {
      if (typeof value.unit !== 'string') errors.push(`配置 ${key}.unit 必须是字符串`)
      else property.unit = value.unit
    }

    if (value.minimum !== undefined) {
      if (typeof value.minimum !== 'number' || !Number.isFinite(value.minimum)) {
        errors.push(`配置 ${key}.minimum 必须是数字`)
      } else if (type !== 'number' && type !== 'integer') {
        errors.push(`配置 ${key}.minimum 只对 number / integer 有效`)
      } else property.minimum = value.minimum
    }
    if (value.maximum !== undefined) {
      if (typeof value.maximum !== 'number' || !Number.isFinite(value.maximum)) {
        errors.push(`配置 ${key}.maximum 必须是数字`)
      } else if (type !== 'number' && type !== 'integer') {
        errors.push(`配置 ${key}.maximum 只对 number / integer 有效`)
      } else property.maximum = value.maximum
    }
    if (
      property.minimum !== undefined &&
      property.maximum !== undefined &&
      property.minimum > property.maximum
    ) {
      errors.push(`配置 ${key} 的 minimum 不能大于 maximum`)
    }

    if (type === 'enum') {
      if (!Array.isArray(value.options) || value.options.length === 0) {
        errors.push(`配置 ${key}.options 必须是非空数组`)
      } else {
        const options: ConfigurationOption[] = []
        const seen = new Set<string>()
        for (const option of value.options) {
          if (
            !isRecord(option) ||
            (typeof option.value !== 'string' && typeof option.value !== 'number')
          ) {
            errors.push(`配置 ${key}.options 的条目需要 string / number 的 value`)
            continue
          }
          const id = JSON.stringify(option.value)
          if (seen.has(id)) {
            warnings.push(`配置 ${key}.options 存在重复值 ${id}，已忽略`)
            continue
          }
          seen.add(id)
          if (option.label !== undefined && typeof option.label !== 'string') {
            errors.push(`配置 ${key}.options 的 label 必须是字符串`)
            continue
          }
          options.push({
            value: option.value,
            label: typeof option.label === 'string' ? option.label : undefined,
          })
        }
        property.options = options
      }
    } else if (value.options !== undefined) {
      errors.push(`配置 ${key}.options 只对 enum 有效`)
    }

    if (value.default !== undefined) {
      if (!isPrimitive(value.default)) {
        errors.push(`配置 ${key}.default 必须是 string / number / boolean`)
      } else {
        const normalized = normalizeConfigurationValue(property, value.default)
        if (!normalized.ok) errors.push(`配置 ${key}.default 无效：${normalized.error}`)
        else property.default = normalized.value
      }
    }

    if (errors.length === errorsBefore) properties[key] = property
  }
  const configuration: ConfigurationContribution = { properties }
  if (typeof raw.title === 'string') configuration.title = raw.title
  if (typeof raw.description === 'string') configuration.description = raw.description
  return { configuration, errors, warnings }
}
