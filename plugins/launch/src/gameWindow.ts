import { spawn, type ChildProcess } from 'node:child_process'

/** 等待游戏窗口的结果：已出现并尝试置前 / 进程提前退出 / 超时 / 当前平台不支持探测 */
export type GameWindowProbe = 'found' | 'exited' | 'timeout' | 'unsupported'

/**
 * 轮询目标进程的主窗口，窗口出现后做一次最温和的置前。
 *
 * 只用 `Get-Process.MainWindowHandle` 读取窗口，再用 `WScript.Shell.AppActivate`
 * 请求前台；不调用 ShowWindow / AttachThreadInput。
 *
 * 不要在这里调用 `Add-Type`：Windows PowerShell 会拉起 csc.exe 编译 C#，
 * 既慢又会闪出控制台窗口、和 SDL 抢一次前台；上次游戏窗口一闪而过疑似与此有关。
 *
 * TODO: 如果某些机器上 AppActivate 拿不到前台（Windows 前台锁），再考虑用
 * user32 的 SetForegroundWindow 并处理前台锁；替换前必须在真实桌面上验证
 * 不会让 SDL 创建的窗口消失。
 */
function pollScript(pid: number, timeoutMs: number): string {
  return String.raw`
$deadline = [DateTime]::UtcNow.AddMilliseconds(${timeoutMs})
while ([DateTime]::UtcNow -lt $deadline) {
    $game = $null
    try { $game = Get-Process -Id ${pid} -ErrorAction Stop } catch { $game = $null }
    if (-not $game) {
        Write-Output 'EXITED'
        exit 0
    }

    $handle = [IntPtr]::Zero
    try { $handle = $game.MainWindowHandle } catch { $handle = [IntPtr]::Zero }
    if ($handle -ne [IntPtr]::Zero) {
        try { (New-Object -ComObject WScript.Shell).AppActivate(${pid}) | Out-Null } catch { }
        Write-Output 'FOUND'
        exit 0
    }

    Start-Sleep -Milliseconds 400
}
Write-Output 'TIMEOUT'
`
}

function encodeCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

function classify(output: string): GameWindowProbe | null {
  const lines = output.trim().split(/\r?\n/)
  const last = lines[lines.length - 1]?.trim().toUpperCase()
  if (last === 'FOUND') return 'found'
  if (last === 'EXITED') return 'exited'
  if (last === 'TIMEOUT') return 'timeout'
  return null
}

export function waitForGameWindow(pid: number, timeoutMs: number): Promise<GameWindowProbe> {
  if (process.platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) {
    return Promise.resolve('unsupported')
  }

  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-WindowStyle',
          'Hidden',
          '-ExecutionPolicy',
          'Bypass',
          '-EncodedCommand',
          encodeCommand(pollScript(pid, timeoutMs)),
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      )
    } catch {
      resolve('unsupported')
      return
    }

    let settled = false
    const finish = (result: GameWindowProbe): void => {
      if (settled) return
      settled = true
      clearTimeout(guard)
      resolve(result)
    }

    // 脚本自己会在超时后退出；这里只兜住解释器卡死的情况。
    const guard = setTimeout(() => {
      child.kill()
      finish('timeout')
    }, timeoutMs + 30_000)

    let output = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      output += chunk
    })

    child.once('error', () => finish('unsupported'))
    child.once('exit', () => finish(classify(output) ?? 'unsupported'))
  })
}
