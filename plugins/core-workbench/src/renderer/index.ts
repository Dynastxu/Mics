import type { Context } from 'cordis'
import { defineRendererPlugin } from '@mics/sdk/renderer'
import WelcomeView from './WelcomeView.vue'

export const name = 'mics.core-workbench'
export const inject = ['ui', 'plugins']

export function apply(ctx: Context): void {
  ctx.ui.registerView('workbench.welcome', WelcomeView)
}

export default defineRendererPlugin({ name, inject, apply })
