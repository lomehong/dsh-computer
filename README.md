# dsh-computer · 电脑操作插件

dsh（DeepSeek Harness）插件：让 agent 具备操控**真实桌面**的能力——屏幕截图、
鼠标点击/滚轮、键盘输入（支持中文）、窗口管理、剪贴板。补齐与"电脑操作型
agent"（如 ZCode）的能力差距，全部本地实现，无外部服务依赖。

## 架构

```
agent（模型）──调用工具──→ @dsh-extra/dsh-computer/tools（agent plane）
                              │ ctx.get('computer')
                              ▼
                    computer 服务（宿主平面，本插件 provide）
                              │ JSON-line（stdin/stdout）
                              ▼
                    持久 PowerShell worker（Win32 P/Invoke 常驻）
                     ├─ SendInput：鼠标/键盘（中文经 UNICODE 事件）
                     ├─ CopyFromScreen：截图（虚拟屏，多显示器）
                     └─ EnumWindows + DWM：可见窗口枚举（跳过 cloaked）
```

- **持久 worker**：`pwsh/computer-ops.ps1` 常驻进程，Win32 P/Invoke 编译一次
  复用（后续操作毫秒级）；空闲 10 分钟自动回收，插件卸载兜底杀进程；
- **DPI 感知**：worker 启动即声明 `SetProcessDPIAware`——截图像素 = 桌面像素
  = 点击坐标，三者同一像素空间，模型"看哪点哪"不会因缩放错位；
- **中文输入**：`SendInput` 的 `KEYEVENTF_UNICODE` 逐字符发送（SendKeys 会
  毁中文）；组合键先按修饰键、点按主键、逆序释放；
- **单遍串行**：GUI 操作有状态（焦点/相对位置），工具调用逐条排队执行。

## 工具清单

| 工具 | 功能 | 说明 |
|---|---|---|
| `computer_screenshot` | 截图 | 覆盖虚拟屏（多显示器），PNG 落盘返回路径，配 `read_image` 查看；坐标原点 = 截图左上角 |
| `computer_click` | 鼠标点击 | x/y 坐标（= 截图像素坐标），left/right/middle，可双击 |
| `computer_type` | 键盘输入 | 逐字符 Unicode 输入（支持中文）到当前焦点窗口 |
| `computer_key` | 组合键 | `win+r`、`ctrl+shift+t`、`enter`、`f5` 等任意组合 |
| `computer_scroll` | 滚轮 | up/down，1-20 格，可先定位坐标 |
| `computer_window_list` | 窗口列表 | 可见顶层窗口（z 序）：标题/pid/位置/前台标记 |
| `computer_window_focus` | 窗口聚焦 | 按标题子串聚焦（最小化先还原） |
| `computer_clipboard` | 剪贴板 | get/set 文本，常配合 `ctrl+v` 向应用粘贴 |

典型工作流：`screenshot`（看屏幕）→ `click`（点输入框）→ `type`（输入）→
`key`（enter 提交）→ `screenshot`（确认结果）。

## 配置

settings.yaml 的 `computer` 节（热生效）：

```yaml
computer:
  enabled: true   # 总开关（关闭时工具返回明确错误，不静默失败）
```

## 安全边界（重要）

- **操作的是真实桌面**：影响所有应用，**包括沙箱外的**（SendInput 不受
  dsh 沙箱约束）——这是与 pwsh 工具的本质区别；
- **工具可用性由 preset 决定**（宿主可用 ≠ 工具可用）：对不可信会话，
  从预设移除 `tool-computer` 行即可完全关闭；
- **enabled 开关**：settings 的 `computer.enabled` 热生效，关掉后所有工具
  返回明确错误（不静默失败）；
- **UAC 高权限窗口**：非提升进程的注入会被 UIPI 拦截（点击/输入对管理员
  权限窗口无效）——这是 Windows 的边界，不是插件缺陷；
- 与「转人工」机制（dsh-twin）互补：高风险操作先经 Owner 审批再执行。

## 版本兼容

| dsh 版本 | 状态 | 说明 |
|---|---|---|
| 0.1.2-alpha.3 | ✅ | 实测环境 |
| 0.1.2-alpha.4 | ✅ | 未使用任何 alpha.4 变更项（Session.events / SessionSeq 均不涉及） |

## 已知边界

- 仅 Windows（worker 依赖 user32/gdi32/dwmapi；跨平台需为 macOS/Linux 实现
  对应 worker）；
- 截图为整屏 PNG（未做窗口裁剪/区域裁剪，v2 可加）；
- 需要视觉理解的闭环依赖 `read_image`（截图像素 → 模型视觉）；
- 管理员权限窗口（UAC）不可操作（UIPI）；
- worker 进程常驻期间持有桌面输入权限——插件卸载/空闲 10 分钟自动回收。

## 开发

```bash
npm install
npm test          # vitest：注册契约 5 用例 + 真实桌面 E2E 4 用例（无害操作）
npm run build     # tsc → lib/
npm run typecheck
```

E2E 测试操作真实桌面但只做无害操作（截图/窗口列表/剪贴板往返），不点击
不输入——可在工作时段安全运行。
