import { createApp } from 'vue'
import * as Vue from 'vue'
import * as Cordis from 'cordis'
import App from './App.vue'
import { boot } from './runtime/context'
import { store } from './runtime/store'
import './assets/main.css'

/**
 * 插件产物是独立构建的 ESM，构建时把 vue / cordis 外部化为
 * 指向下面两个全局变量的 shim，从而保证与 shell 使用同一份运行时
 * （Service / Context / 响应式系统的身份必须一致）。
 */
interface MicsGlobals {
  __MICS_VUE__?: typeof Vue
  __MICS_CORDIS__?: typeof Cordis
}

const globals = globalThis as unknown as MicsGlobals
globals.__MICS_VUE__ = Vue
globals.__MICS_CORDIS__ = Cordis

createApp(App).mount('#app')

boot().catch((error: unknown) => {
  store.bootError = error instanceof Error ? error.message : String(error)
})
