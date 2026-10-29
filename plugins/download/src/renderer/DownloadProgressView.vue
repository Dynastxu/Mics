<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { usePluginContext } from '@mics/sdk/renderer'
import type { DownloadTask, InstallJob } from '@mics/sdk'

interface JobStats {
  total: number
  /** 排队中（不含已暂停） */
  waiting: number
  paused: number
  downloading: number
  done: number
  failed: number
  cancelled: number
  percent: number
}

interface JobRow {
  job: InstallJob
  stats: JobStats
  speed: number
  /** 整个任务已暂停：所有未完成任务都在 paused，且没有正在跑的文件 */
  paused: boolean
  /** 已受理、仍在后台构建下载清单 */
  preparing: boolean
}

interface SpeedSample {
  loaded: number
  at: number
  speed: number
}

const EMPTY_STATS: JobStats = {
  total: 0,
  waiting: 0,
  paused: 0,
  downloading: 0,
  done: 0,
  failed: 0,
  cancelled: 0,
  percent: 0,
}

const ctx = usePluginContext()

const jobs = ref<InstallJob[]>([])
const allTasks = ref<DownloadTask[]>([])
const jobSpeeds = ref<Record<string, number>>({})
const notice = ref('')

const blocking = new Set<string>()
const speedSamples = new Map<string, SpeedSample>()

let timer: ReturnType<typeof setInterval> | null = null
let pollSeq = 0

const tasksByJob = computed(() => {
  const map = new Map<string, DownloadTask[]>()
  for (const task of allTasks.value) {
    const list = map.get(task.installId) ?? []
    list.push(task)
    map.set(task.installId, list)
  }
  return map
})

const statsByJob = computed(() => {
  const map = new Map<string, JobStats>()
  for (const job of jobs.value) {
    const tasks = tasksByJob.value.get(job.id) ?? []
    let waiting = 0
    let paused = 0
    let downloading = 0
    let done = 0
    let failed = 0
    let cancelled = 0
    let loaded = 0
    let bytes = 0

    for (const task of tasks) {
      switch (task.state) {
        case 'done':
          done += 1
          break
        case 'failed':
          failed += 1
          if (task.error === '已取消') cancelled += 1
          break
        case 'downloading':
        case 'verifying':
          downloading += 1
          break
        case 'paused':
          paused += 1
          break
        default:
          waiting += 1
      }
      loaded += task.progress.loaded
      bytes += task.progress.total > 0 ? task.progress.total : Math.max(task.size, 0)
    }

    const measured = bytes > 0
      ? (loaded / bytes) * 100
      : tasks.length > 0
        ? ((done + failed) / tasks.length) * 100
        : 0

    map.set(job.id, {
      total: tasks.length,
      waiting,
      paused,
      downloading,
      done,
      failed,
      cancelled,
      percent: Math.min(100, Math.max(0, Math.round(measured))),
    })
  }
  return map
})

/** 任务是否已结束：准备阶段仍算进行中，终态以主进程给的 state 为准 */
function isJobFinished(job: InstallJob): boolean {
  if (job.state === 'done' || job.state === 'failed' || job.state === 'cancelled') return true
  if (job.state === 'preparing') return false
  const tasks = tasksByJob.value.get(job.id) ?? []
  return tasks.length === 0
    || tasks.every((task) => task.state === 'done' || task.state === 'failed')
}

const activeJobs = computed(() => jobs.value.filter((job) => !isJobFinished(job)))
const historyJobs = computed(() => jobs.value.filter(isJobFinished))

function jobPaused(stats: JobStats): boolean {
  return stats.paused > 0 && stats.downloading === 0 && stats.waiting === 0
}

const activeRows = computed<JobRow[]>(() =>
  [...activeJobs.value]
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    .map((job) => {
      const stats = statsByJob.value.get(job.id) ?? EMPTY_STATS
      return {
        job,
        stats,
        speed: jobSpeeds.value[job.id] ?? 0,
        paused: jobPaused(stats),
        preparing: job.state === 'preparing',
      }
    }),
)

