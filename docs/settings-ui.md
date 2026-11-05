# 设置页模板

所有设置页共用 `@mics/ui` 的三层模板，不再各自拼 `.mics-page` / `.mics-field`：

| 模板            | 对应                   | 负责                                                    |
| --------------- | ---------------------- | ------------------------------------------------------- |
| `SettingsPage`  | 基础设置模板（页面壳） | 标题、说明、加载 / 错误状态、页面操作、追加分组的渲染位 |
| `SettingsGroup` | 设置分组模板           | 分组标题、说明、分组操作、`mics-form` 卡片、分组级错误  |
| `SettingsRow`   | 设置内容模板（一行）   | 行标题 / 说明、控件插槽、行尾操作                       |

## 页面结构

```vue
<script setup lang="ts">
import { useSettingsExtensions } from '@mics/sdk/renderer'
import { SettingsGroup, SettingsPage, SettingsRow } from '@mics/ui'

const extensions = useSettingsExtensions('settings.download')
</script>

<template>
  <SettingsPage title="下载设置" :loading="loading" :extensions="extensions">
    <SettingsGroup title="下载行为">
      <SettingsRow label="最大并发" hint="同时下载的文件数" html-for="download-concurrency">
        <input id="download-concurrency" v-model="concurrency" class="mics-input" />
        <template #actions>
          <button class="mics-button mics-button--ghost mics-button--small" @click="reset">
            重置
          </button>
        </template>
      </SettingsRow>
    </SettingsGroup>

    <template #footer>
      <!-- 需要排在追加分组之后的内容 -->
    </template>
  </SettingsPage>
</template>
```

约定：

- 页面自己的分组直接写在 `SettingsPage` 默认插槽，按书写顺序渲染。
- `SettingsPage` 的 `#actions` 放页面级按钮，`#footer` 放追加分组之后的收尾内容。
- `SettingsGroup` 默认用 `mics-form` 包住行；列表、预览等自定义结构设 `form` 为 `false`。
- `SettingsRow` 的控件放默认插槽，单位等跟着控件走；恢复默认等行尾操作放 `#actions`。
- 分组和页面都能接 `loading` / `error`；分组自己加载的数据不要把错误提到页面级。

## 追加分组

其它插件可以在任意设置页尾部追加分组：

```ts
ctx.ui.registerSettingsGroup({
  id: 'close-behavior',
  pageId: 'settings.general',
  title: '关闭与托盘',
  order: 20,
  component: CloseBehaviorSection
})
```

- `pageId` 是导航视图 id（`settings.general` / `settings.download` / `settings.launch`，
  以及后续新增的设置页）。日志就是这样挂到 `settings.general` 上的：`mics.logger`
  没有自己的导航项，只追加一个分组。
- 同一页面内 `id` 唯一；跨插件重复注册会直接抛错，插件卸载时自动移除。
- 追加分组按 `order` 排序（缺省 100）后接在页面自己的分组之后。
- 分组组件自己返回一个 `<SettingsGroup>`，因此可以使用 `form=false`、分组操作等能力。

渲染时 shell 会为追加分组注入注册方的作用域，分组组件里直接：

```ts
const ctx = usePluginContext()
```

拿到的是**注册方插件**的上下文，`ctx.ipc.invoke()` 的 callerId 与事件监听器归属都正确，
不需要再把 `ctx` 塞进 `props`。

## 旧接口

`ctx.ui.registerSettingsSection()` / `settingsSections()` 仍然可用，等价于：

```ts
ctx.ui.registerSettingsGroup({ ...section, pageId: 'settings.general' })
ctx.ui.settingsGroups('settings.general')
```

新代码不要再用；它的 `props.ctx` 写法也不再需要。

## 什么时候用 schema 表单

简单类型（字符串 / 数字 / 开关 / 枚举）继续用 `contributes.configuration`，插件详情里
自动渲染；设置项多、需要自定义控件（下载源列表等）时才贡献独立设置页，只有少量设置
又希望和通用设置放在一起的（日志）用追加分组。设置页与分组的值仍然优先走
`configuration/*` 或 `ctx.storage`，不要另起一套默认值与校验。

## 相关文件

- `packages/ui/src/settings/{SettingsPage,SettingsGroup,SettingsRow}.vue`
- `packages/sdk/src/contract/services.ts`（`SettingsGroupRegistration` / `UiServiceApi`）
- `packages/sdk/src/renderer.ts`（`useSettingsExtensions`）
- `apps/desktop/src/renderer/runtime/services/ui.ts`（注册表与清理）
