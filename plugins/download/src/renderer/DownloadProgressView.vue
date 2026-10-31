<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { usePluginContext } from '@mics/sdk/renderer'
import { LOADER_LABELS } from '@mics/sdk'
import type { InstallJobStats, InstallJobSummary } from '@mics/sdk'

interface JobRow {
  job: InstallJobSummary
  stats: InstallJobStats
  speed: number
  /** 整个任务已暂停：所有未完成任务都在 paused，且没有正在跑的文件 */
  paused: boolean
  /** 已受理、仍在后台构建下载清单 */
  preparing: boolean
  /** 准备阶段的当前步骤进度（0–100）；空表示这一步没有可度量的进度 */
  preparePercent: number | undefined
  /** 准备阶段最近几秒内还有网络传输，速度才有意义 */
  prepareActive: boolean
}

interface SpeedSample {
  /** 真正从网络收到的字节；缓存复用不计入 */
  transferred: number
  at: number
  speed: number
}

const ctx = usePluginContext()

/** 准备阶段最近一次收到数据后，速度与字节显示还能保留多久 */
const PREPARE_TRANSFER_WINDOW_MS = 5000

const jobs = ref<InstallJobSummary[]>([])
const jobSpeeds = ref<Record<string, number>>({})
const notice = ref('')
/** 第一次汇总返回前显示加载态，不要先闪「暂无下载任务」 */
const loaded = ref(false)

const blocking = new Set<string>()
const speedSamples = new Map<string, SpeedSample>()

let timer: ReturnType<typeof setInterval> | null = null
let pollSeq = 0

const activeJobs = computed(() => jobs.value.filter((job) => !job.finished))
const historyJobs = computed(() => jobs.value.filter((job) => job.finished))

function jobPaused(stats: InstallJobStats): boolean {
  return stats.paused > 0 && stats.downloading === 0 && stats.waiting === 0
}

const activeRows = computed<JobRow[]>(() =>
  [...activeJobs.value]
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    .map((job) => ({
      job,
      stats: job.stats,
      speed: jobSpeeds.value[job.id] ?? 0,
      paused: jobPaused(job.stats),
      preparing: job.state === 'preparing',
      preparePercent: job.preparePercent === undefined
        ? undefined
        : Math.max(0, Math.min(100, Math.round(job.preparePercent))),
      prepareActive: job.prepareTransferAt !== undefined
        && Date.now() - job.prepareTransferAt < PREPARE_TRANSFER_WINDOW_MS,
    })),
)

const historyRows = computed(() =>
  [...historyJobs.value]
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    .map((job) => {
      const ok = job.state !== 'failed'
        && job.state !== 'cancelled'
        && job.stats.failed === 0
      return {
        job,
        stats: job.stats,
        label: historyLabel(job, job.stats),
        ok,
      }
    }),
)

function formatTime(timestamp: number | undefined): string {
  if (!timestamp) return '未知时间'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(timestamp))
}

function historyLabel(job: InstallJobSummary, stats: InstallJobStats): string {
  if (job.state === 'cancelled') return '已取消'
  if (job.state === 'failed') return '失败'
  if (job.state === 'done' || stats.failed === 0) return '已完成'
  return stats.cancelled === stats.failed ? '已取消' : '部分失败'
}

/** 同一实例名只认最新的一条游戏安装记录；Mod 安装不参与实例替代关系 */
const latestJobByInstance = computed(() => {
  const latest = new Map<string, InstallJobSummary>()
  for (const job of jobs.value) {
    if (job.kind === 'mod') continue
    const current = latest.get(job.instanceName)
    if (!current || jobSequence(job) >= jobSequence(current)) latest.set(job.instanceName, job)
  }
  return latest
})

function jobSequence(job: InstallJobSummary): number {
  const sequence = Number(job.id.startsWith('job_') ? job.id.slice('job_'.length) : '')
  return Number.isFinite(sequence) ? sequence : (job.createdAt ?? 0)
}

