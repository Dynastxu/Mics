import type { FileTransferHandle } from '@mics/sdk'
import { createSegmentedFileTransfer } from './segmentedTransfer'
import { createSingleFileTransfer } from './singleTransfer'
import type { FileTransferOptions } from './transferCommon'

/**
 * 本机文件传输入口。
 *
 * 调用方只通过 `FileTransferCapability` 使用它；这里根据每个文件允许的
 * 连接数选择单连接或分段实现。分段实现探测失败时会自己回退到单连接，
 * 因此下载管线不需要关心服务器是否支持 Range。
 */

export type { FileTransferOptions, TransferAgents } from './transferCommon'
export { TRANSFER_STATE_SUFFIX, transferStatePath, transferStateProgress } from './transferCommon'

export function createFileTransfer(options: FileTransferOptions): FileTransferHandle {
  const segments = Number(options.segments)
  if (Number.isFinite(segments) && segments > 1) {
    return createSegmentedFileTransfer(options)
  }
  return createSingleFileTransfer(options)
}
