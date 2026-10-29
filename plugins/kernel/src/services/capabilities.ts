import type { Context } from 'cordis'
import { Service } from 'cordis'
import type {
  CapabilityName,
  CapabilityProviderInfo,
  Disposable,
  PluginId,
  ProvideCapabilityOptions,
} from '@mics/sdk'
import { emitEvent, pluginIdOf } from '@mics/sdk'

interface ProviderRecord {
  impl: unknown
  label: string
  priority: number
  seq: number
  pluginId?: PluginId
}

/**
 * 能力注册表。
 *
 * 一个能力名可以有多份实现（provider）：本地、沙箱、远程……使用方只认能力名，
 * 不认实现。选择规则是「优先级高的赢，同优先级后注册的赢」，因此沙箱插件只要
 * 用更高 priority 注册同名能力，就能整体替换执行方式，调用方一行不用改。
 *
 * 所有权：`provide()` 是通过调用方插件上下文里的 `ctx.effect()` 登记的，
 * 插件卸载时实现自动撤销，并广播 `capability/changed`。
 */
export class CapabilitiesService extends Service {
  static inject: string[] = []

  private readonly baseCtx: Context
  private readonly table = new Map<CapabilityName, ProviderRecord[]>()
  /** 能力名 -> 使用过它的插件；只用于诊断，不参与选择 */
  private readonly usage = new Map<CapabilityName, Set<PluginId>>()
  private seq = 0

  constructor(ctx: Context) {
    super(ctx, 'capabilities')
    this.baseCtx = ctx
  }

  provide<T>(name: CapabilityName, impl: T, options: ProvideCapabilityOptions = {}): Disposable {
    if (!name) throw new Error('[mics] 能力名不能为空')

    const record: ProviderRecord = {
      impl,
      label: options.label ?? 'local',
      priority: options.priority ?? 0,
      seq: ++this.seq,
      pluginId: pluginIdOf(this.ctx),
    }

    const list = this.table.get(name) ?? []
    list.push(record)
    this.table.set(name, list)
    this.baseCtx
      .logger('capabilities')
      .debug(
        '能力 %s 已注册（provider=%s，priority=%d）',
        name,
        record.label,
        record.priority,
      )
    this.notify(name)

    return this.ctx.effect(() => () => {
      const current = this.table.get(name)
      if (!current) return
      const index = current.indexOf(record)
      if (index < 0) return
      current.splice(index, 1)
      if (!current.length) this.table.delete(name)
      this.baseCtx.logger('capabilities').debug('能力 %s 已撤销（provider=%s）', name, record.label)
      this.notify(name)
    })
  }

  get<T>(name: CapabilityName): T | undefined {
    this.track(name)
    return this.pick(name)?.impl as T | undefined
  }

  require<T>(name: CapabilityName): T {
    const impl = this.get<T>(name)
    if (impl !== undefined) return impl

    const known = this.names()
    const hint = known.length ? `已注册的能力：${known.join('、')}` : '当前没有任何能力被注册'
    throw new Error(`能力 ${name} 尚未提供（${hint}）`)
  }

  providers(name: CapabilityName): CapabilityProviderInfo[] {
    return [...(this.table.get(name) ?? [])]
      .sort(compare)
      .map((record) => ({
        name,
        label: record.label,
        priority: record.priority,
        pluginId: record.pluginId,
      }))
  }

  names(): CapabilityName[] {
    return [...this.table.keys()].sort()
  }

  consumers(name: CapabilityName): PluginId[] {
    return [...(this.usage.get(name) ?? [])].sort()
  }

  consumersOf(pluginId: PluginId): CapabilityName[] {
    return [...this.usage.entries()]
      .filter(([, ids]) => ids.has(pluginId))
      .map(([name]) => name)
      .sort()
  }

  /** 插件卸载时清掉它的使用记录；下一次 require 会重新登记 */
  forget(pluginId: PluginId): void {
    for (const [name, ids] of this.usage) {
      ids.delete(pluginId)
      if (!ids.size) this.usage.delete(name)
    }
  }

  onChange(name: CapabilityName, listener: (impl: unknown) => void): Disposable {
    return this.ctx.effect(() => {
      const handler = (changed: CapabilityName): void => {
        if (changed === name) listener(this.get(name))
      }
      return this.baseCtx.on('capability/changed', handler)
    })
  }

  private track(name: CapabilityName): void {
    const id = pluginIdOf(this.ctx)
    if (!id) return
    let ids = this.usage.get(name)
    if (!ids) {
      ids = new Set()
      this.usage.set(name, ids)
    }
    ids.add(id)
  }

  private pick(name: CapabilityName): ProviderRecord | undefined {
    return [...(this.table.get(name) ?? [])].sort(compare)[0]
  }

  private notify(name: CapabilityName): void {
    emitEvent(this.baseCtx, 'capability/changed', name, this.providers(name))
  }
}

/** 优先级降序；同优先级时后注册的在前 */
function compare(a: ProviderRecord, b: ProviderRecord): number {
  return b.priority - a.priority || b.seq - a.seq
}
