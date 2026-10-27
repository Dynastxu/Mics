import { createApp } from 'vue'
import App from './App.vue'
// 直接复用 shell 的设计系统样式，保证 demo 里的观感与插件页面一致
import '../../../apps/desktop/src/renderer/assets/main.css'

createApp(App).mount('#app')
