<script setup lang="ts">
import { computed, ref } from 'vue'
import { DataBrowser, defaultSelection } from '../src'
import type { FilterGroup, FilterSelection, ListRow, ListRowRole } from '../src'

// ─── 数据 ───

const GROUPS: FilterGroup[] = [
  {
    key: 'sort',
    label: '排序方式',
    mode: 'single',
    affects: 'order',
    options: [
      { value: 'name', label: '按名称' },
      { value: 'players', label: '按人数' },
    ],
  },
  {
    key: 'mode',
    label: '游戏模式',
    mode: 'single',
    exclusive: 'all',
    options: [
      { value: 'all', label: '全部' },
      { value: 'survival', label: '生存' },
      { value: 'creative', label: '创造' },
      { value: 'minigame', label: '小游戏' },
    ],
  },
  {
    key: 'version',
    label: '版本',
    mode: 'single',
    exclusive: 'all',
    options: [
      { value: 'all', label: '全部' },
      { value: '1.21.5', label: '1.21.5' },
      { value: '1.21.4', label: '1.21.4' },
      { value: '1.21.1', label: '1.21.1' },
    ],
  },
  {
    key: 'feature',
    label: '特性',
    mode: 'multi',
    exclusive: 'all',
    options: [
      { value: 'all', label: '全部' },
      { value: 'pvp', label: 'PVP' },
      { value: 'pve', label: 'PVE' },
      { value: 'build', label: '建造' },
      { value: 'timed', label: '限时' },
    ],
  },
]

const ITEMS: ListRow[] = [
  {
    id: 's1',
    label: '生存服 · 主城',
    badges: [
      { label: '冒险', accent: true },
      { label: '生存' },
      { label: 'PVE' },
    ],
    meta: 'v1.21.5 · 12/20 人',
    img: 'https://placehold.co/64x64/4f8/white?text=S',
    tags: { mode: 'survival', version: '1.21.5', feature: ['pve'] },
  },
  {
    id: 's2',
    label: '创造服 · 建筑',
    badge: '空闲',
    meta: 'v1.21.4 · 3/20 人',
    img: 'https://placehold.co/64x64/48f/white?text=C',
    tags: { mode: 'creative', version: '1.21.4', feature: ['build'] },
  },
  {
    id: 's3',
    label: '小游戏 · 起床战争',
    badges: [
      { label: '小游戏' },
      { label: 'PVP', accent: true },
    ],
    meta: 'v1.21.1 · 10/20 人',
    img: 'https://placehold.co/64x64/f84/white?text=G',
    tags: { mode: 'minigame', version: '1.21.1', feature: ['pvp'] },
  },
  {
    id: 's4',
    label: '生存服 · 空岛',
    badge: '新服',
    badgeAccent: true,
    meta: 'v1.21.5 · 8/20 人',
    img: 'https://placehold.co/64x64/8af/white?text=空',
    tags: { mode: 'survival', version: '1.21.5', feature: ['pve'] },
  },
  {
    id: 's5',
    label: '小游戏 · 饥饿游戏',
    badges: [
      { label: '小游戏' },
      { label: 'PVP', accent: true },
      { label: '限时' },
    ],
    meta: 'v1.21.4 · 6/12 人',
    tags: { mode: 'minigame', version: '1.21.4', feature: ['pvp', 'timed'] },
  },
]

function playerCount(meta: string): number {
  const m = meta.match(/(\d+)\/\d+\s*人/)
  return m ? Number(m[1]) : 0
}

function sortItems(a: ListRow, b: ListRow, selection: FilterSelection): number {
  const order = selection.sort?.[0] ?? 'name'
  if (order === 'players') {
    return playerCount(b.meta ?? '') - playerCount(a.meta ?? '') || a.label.localeCompare(b.label)
  }
  return a.label.localeCompare(b.label)
}

// ─── 功能开关 ───

const role = ref<ListRowRole>('button')
const showSearch = ref(true)
const showFilter = ref(true)
const showImg = ref(true)
const showActions = ref(false)

const isRadio = computed(() => role.value === 'radio')
const isCheckbox = computed(() => role.value === 'checkbox')

// ─── 状态 ───

const query = ref('')
const filter = ref<FilterSelection>(defaultSelection(GROUPS))
const selectedId = ref('')
const checkedIds = ref<string[]>([])
const serverEnabled = ref<Record<string, boolean>>({
  s1: true,
  s2: true,
  s3: false,
  s4: true,
  s5: false,
})

function toggleCheck(id: string) {
  const idx = checkedIds.value.indexOf(id)
  if (idx === -1) {
    checkedIds.value = [...checkedIds.value, id]
  } else {
    checkedIds.value = checkedIds.value.filter((v) => v !== id)
  }
}

function onSelect(id: string) {
  if (isCheckbox.value) {
    toggleCheck(id)
  } else {
    selectedId.value = id
  }
}

function onAction(action: string, item: ListRow) {
  alert(`${action}: ${item.label}`)
}

// ─── 计算属性 ───

const activeItems = computed(() => {
  if (showImg.value) return ITEMS
  return ITEMS.map(({ img, imgAlt, ...rest }) => rest as ListRow)
})

