import type { Context } from 'cordis'
import { defineMainPlugin } from '@mics/sdk/main'
import type { InstanceSummary } from './shared'

const INSTANCES: InstanceSummary[] = [
  {
    id: 'fabric-adventure',
    name: '冒险生存',
    minecraft: '1.21.4',
    loader: 'Fabric 0.16.9',
    mods: 42,
    lastPlayed: '2 小时前',
  },
  {
    id: 'forge-tech',
    name: '机械纪元',
    minecraft: '1.20.1',
    loader: 'Forge 47.3.0',
    mods: 186,
    lastPlayed: '昨天',
  },
  {
    id: 'vanilla',
    name: '原版生存',
    minecraft: '1.21.5',
    loader: '原版',
    mods: 0,
    lastPlayed: '3 天前',
  },
]

export const name = 'mics.launch'
export const inject = ['ipc']

/**
 * 骨架阶段只提供实例清单，真正的版本隔离、Java 探测与启动流程都不在这里。
 * 数据放主进程，渲染端通过 ctx.ipc.invoke('mics.launch', 'instances/list') 读取。
 */
export function apply(ctx: Context): void {
  ctx.ipc.handle('instances/list', () => INSTANCES)
}

export default defineMainPlugin({ name, inject, apply })
