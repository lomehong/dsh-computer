/**
 * 持久 PowerShell 工作进程：JSON-line 协议（stdin 请求 / stdout 响应）。
 *
 * - 懒启动：首个操作拉起；空闲 10 分钟自动回收（下个操作重新拉起）；
 * - Win32 P/Invoke（SendInput 等）在 worker 内编译一次常驻，后续操作毫秒级；
 * - 每操作超时保护；进程退出/崩溃时未决请求全部拒绝，下次操作重新拉起；
 * - dispose 兜底杀进程（cordis effect 清理）。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const WORKER_PS1 = join(PLUGIN_ROOT, 'pwsh', 'computer-ops.ps1')
const IDLE_EXIT_MS = 10 * 60_000
const OP_TIMEOUT_MS = 30_000

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export class ComputerWorker {
  private child: ChildProcessWithoutNullStreams | undefined
  private pending = new Map<number, Pending>()
  private nextId = 1
  private idleTimer: NodeJS.Timeout | undefined
  private chain: Promise<unknown> = Promise.resolve()
  private readonly log: ((line: string) => void) | undefined

  constructor(log?: (line: string) => void) {
    this.log = log
  }

  /** 串行执行：GUI 操作有状态（聚焦/相对位置），逐条排队。 */
  run<T>(op: string, args: Record<string, unknown> = {}, timeoutMs = OP_TIMEOUT_MS): Promise<T> {
    const task = this.chain.catch(() => {}).then(() => this.runOnce<T>(op, args, timeoutMs))
    this.chain = task
    return task
  }

  dispose(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    this.rejectAll(new Error('电脑操作插件已卸载'))
    this.child?.kill()
    this.child = undefined
  }

  /** 截图输出目录（懒建）。 */
  screenshotDir(): string {
    const dir = join(tmpdir(), 'dsh-computer')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return dir
  }

  private async runOnce<T>(op: string, args: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const child = await this.ensure()
    const id = this.nextId++
    const payload = JSON.stringify({ id, op, args }) + '\n'
    const done = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`电脑操作「${op}」超时（${timeoutMs}ms）`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
    })
    child.stdin.write(payload)
    return done
  }

  private async ensure(): Promise<ChildProcessWithoutNullStreams> {
    if (this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null) {
      return this.child
    }
    this.touchIdle()
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WORKER_PS1],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    ) as ChildProcessWithoutNullStreams
    this.child = child
    child.on('exit', () => {
      this.child = undefined
      this.rejectAll(new Error('电脑操作 worker 进程退出'))
    })
    const rl = createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      if (line.trim() === '') return
      let message: { id?: number; ok?: boolean; result?: unknown; error?: string }
      try {
        message = JSON.parse(line)
      } catch {
        return // 非协议行忽略
      }
      const id = message.id
      if (id === undefined) return
      const pending = this.pending.get(id)
      if (pending === undefined) return
      clearTimeout(pending.timer)
      this.pending.delete(id)
      if (message.ok) pending.resolve(message.result)
      else pending.reject(new Error(message.error ?? '未知错误'))
    })
    return child
  }

  private touchIdle(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.log?.('电脑操作 worker 空闲超时，回收进程')
      this.child?.kill()
      this.child = undefined
    }, IDLE_EXIT_MS)
  }

  private rejectAll(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
