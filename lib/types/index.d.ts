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
import type { Context } from '@deepseek-ai/cordis';
export interface ComputerConfig {
    enabled: boolean;
}
export declare const Config: z<{
    enabled: boolean;
}>;
export declare const name = "dsh-computer";
export declare const provide: string[];
export declare function apply(ctx: Context, config: ComputerConfig): void;