const activeGroups = computed(() =>
  showFilter.value ? GROUPS : [],
)
</script>

<template>
  <div class="demo">
    <header class="demo__head">
      <h1>DataBrowser 调试</h1>

      <div class="demo__seg">
        <button
          v-for="r in (['button', 'radio', 'checkbox'] as ListRowRole[])"
          :key="r"
          :class="{ 'is-active': role === r }"
          @click="role = r"
        >{{ r }}</button>
      </div>
    </header>

    <div class="demo__toggles">
      <label><input v-model="showSearch" type="checkbox" />搜索框</label>
      <label><input v-model="showFilter" type="checkbox" />筛选</label>
      <label><input v-model="showImg" type="checkbox" />图片</label>
      <label><input v-model="showActions" type="checkbox" />操作按钮</label>
    </div>

    <div class="demo__state">
      <span>query <code>{{ JSON.stringify(query) }}</code></span>
      <span>filter <code>{{ JSON.stringify(filter) }}</code></span>
      <span v-if="isRadio">选中 <code>{{ selectedId || '—' }}</code></span>
      <span v-if="isCheckbox">已选 <code>{{ checkedIds.length ? checkedIds.join(', ') : '—' }}</code></span>
      <span v-if="role === 'button'">上次点击 <code>{{ selectedId || '—' }}</code></span>
    </div>

    <div class="demo__page">
      <DataBrowser
        :items="activeItems"
        :groups="activeGroups"
        title="服务器"
        :role="role"
        :searchable="showSearch"
        :selected-id="isRadio ? selectedId : ''"
        :selected-ids="isCheckbox ? checkedIds : []"
        :action-label="role === 'button' ? '进入' : undefined"
        :sort="sortItems"
        v-model:query="query"
        v-model:filter="filter"
        @select="onSelect"
      >
        <template v-if="showActions" #actions="{ item }">
          <label class="demo__toggle" @click.stop>
            <input
              type="checkbox"
              :checked="serverEnabled[item.id]"
              @change="serverEnabled[item.id] = ($event.target as HTMLInputElement).checked"
            />
            <span class="demo__toggle-knob" />
          </label>
          <button
            class="demo__btn"
            @click.stop="onAction('编辑', item)"
          >编辑</button>
          <button
            class="demo__btn demo__btn--danger"
            @click.stop="onAction('删除', item)"
          >删除</button>
        </template>
      </DataBrowser>
    </div>
  </div>
</template>

<style scoped>
.demo {
  height: 100%;
  overflow: auto;
  padding: 24px 28px 48px;
}

.demo__head {
  display: flex;
  align-items: center;
  gap: 18px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}

.demo__head h1 {
  margin: 0;
  font-size: 18px;
  font-weight: 650;
}

.demo__seg {
  display: flex;
  border: 1px solid var(--mics-border);
  border-radius: 8px;
  overflow: hidden;
}

.demo__seg button {
  padding: 4px 14px;
  border: none;
  border-right: 1px solid var(--mics-border);
  background: transparent;
  color: var(--mics-fg-muted);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}

.demo__seg button:last-child {
  border-right: 0;
}

.demo__seg button:hover {
  background: var(--mics-bg-hover);
}

.demo__seg button.is-active {
  background: color-mix(in srgb, var(--mics-accent) 15%, transparent);
  color: var(--mics-accent);
  font-weight: 600;
}

.demo__toggles {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin-bottom: 14px;
  color: var(--mics-fg-muted);
  font-size: 12px;
}

.demo__toggles label {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.demo__state {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 20px;
  margin-bottom: 20px;
  padding: 8px 12px;
  border: 1px solid var(--mics-border);
  border-radius: 8px;
  background: var(--mics-bg-elevated);
  color: var(--mics-fg-muted);
  font-size: 11.5px;
}

.demo__state code {
  color: var(--mics-fg);
}

.demo__page {
  max-width: 1080px;
}

.demo__btn {
  flex: none;
  padding: 4px 10px;
  border: 1px solid var(--mics-border);
  border-radius: 6px;
  background: var(--mics-bg-elevated);
  color: var(--mics-fg);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.12s;
}

.demo__btn:hover {
  background: var(--mics-bg-hover);
}

.demo__btn--danger {
  color: #e53e3e;
  border-color: color-mix(in srgb, #e53e3e 30%, var(--mics-border));
}

.demo__btn--danger:hover {
  background: color-mix(in srgb, #e53e3e 8%, transparent);
}

/* 开关 */
.demo__toggle {
  position: relative;
  width: 36px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  cursor: pointer;
  flex: none;
}

.demo__toggle input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}

.demo__toggle-knob {
  width: 100%;
  height: 100%;
  border-radius: 10px;
  background: var(--mics-fg-muted);
  transition: background 0.18s;
}

.demo__toggle-knob::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 3px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.18s;
}

.demo__toggle input:checked + .demo__toggle-knob {
  background: var(--mics-accent);
}

.demo__toggle input:checked + .demo__toggle-knob::after {
  transform: translateX(14px);
}
</style>