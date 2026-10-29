/**
 * 实例名称校验规则与实例磁盘布局约定。
 *
 * 实例名称同时是实例文件夹名，因此渲染进程（即时反馈）与主进程（写盘前把关）
 * 必须共用同一份规则：否则 UI 放行的名称可能在写盘时失败，或写出意料之外的目录。
 */

// ---------------------------------------------------------------------------
// 安装状态标记
// ---------------------------------------------------------------------------

/**
 * 实例根目录下的安装状态文件。
 *
 * 下载管线在创建实例目录时先写入 `installing`，全部文件落盘并校验通过后
 * 原子替换为 `ready`。启动页会照常列出 `installing` 的实例，但不提供启动入口：
 * 下载到一半、断点暂停或部分失败的实例只能查看或删除，不能开始游戏。
 * 没有该文件的旧实例按 `ready` 处理，保持兼容。
 *
 * 其它创建实例的插件也必须遵守这一约定，否则半成品会被误判为可启动。
 */
export const INSTANCE_STATE_FILE = 'install-state.json'

/** 安装状态：installing 表示仍在下载/校验，ready 表示已经可以启动 */
export type InstanceInstallState = 'installing' | 'ready'

export interface InstanceInstallRecord {
  state: InstanceInstallState
  /** 触发本次安装的下载任务 id，便于日志排查 */
  jobId?: string
  /** 目标游戏版本 */
  gameVersion?: string
  /** 完成时间戳；installing 时没有 */
  completedAt?: number
}

/** Windows 文件名/文件夹名中不允许出现的字符 */
export const INVALID_INSTANCE_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g

const INVALID_INSTANCE_NAME_TEST = /[\\/:*?"<>|\u0000-\u001f]/

/** Windows 保留设备名，不能作为文件夹名 */
const RESERVED_INSTANCE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

/** 名称长度上限：过长会让实例内的库路径撞上 Windows 的路径长度限制 */
export const INSTANCE_NAME_MAX_LENGTH = 64

export type InstanceNameIssue = 'empty' | 'invalid' | 'reserved' | 'too-long' | 'duplicate'

export interface InstanceNameCheck {
  ok: boolean
  /** 规范化后的名称；校验失败时为尽力规范化后的结果 */
  name: string
  issue?: InstanceNameIssue
  message?: string
}

/** 去掉名称中的非法字符（输入时的即时清理） */
export function sanitizeInstanceName(raw: string): string {
  return raw.replace(INVALID_INSTANCE_NAME_CHARS, '')
}

/**
 * 规范化名称：去掉非法字符、首尾空白，以及 Windows 会自动丢弃的结尾点/空格。
 * 规范化后的名称才是落盘用的文件夹名。
 */
export function normalizeInstanceName(raw: string): string {
  return sanitizeInstanceName(raw).trim().replace(/[. ]+$/, '')
}

/**
 * 纯规则校验，不触碰文件系统。
 * 名称是否与已有实例重名由调用方（主进程）补充判断。
 */
export function validateInstanceName(raw: string): InstanceNameCheck {
  if (INVALID_INSTANCE_NAME_TEST.test(raw)) {
    return {
      ok: false,
      name: sanitizeInstanceName(raw).trim(),
      issue: 'invalid',
      message: '名称不能包含 \\ / : * ? " < > | 等字符',
    }
  }

  const trimmed = raw.trim()
  if (trimmed === '.' || trimmed === '..') {
    return { ok: false, name: '', issue: 'invalid', message: '名称不能是「.」或「..」' }
  }

  const name = normalizeInstanceName(raw)
  if (!name) {
    return { ok: false, name: '', issue: 'empty', message: '名称不能为空' }
  }

  if (RESERVED_INSTANCE_NAME.test(name)) {
    return { ok: false, name, issue: 'reserved', message: `「${name}」是系统保留名称` }
  }

  if ([...name].length > INSTANCE_NAME_MAX_LENGTH) {
    return {
      ok: false,
      name,
      issue: 'too-long',
      message: `名称最多 ${INSTANCE_NAME_MAX_LENGTH} 个字符`,
    }
  }

  return { ok: true, name }
}