const historyRows = computed(() =>
  [...historyJobs.value]
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    .map((job) => {
      const stats = statsByJob.value.get(job.id) ?? EMPTY_STATS
      const ok = job.state !== 'failed'
        && job.state !== 'cancelled'
        && stats.failed === 0
      return {
        job,
        stats,
        label: historyLabel(job, stats),
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

function historyLabel(job: InstallJob, stats: JobStats): string {
  if (job.state === 'cancelled') return '已取消'
  if (job.state === 'failed') return '失败'
  if (job.state === 'done' || stats.failed === 0) return '已完成'
  return stats.cancelled === stats.failed ? '已取消' : '部分失败'
}

/** 同一实例名只认最新的一条安装记录，旧记录只能查看 */
const latestJobByInstance = computed(() => {
  const latest = new Map<string, InstallJob>()
  for (const job of jobs.value) {
    const current = latest.get(job.instanceName)
    if (!current || jobSequence(job) >= jobSequence(current)) latest.set(job.instanceName, job)
  }
  return latest
})

function jobSequence(job: InstallJob): number {
  const sequence = Number(job.id.startsWith('job_') ? job.id.slice('job_'.length) : '')
  return Number.isFinite(sequence) ? sequence : (job.createdAt ?? 0)
}

function isSuperseded(job: InstallJob): boolean {
  return latestJobByInstance.value.get(job.instanceName)?.id !== job.id
}

/** 还有非取消原因失败的文件时可以重试，已完成的文件不会重新下载 */
function canRetry(job: InstallJob, stats: JobStats): boolean {
  return !isSuperseded(job) && stats.failed > stats.cancelled
}

/** 只有失败/取消的安装可以在这里清理；成功完成的实例请到启动页删除 */
function canDiscard(job: InstallJob, stats: JobStats): boolean {
  if (isSuperseded(job)) return false
  return job.state === 'failed' || job.state === 'cancelled' || stats.failed > 0
}

function fmtSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond < 1) return '0 B/s'
  if (bytesPerSecond < 1024) return `${Math.round(bytesPerSecond)} B/s`
  if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`
  return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`
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

function sampleSpeeds(): void {
  const now = Date.now()
  const speeds: Record<string, number> = {}

  for (const job of activeJobs.value) {
    const tasks = tasksByJob.value.get(job.id) ?? []
    const loaded = tasks.reduce((sum, task) => sum + task.progress.loaded, 0)
    const downloading = tasks.some((task) => task.state === 'downloading' || task.state === 'verifying')
    const previous = speedSamples.get(job.id)

    let speed = previous?.speed ?? 0
    if (previous) {
      const elapsed = (now - previous.at) / 1000
      if (elapsed > 0.2) {
        const instant = Math.max(0, loaded - previous.loaded) / elapsed
        speed = previous.speed * 0.4 + instant * 0.6
      }
    }
    if (!downloading) speed = 0

    speedSamples.set(job.id, { loaded, at: now, speed })
    speeds[job.id] = speed
  }

  jobSpeeds.value = speeds
}

async function poll(): Promise<void> {
  const seq = ++pollSeq
  try {
    const [jobList, taskList] = await Promise.all([
      ctx.ipc.invoke<InstallJob[]>('mics.download.manager', 'install/list'),
      ctx.ipc.invoke<DownloadTask[]>('mics.download.manager', 'tasks/list'),
    ])
    if (seq !== pollSeq) return
    jobs.value = jobList
    allTasks.value = taskList
    sampleSpeeds()
  } catch { /* 管线未就绪 */ }
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

    <div v-if="jobs.length === 0" class="mics-empty">暂无下载任务</div>

    <section v-if="activeRows.length" class="mics-section">
      <h2 class="mics-section__title">进行中</h2>

      <div class="mics-list">
        <div v-for="row in activeRows" :key="row.job.id" class="progress-job">
          <div class="progress-job__head">
            <div class="progress-job__title">
              <span class="progress-job__name">{{ row.job.instanceName }}</span>
              <span class="mics-badge">{{ row.job.gameVersion }}</span>
              <span v-if="row.job.loader" class="mics-badge">
                {{ row.job.loader.kind }} {{ row.job.loader.version }}
              </span>
              <span v-if="row.job.mode === 'repair'" class="mics-badge">补全</span>
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

          <div v-if="row.preparing" class="progress-job__preparing">正在准备下载清单…</div>

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
              <span>{{ row.job.instanceName }}</span>
              <span class="mics-badge">{{ row.job.gameVersion }}</span>
              <span v-if="row.job.mode === 'repair'" class="mics-badge">补全</span>
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
