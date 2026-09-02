import { describe, expect, it } from 'vitest'
import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply as applyTools } from '../src/tools.ts'
import { apply as applyPlugin, type ComputerConfig } from '../src/index.ts'
import { ComputerWorker } from '../src/worker.ts'

/* ─────────────── 工具注册契约（alpha.3 output 强制） ─────────────── */

interface CapturedTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { schema: Record<string, unknown>; render: (args: unknown, value: unknown) => Array<{ type: string; text?: string }> }
  execute: (args: unknown) => Promise<unknown>
}

function bootWithService(service: Record<string, unknown>): { tools: CapturedTool[]; provideCalls: Array<{ name: string; value: unknown }> } {
  const tools: CapturedTool[] = []
  const provideCalls: Array<{ name: string; value: unknown }> = []
  const ctx = {
    logger: { info: (line: string) => { void line } },
    provide: (name: string, value: unknown) => { provideCalls.push({ name, value }) },
    inject: (_names: string[], fn: (scoped: unknown) => void) => { fn({ settings: { register: () => ({ get: () => ({ enabled: true }), watch: () => (() => {}) }) } }) },
    get: (name: string) => (name === 'computer' ? service : undefined),
    /** 宿主 tools 注册表：工具经它注册，测试在此捕获。 */
    tools: { register: (tool: CapturedTool) => { tools.push(tool) } },
    effect: (_factory: () => () => void, _label?: string) => (() => {}),
  } as unknown as Parameters<typeof applyPlugin>[0]
  applyPlugin(ctx, { enabled: true } as ComputerConfig)
  applyTools(ctx as unknown as Parameters<typeof applyTools>[0])
  return { tools, provideCalls }
}

describe('dsh-computer 工具注册契约', () => {
  const service = {
    run: async () => ({}),
    enabled: () => true,
    screenshotDir: () => 'D:/tmp',
  }

  it('注册 8 个 computer_* 工具', () => {
    const { tools } = bootWithService(service)
    const names = tools.map((t) => t.name)
    for (const expected of [
      'computer_screenshot', 'computer_click', 'computer_type', 'computer_key',
      'computer_scroll', 'computer_window_list', 'computer_window_focus', 'computer_clipboard',
    ]) {
      expect(names).toContain(expected)
    }
    expect(tools).toHaveLength(8)
  })

  it('每个工具都带 alpha.3 强制的 output 契约（schema + render）', () => {
    const { tools } = bootWithService(service)
    for (const tool of tools) {
      expect(tool.output, `${tool.name} 缺 output`).toBeDefined()
      expect(tool.output.schema.type).toBe('object')
      expect(typeof tool.output.render).toBe('function')
      const rendered = tool.output.render({}, {})
      expect(Array.isArray(rendered)).toBe(true)
      expect(rendered[0].type).toBe('text')
    }
  })

  it('computer 服务已按 dsh-memory 模式注册（ctx.provide）', () => {
    const { provideCalls } = bootWithService(service)
    expect(provideCalls).toHaveLength(1)
    expect(provideCalls[0].name).toBe('computer')
    // apply 内部构建服务对象：具备 run/enabled/screenshotDir 即视作可用
    const svc = provideCalls[0].value as ComputerService
    expect(typeof svc.run).toBe('function')
    expect(typeof svc.enabled).toBe('function')
    expect(svc.enabled()).toBe(true)
  })

  it('开关关闭时 execute 返回明确错误（不静默失败）', async () => {
    const disabled = { ...service, enabled: () => false }
    const { tools } = bootWithService(disabled)
    const click = tools.find((t) => t.name === 'computer_click')!
    await expect(click.execute({ x: 10, y: 10 })).rejects.toThrow(/停用/)
  })

  it('computer_click 参数缺失 → execute 拒绝（类型护栏）', async () => {
    const { tools } = bootWithService(service)
    const click = tools.find((t) => t.name === 'computer_click')!
    await expect(click.execute({})).rejects.toThrow(/坐标必填/)
  })
})

/* ─────────────── 真实桌面 E2E（Windows，只跑无害操作） ─────────────── */

const isWindows = process.platform === 'win32'
function makeWorker(): ComputerWorker {
  return new ComputerWorker(undefined)
}

describe.skipIf(!isWindows)('电脑操作：真实桌面 E2E（Windows，无害操作）', () => {
  it('screen-info：返回显示器信息', async () => {
    const worker = makeWorker()
    try {
      const info = await worker.run<{ monitorCount: number; virtual: { width: number } }>('screen-info', {}, 30_000)
      expect(info.monitorCount).toBeGreaterThanOrEqual(1)
      expect(info.virtual.width).toBeGreaterThan(0)
    } finally { worker.dispose() }
  }, 40_000)

  it('window-list：至少 1 个可见窗口', async () => {
    const worker = makeWorker()
    try {
      const list = await worker.run<{ count: number; windows: Array<{ title: string }> }>('window-list', {}, 30_000)
      expect(list.count).toBeGreaterThanOrEqual(1)
      expect(list.windows[0].title.length).toBeGreaterThan(0)
    } finally { worker.dispose() }
  }, 40_000)

  it('screenshot：PNG 落盘且非空', async () => {
    const worker = makeWorker()
    try {
      const dir = join(tmpdir(), 'dsh-computer-test')
      mkdirSync(dir, { recursive: true })
      const out = await worker.run<{ path: string; width: number }>('screenshot', { out: join(dir, 'test-shot.png') }, 30_000)
      const st = statSync(out.path)
      expect(st.size).toBeGreaterThan(1000)
      expect(out.width).toBeGreaterThan(0)
    } finally { worker.dispose() }
  }, 40_000)

  it('clipboard：set/get 往返', async () => {
    const worker = makeWorker()
    try {
      const marker = 'dsh-computer-test-' + Date.now()
      await worker.run('clipboard', { action: 'set', text: marker }, 30_000)
      const got = await worker.run<{ text: string }>('clipboard', { action: 'get' }, 30_000)
      expect(got.text).toBe(marker)
    } finally { worker.dispose() }
  }, 40_000)
})
