import { createApp } from 'vue'
import * as Vue from 'vue'
import * as Cordis from 'cordis'
import * as UI from '@mics/ui'
import { iconPlaybackGateKey } from '@mics/ui'
import App from './App.vue'
import { showBootScreen } from './boot-screen'
import { boot, reportBootError } from './runtime/context'
import { installCleanupAudit } from './runtime/cleanupAudit'
import { store } from './runtime/store'
import { startWindowVisibilityTracking, windowVisibilityGate } from './runtime/windowVisibility'
import './assets/main.css'

/**
 * 插件产物是独立构建的 ESM，构建时把 vue / cordis / @mics/ui 外部化为
 * 指向下面三个全局变量的 shim，从而保证与 shell 使用同一份运行时
 * （Service / Context / 响应式系统与 UI 组件的身份必须一致）。
 *
 * @mics/ui 也必须走同一份：否则 6 个目录页各自打包一份 CatalogBrowser，
 * 每个插件产物都要多背 100 KB 以上。
 */
interface MicsGlobals {
  __MICS_VUE__?: typeof Vue
  __MICS_CORDIS__?: typeof Cordis
  __MICS_UI__?: typeof UI
}

const globals = globalThis as unknown as MicsGlobals
globals.__MICS_VUE__ = Vue
globals.__MICS_CORDIS__ = Cordis
globals.__MICS_UI__ = UI

// 开发期清理审计要在任何插件加载前安装，才能记录到它们的监听器
installCleanupAudit()

// 图标动画要等窗口真的显示出来再播：由主进程的窗口状态回答「可见了吗」
startWindowVisibilityTracking()

// 启动页先于 UI 框架出现：插件加载期间给出明确进度，而不是空白窗口
showBootScreen()

createApp(App).provide(iconPlaybackGateKey, windowVisibilityGate).mount('#app')

boot().catch((error: unknown) => {
  store.bootError = error instanceof Error ? error.message : String(error)
  reportBootError(error)
})