function isSuperseded(job: InstallJobSummary): boolean {
  if (job.kind === 'mod') return false
  return latestJobByInstance.value.get(job.instanceName)?.id !== job.id
}

function jobTitle(job: InstallJobSummary): string {
  return job.title || job.instanceName
}

/** 还有非取消原因失败的文件时可以重试，已完成的文件不会重新下载 */
function canRetry(job: InstallJobSummary, stats: InstallJobStats): boolean {
  return !isSuperseded(job) && stats.failed > stats.cancelled
}

/** 只有失败/取消的安装可以在这里清理；成功完成的实例请到启动页删除 */
function canDiscard(job: InstallJobSummary, stats: InstallJobStats): boolean {
  if (isSuperseded(job)) return false
  return job.state === 'failed' || job.state === 'cancelled' || stats.failed > 0
}

function fmtSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond < 1) return '0 B/s'
  if (bytesPerSecond < 1024) return `${Math.round(bytesPerSecond)} B/s`
  if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`
  return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

async function invoke(method: string, jobId: string): Promise<void> {
  if (blocking.has(jobId)) return
  blocking.add(jobId)
  try {
    await ctx.ipc.invoke('mics.download.manager', method, { jobId })
    notice.value = ''
  } catch (cause) {
    notice.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    blocking.delete(jobId)
    void poll()
  }
}

/** 速度由两次汇总的网络字节差算出；缓存复用不增加这个计数 */
function sampleSpeeds(): void {
  const now = Date.now()
  const speeds: Record<string, number> = {}

  for (const job of activeJobs.value) {
    const preparing = job.state === 'preparing'
    const transferred = job.stats.transferred ?? 0
    const receiving = preparing
      ? job.prepareTransferAt !== undefined
        && now - job.prepareTransferAt < PREPARE_TRANSFER_WINDOW_MS
      : job.stats.downloading > 0
    const previous = speedSamples.get(job.id)

    let speed = 0
    if (previous) {
      speed = previous.speed
      const elapsed = (now - previous.at) / 1000
      if (elapsed > 0.2) {
        const instant = Math.max(0, transferred - previous.transferred) / elapsed
        speed = previous.speed * 0.4 + instant * 0.6
      }
    }
    if (!receiving) speed = 0

    speedSamples.set(job.id, { transferred, at: now, speed })
    speeds[job.id] = speed
  }

  jobSpeeds.value = speeds
}

async function poll(): Promise<void> {
  const seq = ++pollSeq
  try {
    const list = await ctx.ipc.invoke<InstallJobSummary[]>(
      'mics.download.manager',
      'install/summary',
    )
    if (seq !== pollSeq) return
    jobs.value = list
    sampleSpeeds()
  } catch { /* 管线未就绪 */ } finally {
    if (seq === pollSeq) loaded.value = true
  }
}

onMounted(() => {
  void poll()
  timer = setInterval(() => void poll(), 1500)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div class="mics-page">
    <header class="mics-page__header">
      <h1 class="mics-page__title">下载进度</h1>
    </header>

    <p v-if="notice" class="mics-notice">{{ notice }}</p>

    <div v-if="!loaded" class="mics-empty">正在加载下载记录…</div>
    <div v-else-if="jobs.length === 0" class="mics-empty">暂无下载任务</div>

    <section v-if="activeRows.length" class="mics-section">
      <h2 class="mics-section__title">进行中</h2>

      <div class="mics-list">
        <div v-for="row in activeRows" :key="row.job.id" class="progress-job">
          <div class="progress-job__head">
            <div class="progress-job__title">
              <span class="progress-job__name">{{ jobTitle(row.job) }}</span>
              <template v-if="row.job.kind === 'mod'">
                <span class="mics-badge">Mod</span>
                <span v-if="row.job.detail" class="mics-badge">{{ row.job.detail }}</span>
              </template>
              <template v-else>
                <span v-if="row.job.kind === 'modpack'" class="mics-badge">整合包</span>
                <span v-if="row.job.kind === 'modpack' && row.job.detail" class="mics-badge">
                  {{ row.job.detail }}
                </span>
                <span v-if="row.job.gameVersion" class="mics-badge">{{ row.job.gameVersion }}</span>
                <span v-if="row.job.loader" class="mics-badge">
                  {{ LOADER_LABELS[row.job.loader.kind] ?? row.job.loader.kind }}
                  {{ row.job.loader.version }}
                </span>
                <span v-if="row.job.mode === 'repair'" class="mics-badge">补全</span>
                <span v-if="row.preparing" class="mics-badge mics-badge--accent">准备中</span>
              </template>
              <span v-if="isSuperseded(row.job)" class="mics-badge">旧记录</span>
            </div>

            <div class="progress-job__controls">
              <button
                v-if="!row.preparing && !isSuperseded(row.job)"
                class="mics-button mics-button--ghost mics-button--small"
                @click="invoke(row.paused ? 'install/resume' : 'install/pause', row.job.id)"
              >
                {{ row.paused ? '恢复' : '暂停' }}
              </button>
              <button
                class="mics-button mics-button--ghost mics-button--small"
                @click="invoke('install/cancel', row.job.id)"
              >
                取消
              </button>
            </div>
          </div>

          <template v-if="row.preparing">
            <div class="progress-job__progress">
              <div
                class="progress-job__bar"
                :class="{ 'progress-job__bar--indeterminate': row.preparePercent === undefined }"
                role="progressbar"
                :aria-valuenow="row.preparePercent"
                aria-valuemin="0"
                aria-valuemax="100"
              >
                <div
                  class="progress-job__bar-fill"
                  :style="row.preparePercent === undefined ? undefined : { width: row.preparePercent + '%' }"
                />
              </div>
              <span v-if="row.preparePercent !== undefined" class="progress-job__percent">
                {{ row.preparePercent }}%
              </span>
            </div>

            <div class="progress-job__preparing">
              {{ row.job.note || '正在准备下载清单…' }}
            </div>

            <div
              v-if="row.prepareActive"
              class="progress-job__stats"
            >
              <span v-if="row.job.prepareLoaded !== undefined" class="progress-stat">
                已下载 <b>{{ fmtBytes(row.job.prepareLoaded) }}</b>
                <template v-if="row.job.prepareTotal"> / {{ fmtBytes(row.job.prepareTotal) }}</template>
              </span>
              <span class="progress-stat progress-stat--speed">
                下载速度 <b>{{ fmtSpeed(row.speed) }}</b>
              </span>
            </div>
          </template>

          <template v-else>
            <div class="progress-job__progress">
              <div
                class="progress-job__bar"
                role="progressbar"
                :aria-valuenow="row.stats.percent"
                aria-valuemin="0"
                aria-valuemax="100"
              >
                <div class="progress-job__bar-fill" :style="{ width: row.stats.percent + '%' }" />
              </div>
              <span class="progress-job__percent">{{ row.stats.percent }}%</span>
            </div>

            <div class="progress-job__stats">
              <span class="progress-stat">待下载 <b>{{ row.stats.waiting }}</b></span>
              <span v-if="row.stats.paused > 0" class="progress-stat">
                已暂停 <b>{{ row.stats.paused }}</b>
              </span>
              <span class="progress-stat">下载中 <b>{{ row.stats.downloading }}</b></span>
              <span class="progress-stat">已完成 <b>{{ row.stats.done }}</b></span>
              <span v-if="row.stats.failed > 0" class="progress-stat progress-stat--danger">
                失败 <b>{{ row.stats.failed }}</b>
              </span>
              <span class="progress-stat progress-stat--speed">
                下载速度 <b>{{ fmtSpeed(row.speed) }}</b>
              </span>
            </div>
          </template>
        </div>
      </div>
    </section>

    <section v-if="historyRows.length" class="mics-section">
      <h2 class="mics-section__title">历史记录</h2>

      <div class="mics-list">
        <div v-for="row in historyRows" :key="row.job.id" class="mics-list__row">
          <div class="mics-list__main">
            <div class="mics-list__title">
              <span>{{ jobTitle(row.job) }}</span>
              <template v-if="row.job.kind === 'mod'">
                <span class="mics-badge">Mod</span>
                <span v-if="row.job.detail" class="mics-badge">{{ row.job.detail }}</span>
              </template>
              <template v-else>
                <span v-if="row.job.kind === 'modpack'" class="mics-badge">整合包</span>
                <span v-if="row.job.kind === 'modpack' && row.job.detail" class="mics-badge">
                  {{ row.job.detail }}
                </span>
                <span v-if="row.job.gameVersion" class="mics-badge">{{ row.job.gameVersion }}</span>
                <span v-if="row.job.mode === 'repair'" class="mics-badge">补全</span>
              </template>
              <span
                class="mics-badge"
                :class="{ 'mics-badge--accent': row.ok }"
              >
                {{ row.label }}
              </span>
              <span v-if="isSuperseded(row.job)" class="mics-badge">旧记录</span>
            </div>
            <div class="mics-list__meta">
              {{ formatTime(row.job.createdAt) }}
              <template v-if="row.stats.total > 0">
                · 已完成 {{ row.stats.done }}
                <template v-if="row.stats.cancelled > 0"> · 已取消 {{ row.stats.cancelled }}</template>
                <template v-if="row.stats.failed - row.stats.cancelled > 0">
                  · 失败 {{ row.stats.failed - row.stats.cancelled }}
                </template>
              </template>
            </div>
            <div v-if="row.job.error" class="progress-job__error">{{ row.job.error }}</div>
          </div>

          <div class="progress-job__controls">
            <button
              v-if="canRetry(row.job, row.stats)"
              class="mics-button mics-button--ghost mics-button--small"
              @click="invoke('install/retry', row.job.id)"
            >
              重试
            </button>
            <button
              v-if="canDiscard(row.job, row.stats)"
              class="mics-button mics-button--ghost mics-button--small"
              @click="invoke('install/discard', row.job.id)"
            >
              {{ row.job.mode === 'repair' ? '移除记录' : '删除' }}
            </button>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.progress-job {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border-bottom: 1px solid var(--mics-border);
}

.progress-job:last-child {
  border-bottom: 0;
}

.progress-job__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.progress-job__title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.progress-job__name {
  overflow: hidden;
  font-size: 13.5px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.progress-job__controls {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
}

.progress-job__preparing {
  color: var(--mics-fg-muted);
  font-size: 12px;
}

.progress-job__error {
  margin-top: 6px;
  color: var(--mics-danger);
  font-size: 11.5px;
  line-height: 1.5;
}

.progress-job__progress {
  display: flex;
  align-items: center;
  gap: 10px;
}

.progress-job__bar {
  flex: 1;
  height: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--mics-bg-hover);
}

.progress-job__bar-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--mics-accent);
  transition: width .3s ease;
}

/* 没有可度量进度的准备步骤（解析清单、解压覆盖文件）用不确定态，避免假装 100% */
.progress-job__bar--indeterminate .progress-job__bar-fill {
  width: 35%;
  animation: progress-job-indeterminate 1.1s ease-in-out infinite;
}

@keyframes progress-job-indeterminate {
  from { transform: translateX(-110%); }
  to { transform: translateX(320%); }
}

.progress-job__percent {
  flex: none;
  min-width: 34px;
  color: var(--mics-fg-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.progress-job__stats {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px;
  color: var(--mics-fg-muted);
  font-size: 11.5px;
}

.progress-stat b {
  margin-left: 5px;
  color: var(--mics-fg);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.progress-stat--danger b {
  color: var(--mics-danger);
}

.progress-stat--speed {
  margin-left: auto;
}

.progress-stat--speed b {
  color: var(--mics-accent);
}
</style>
