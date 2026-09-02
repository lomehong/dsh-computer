/**
 * dsh-computer：电脑操作插件。
 *
 * - 服务：`computer`（持久 PowerShell worker + Win32 互操作），供预设工具行
 *   `@dsh-extra/dsh-computer/tools` 使用——工具经 ctx.get('computer') 取服务
 *   （与 dsh-memory 同款的服务注册模式）；
 * - 配置：settings.yaml 的 computer 节（enabled 总开关，热生效）；
 * - 生命周期：worker 空闲 10 分钟自动回收，插件卸载兜底杀进程。
 *
 * 安全边界：操作的是真实桌面——影响所有应用（包括非沙箱内的）。工具可用性
 * 由 preset 决定（宿主可用 ≠ 工具可用）；对不可信会话请从预设移除工具行。
 */
import z from '@deepseek-ai/schemastery';
import { ComputerWorker } from "./worker.js";
export const Config = z.object({
    enabled: z.boolean().default(true).description('启用电脑操作工具（关闭时工具返回明确错误）'),
});
export const name = 'dsh-computer';
export const provide = ['computer'];
export function apply(ctx, config) {
    const log = (() => {
        try {
            const logger = ctx.logger;
            if (logger !== undefined && typeof logger.info === 'function') {
                const info = logger.info.bind(logger);
                return (line) => { try {
                    info(line);
                }
                catch { /* ignore */ } };
            }
        }
        catch { /* ignore */ }
        return (line) => { process.stdout.write(`[dsh-computer] ${line}\n`); };
    })();
    let enabled = config.enabled !== false;
    // ── 配置来源：settings 节（热生效），组合层 config 为基线 ──
    ctx.inject(['settings'], (sctx) => {
        const settings = sctx.settings;
        if (settings === undefined || typeof settings.register !== 'function')
            return;
        try {
            const scope = settings.register(NS, Config, { base: config });
            scope.watch((next) => {
                enabled = next.enabled !== false;
                log(`配置已应用：电脑操作=${enabled ? '启用' : '停用'}`);
            });
        }
        catch (error) {
            log(`设置节注册失败（配置退回组合层基线）：${error instanceof Error ? error.message : String(error)}`);
        }
    });
    // ── computer 服务：持久 worker + 开关（注册失败降级为跳过） ──
    const worker = new ComputerWorker((line) => log(line));
    const service = {
        run: async (op, args) => {
            if (!enabled)
                throw new Error('电脑操作已在设置中停用（computer 设置节）');
            return worker.run(op, args);
        },
        enabled: () => enabled,
        screenshotDir: () => worker.screenshotDir(),
    };
    try {
        ;
        ctx.provide('computer', service);
    }
    catch (error) {
        log(`computer 服务注册失败：${error instanceof Error ? error.message : String(error)}`);
    }
    ctx.effect(() => () => { worker.dispose(); }, 'dsh-computer: worker');
    log(`已加载：电脑操作=${enabled ? '启用' : '停用'}（worker 懒启动，Windows DPI 感知；工具经预设行 @dsh-extra/dsh-computer/tools 暴露）`);
}
const NS = 'computer';
