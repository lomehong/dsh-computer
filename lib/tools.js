export const name = 'tool-computer';
export const inject = ['tools'];
const CLICK_BUTTON_SCHEMA = {
    type: 'string',
    enum: ['left', 'right', 'middle'],
    description: '鼠标按键（默认 left）',
};
/** 每个工具共享的输出骨架：error 可选字段 + 各操作特定字段。 */
function baseOutput(properties) {
    return {
        type: 'object',
        additionalProperties: false,
        properties: {
            error: { type: 'string', description: '操作失败原因（成功时缺失）' },
            ...properties,
        },
    };
}
export function apply(ctx) {
    const host = ctx;
    const tools = host.tools ?? host.get?.('tools');
    if (tools === undefined || typeof tools.register !== 'function')
        return;
    // 注册失败降级为跳过：绝不让工具注册问题炸掉会话创建（对齐 dsh-twin 守则）
    try {
        const service = () => {
            const svc = host.get?.('computer');
            if (svc === undefined || typeof svc.run !== 'function') {
                throw new Error('computer 服务不可用（插件未启用或 worker 未就绪）');
            }
            return svc;
        };
        const wrap = (fn) => async (args) => {
            const svc = service();
            // 停用检查由服务自身契约决定（而非 preset/闭包）：任何服务实现均可独立管控
            if (!svc.enabled())
                throw new Error('电脑操作已在设置中停用（computer 设置节）');
            return fn(svc, args);
        };
        /* ── 截图 ── */
        tools.register({
            name: 'computer_screenshot',
            description: '截取当前桌面（多显示器时为整个虚拟屏幕）并保存为 PNG。' +
                '返回截图文件路径与尺寸，用 read_image 工具查看截图内容。' +
                '屏幕坐标以截图左上角为原点（多显示器时为虚拟屏原点）。',
            parameters: { type: 'object', additionalProperties: false, properties: {} },
            output: {
                schema: baseOutput({
                    path: { type: 'string', description: '截图 PNG 文件路径（用 read_image 查看）' },
                    width: { type: 'number', description: '截图宽度（像素）' },
                    height: { type: 'number', description: '截图高度（像素）' },
                }),
                render: (_args, value) => {
                    const v = value;
                    return [{ type: 'text', text: `截图已保存：${v.path ?? ''}（${v.width ?? 0}×${v.height ?? 0}），请用 read_image 查看` }];
                },
            },
            execute: wrap(async (svc) => {
                const shot = await svc.run('screenshot');
                return { ...shot, hint: '用 read_image 查看该截图' };
            }),
        });
        /* ── 鼠标点击 ── */
        tools.register({
            name: 'computer_click',
            description: '在屏幕指定坐标处点击鼠标（坐标 = 截图像素坐标，原点为截图左上角）。' +
                '先 computer_screenshot 看清界面再点击。操作的是真实桌面，会影响所有应用。',
            parameters: {
                type: 'object',
                additionalProperties: false,
                required: ['x', 'y'],
                properties: {
                    x: { type: 'number', description: '横坐标（像素）' },
                    y: { type: 'number', description: '纵坐标（像素）' },
                    button: CLICK_BUTTON_SCHEMA,
                    double: { type: 'boolean', description: '是否双击（默认 false）' },
                },
            },
            output: {
                schema: baseOutput({
                    x: { type: 'number' }, y: { type: 'number' },
                    button: { type: 'string' }, double: { type: 'boolean' },
                }),
                render: (_args, value) => {
                    const v = value;
                    if (v.error !== undefined)
                        return [{ type: 'text', text: `点击失败：${v.error}` }];
                    const kind = v.double === true ? '双击' : '单击';
                    return [{ type: 'text', text: `已在 (${v.x ?? 0}, ${v.y ?? 0}) ${kind}${v.button === 'left' ? '' : `（${v.button ?? 'left'}）`}` }];
                },
            },
            execute: wrap(async (svc, args) => {
                const a = (args ?? {});
                if (typeof a.x !== 'number' || typeof a.y !== 'number')
                    throw new Error('x 与 y 坐标必填（数字）');
                return svc.run('click', { x: a.x, y: a.y, button: a.button ?? 'left', double: a.double === true });
            }),
        });
        /* ── 键盘输入 ── */
        tools.register({
            name: 'computer_type',
            description: '向当前焦点窗口逐字符输入文本（支持中文与全角字符）。' +
                '输入前请确认目标窗口已聚焦（必要时先 computer_click 点击输入框或 computer_window_focus 聚焦窗口）。',
            parameters: {
                type: 'object',
                additionalProperties: false,
                required: ['text'],
                properties: { text: { type: 'string', description: '要输入的文本（支持中文）' } },
            },
            output: {
                schema: baseOutput({ length: { type: 'number', description: '已输入的字符数' } }),
                render: (_args, value) => {
                    const v = value;
                    if (v.error !== undefined)
                        return [{ type: 'text', text: `输入失败：${v.error}` }];
                    return [{ type: 'text', text: `已输入 ${v.length ?? 0} 个字符` }];
                },
            },
            execute: wrap(async (svc, args) => {
                const a = (args ?? {});
                if (typeof a.text !== 'string' || a.text === '')
                    throw new Error('text 必填（非空字符串）');
                return svc.run('type', { text: a.text });
            }),
        });
        /* ── 组合键 ── */
        tools.register({
            name: 'computer_key',
            description: '按下按键组合（发送到当前焦点窗口）。' +
                '格式：修饰键+主键，如 win+r、ctrl+c、alt+tab、shift+esc、enter、f5。' +
                '支持修饰键：ctrl/alt/shift/win；主键：字母/数字/F1-F24/enter/tab/esc/space/backspace/delete/insert/home/end/pgup/pgdn/方向键/printscreen。',
            parameters: {
                type: 'object',
                additionalProperties: false,
                required: ['combo'],
                properties: { combo: { type: 'string', description: '按键组合，如 win+r、ctrl+shift+t' } },
            },
            output: {
                schema: baseOutput({ combo: { type: 'string' } }),
                render: (_args, value) => {
                    const v = value;
                    if (v.error !== undefined)
                        return [{ type: 'text', text: `按键失败：${v.error}` }];
                    return [{ type: 'text', text: `已按下 ${v.combo ?? ''}` }];
                },
            },
            execute: wrap(async (svc, args) => {
                const a = (args ?? {});
                if (typeof a.combo !== 'string' || a.combo === '')
                    throw new Error('combo 必填（如 win+r）');
                return svc.run('key', { combo: a.combo });
            }),
        });
        /* ── 滚轮 ── */
        tools.register({
            name: 'computer_scroll',
            description: '在指定坐标（或当前鼠标位置）滚动滚轮。direction: up/down；clicks: 滚动格数（1-20，默认 3）。',
            parameters: {
                type: 'object',
                additionalProperties: false,
                required: ['direction'],
                properties: {
                    direction: { type: 'string', enum: ['up', 'down'], description: '滚动方向' },
                    clicks: { type: 'number', description: '滚动格数（默认 3）' },
                    x: { type: 'number', description: '可选：先移动鼠标到此横坐标' },
                    y: { type: 'number', description: '可选：先移动鼠标到此纵坐标' },
                },
            },
            output: {
                schema: baseOutput({
                    direction: { type: 'string' }, clicks: { type: 'number' },
                }),
                render: (_args, value) => {
                    const v = value;
                    if (v.error !== undefined)
                        return [{ type: 'text', text: `滚动失败：${v.error}` }];
                    return [{ type: 'text', text: `已向 ${v.direction ?? 'down'} 滚动 ${v.clicks ?? 0} 格` }];
                },
            },
            execute: wrap(async (svc, args) => {
                const a = (args ?? {});
                const direction = a.direction === 'up' ? 'up' : 'down';
                const clicks = Math.max(1, Math.min(20, Math.round(a.clicks ?? 3)));
                const payload = { direction, clicks };
                if (typeof a.x === 'number' && typeof a.y === 'number') {
                    payload.x = Math.round(a.x);
                    payload.y = Math.round(a.y);
                }
                return svc.run('scroll', payload);
            }),
        });
        /* ── 窗口列表 ── */
        tools.register({
            name: 'computer_window_list',
            description: '列出当前所有可见顶层窗口（z 序，前台在前）：标题、进程 id、位置尺寸。' +
                '用于 computer_window_focus / computer_click 前了解桌面窗口布局。',
            parameters: { type: 'object', additionalProperties: false, properties: {} },
            output: {
                schema: baseOutput({
                    count: { type: 'number', description: '窗口数量' },
                    topTitle: { type: 'string', description: '当前前台窗口标题' },
                    titles: { type: 'string', description: '全部窗口标题（换行分隔，前台的在前）' },
                }),
                render: (_args, value) => {
                    const v = value;
                    if (v.error !== undefined)
                        return [{ type: 'text', text: `窗口列举失败：${v.error}` }];
                    return [{ type: 'text', text: `共 ${v.count ?? 0} 个可见窗口：\n${v.titles ?? ''}` }];
                },
            },
            execute: wrap(async (svc) => {
                const result = await svc.run('window-list');
                const titles = result.windows.map((w, i) => `${result.windows.length - i}. ${w.title}`).join('\n');
                return { count: result.count, titles };
            }),
        });
        /* ── 窗口聚焦 ── */
        tools.register({
            name: 'computer_window_focus',
            description: '把标题包含指定文字的窗口带到前台（最小化的先还原）。用于切输入目标。',
            parameters: {
                type: 'object',
                additionalProperties: false,
                required: ['match'],
                properties: { match: { type: 'string', description: '窗口标题子串（不区分大小写）' } },
            },
            output: {
                schema: baseOutput({
                    focused: { type: 'boolean' }, pid: { type: 'number' }, title: { type: 'string' },
                }),
                render: (_args, value) => {
                    const v = value;
                    if (v.error !== undefined || v.focused !== true)
                        return [{ type: 'text', text: `聚焦失败：${v.error ?? '未知原因'}` }];
                    return [{ type: 'text', text: `已聚焦窗口「${v.title ?? ''}」（pid ${v.pid ?? 0}）` }];
                },
            },
            execute: wrap(async (svc, args) => {
                const a = (args ?? {});
                if (typeof a.match !== 'string' || a.match === '')
                    throw new Error('match 必填（窗口标题子串）');
                return svc.run('window-focus', { match: a.match });
            }),
        });
        /* ── 剪贴板 ── */
        tools.register({
            name: 'computer_clipboard',
            description: '读写系统剪贴板。action=get 读取当前文本；action=set 写入 text。' +
                '常配合 computer_key（ctrl+v）向应用粘贴内容。',
            parameters: {
                type: 'object',
                additionalProperties: false,
                required: ['action'],
                properties: {
                    action: { type: 'string', enum: ['get', 'set'], description: 'get 读取 / set 写入' },
                    text: { type: 'string', description: 'action=set 时要写入的文本' },
                },
            },
            output: {
                schema: baseOutput({
                    action: { type: 'string' },
                    length: { type: 'number' },
                    text: { type: 'string', description: 'action=get 时的剪贴板文本' },
                }),
                render: (_args, value) => {
                    const v = value;
                    if (v.error !== undefined)
                        return [{ type: 'text', text: `剪贴板操作失败：${v.error}` }];
                    if (v.action === 'set')
                        return [{ type: 'text', text: `已写入剪贴板（${v.length ?? 0} 字符）` }];
                    const preview = (v.text ?? '').slice(0, 200);
                    return [{ type: 'text', text: `剪贴板内容（${v.length ?? 0} 字符）：${preview}` }];
                },
            },
            execute: wrap(async (svc, args) => {
                const a = (args ?? {});
                const action = a.action === 'set' ? 'set' : 'get';
                const payload = { action };
                if (action === 'set') {
                    if (typeof a.text !== 'string')
                        throw new Error('action=set 时 text 必填');
                    payload.text = a.text;
                }
                const result = await svc.run('clipboard', payload);
                return result;
            }),
        });
    }
    catch (e) {
        try {
            console.warn('[dsh-computer] 工具注册失败（跳过）:', e instanceof Error ? e.message : String(e));
        }
        catch { /* 忽略 */ }
    }
}
