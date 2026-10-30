import type { Context } from 'cordis'
import { defineRendererPlugin } from '@mics/sdk/renderer'
import AccountView from './AccountView.vue'

export const name = 'mics.account'
export const inject = ['ui', 'ipc']

export function apply(ctx: Context): void {
  ctx.ui.registerView('account', AccountView)
}

export default defineRendererPlugin({ name, inject, apply })
