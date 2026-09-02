/**
 * dsh-computer 电脑操作工具的 agent preset 入口：preset 行
 * （`name: '@dsh-extra/dsh-computer/tools'`）引用本模块，挂载后的会话获得
 * 屏幕截图 / 鼠标键盘 / 窗口管理工具——让 dsh agent 具备操控真实桌面的能力。
 *
 * 依赖：dsh-computer 插件在 profile 注册的 `computer` 服务（持久 PowerShell
 * worker + Win32 互操作）。服务/worker 缺席时工具降级返回明确错误，绝不让
 * 注册或执行炸掉会话（对齐 dsh-twin/im-channel 的守则）。
 *
 * alpha.3 起 ToolDefinition.output 强制声明（schema/render）——每个工具都带
 * 与 execute 返回值对齐的 output 契约。
 *
 * @module @dsh-extra/dsh-computer/tools
 */
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "tool-computer";
export declare const inject: string[];
export declare function apply(ctx: Context): void;
