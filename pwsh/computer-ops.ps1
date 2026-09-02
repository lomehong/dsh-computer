# dsh-computer worker: persistent PowerShell process with a JSON-line protocol
# (stdin requests / stdout responses, one JSON object per line).
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 files in the
# system ANSI codepage unless a UTF-8 BOM is present; non-ASCII comments/strings
# break parsing on GBK machines. User-facing messages are composed in tools.ts.
#
# Design:
# - DPI awareness declared at startup so screenshot pixels == desktop pixels ==
#   mouse coordinates (single pixel space);
# - all input injection in C# (SendInput): CJK typed per-char via
#   KEYEVENTF_UNICODE (SendKeys mangles CJK); combos press modifiers, tap the
#   key, release modifiers in reverse order;
# - screenshots cover the virtual screen (multi-monitor); coordinates include
#   the origin offset - the top-left of the screenshot is the virtual origin;
# - window enumeration skips invisible/untitled/cloaked UWP ghost windows.
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class DshDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[DshDpi]::SetProcessDPIAware() | Out-Null

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class DshNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)]
  public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public INPUTUNION U; }
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  public const uint INPUT_MOUSE = 0;
  public const uint INPUT_KEYBOARD = 1;
  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP = 0x0004;
  public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
  public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
  public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
  public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
  public const uint MOUSEEVENTF_WHEEL = 0x0800;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public const uint KEYEVENTF_UNICODE = 0x0004;

  [DllImport("user32.dll")]
  private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc proc, IntPtr lParam);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int size);

  private static INPUT KeyInput(ushort vk, ushort scan, uint flags) {
    var i = new INPUT { type = INPUT_KEYBOARD };
    i.U.ki.wVk = vk; i.U.ki.wScan = scan; i.U.ki.dwFlags = flags;
    return i;
  }
  private static INPUT MouseInput(uint flags, uint data) {
    var i = new INPUT { type = INPUT_MOUSE };
    i.U.mi.dwFlags = flags; i.U.mi.mouseData = data;
    return i;
  }

  /** Per-char Unicode typing (CJK-safe): KEYEVENTF_UNICODE down+up per char. */
  public static int SendText(string text) {
    var list = new List<INPUT>();
    foreach (char ch in text) {
      list.Add(KeyInput(0, (ushort)ch, KEYEVENTF_UNICODE));
      list.Add(KeyInput(0, (ushort)ch, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
      if (list.Count >= 200) { SendInput((uint)list.Count, list.ToArray(), Marshal.SizeOf(typeof(INPUT))); list.Clear(); }
    }
    if (list.Count > 0) SendInput((uint)list.Count, list.ToArray(), Marshal.SizeOf(typeof(INPUT)));
    return text.Length;
  }

  /** Combo: modifiers down, key down/up, modifiers up in reverse order. */
  public static void SendCombo(uint[] modifiers, uint key) {
    var downs = new List<INPUT>();
    foreach (uint m in modifiers) downs.Add(KeyInput((ushort)m, 0, 0));
    downs.Add(KeyInput((ushort)key, 0, 0));
    SendInput((uint)downs.Count, downs.ToArray(), Marshal.SizeOf(typeof(INPUT)));
    var ups = new List<INPUT> { KeyInput((ushort)key, 0, KEYEVENTF_KEYUP) };
    for (int i = modifiers.Length - 1; i >= 0; i--) ups.Add(KeyInput((ushort)modifiers[i], 0, KEYEVENTF_KEYUP));
    SendInput((uint)ups.Count, ups.ToArray(), Marshal.SizeOf(typeof(INPUT)));
  }

  public static void MoveTo(int x, int y) { if (!SetCursorPos(x, y)) throw new Exception("SetCursorPos failed"); }
  public static void Click(string button, bool doubleClick) {
    uint down, up;
    if (button == "right") { down = MOUSEEVENTF_RIGHTDOWN; up = MOUSEEVENTF_RIGHTUP; }
    else if (button == "middle") { down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; }
    else { down = MOUSEEVENTF_LEFTDOWN; up = MOUSEEVENTF_LEFTUP; }
    SendInput(1, new[] { MouseInput(down, 0) }, Marshal.SizeOf(typeof(INPUT)));
    SendInput(1, new[] { MouseInput(up, 0) }, Marshal.SizeOf(typeof(INPUT)));
    if (doubleClick) {
      System.Threading.Thread.Sleep(60);
      SendInput(1, new[] { MouseInput(down, 0) }, Marshal.SizeOf(typeof(INPUT)));
      SendInput(1, new[] { MouseInput(up, 0) }, Marshal.SizeOf(typeof(INPUT)));
    }
  }
  public static void Wheel(int direction, int clicks) {
    for (int i = 0; i < clicks; i++)
      SendInput(1, new[] { MouseInput(MOUSEEVENTF_WHEEL, (uint)(direction * 120)) }, Marshal.SizeOf(typeof(INPUT)));
  }

  /** Visible top-level windows in z-order; rows "pid\u0001l,t,r,b\u0001fg\u0001title". */
  public static string[] VisibleWindows() {
    var rows = new List<string>();
    EnumWindows((hWnd, lParam) => {
      if (!IsWindowVisible(hWnd)) return true;
      if (IsIconic(hWnd)) return true;
      int cloaked = 0;
      DwmGetWindowAttribute(hWnd, 14 /* DWMWA_CLOAKED */, out cloaked, sizeof(int));
      if (cloaked != 0) return true;
      var sb = new StringBuilder(512);
      GetWindowText(hWnd, sb, 512);
      string title = sb.ToString().Trim();
      if (title.Length == 0) return true;
      uint pid; GetWindowThreadProcessId(hWnd, out pid);
      RECT r; GetWindowRect(hWnd, out r);
      bool fg = GetForegroundWindow() == hWnd;
      rows.Add(pid + "\u0001" + r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom + "\u0001" + (fg ? "1" : "0") + "\u0001" + title);
      return true;
    }, IntPtr.Zero);
    return rows.ToArray();
  }

  /** Focus the visible main window of a process (restores if minimized). */
  public static bool FocusByPid(int targetPid) {
    IntPtr found = IntPtr.Zero;
    EnumWindowsProc proc = (hWnd, lParam) => {
      if (!IsWindowVisible(hWnd)) return true;
      uint pid; GetWindowThreadProcessId(hWnd, out pid);
      if ((int)pid == targetPid) { found = hWnd; return false; }
      return true;
    };
    EnumWindows(proc, IntPtr.Zero);
    GC.KeepAlive(proc);
    if (found == IntPtr.Zero) return false;
    if (IsIconic(found)) ShowWindow(found, 9 /* SW_RESTORE */);
    return SetForegroundWindow(found);
  }
}
'@

$VK = @{
  win = 0x5B; rwin = 0x5C; ctrl = 0x11; control = 0x11; alt = 0x12; menu = 0x12; shift = 0x10
  enter = 0x0D; tab = 0x09; esc = 0x1B; escape = 0x1B; space = 0x20
  backspace = 0x08; bs = 0x08; delete = 0x2E; del = 0x2E; insert = 0x2D; ins = 0x2D
  home = 0x24; end = 0x23; pgup = 0x21; pgdn = 0x22; pageup = 0x21; pagedown = 0x22
  up = 0x26; down = 0x28; left = 0x25; right = 0x27; printscreen = 0x2C; capslock = 0x14
}
for ($i = 1; $i -le 24; $i++) { $VK[('f{0}' -f $i)] = 0x6F + $i }
foreach ($ch in 'abcdefghijklmnopqrstuvwxyz'.ToCharArray()) { $VK[[string]$ch] = [int]$ch - 32 + 65 }
foreach ($ch in '0123456789'.ToCharArray()) { $VK[[string]$ch] = [int]$ch }

function Resolve-VK([string]$name) {
  $key = $name.Trim().ToLower()
  if (-not $VK.ContainsKey($key)) { throw "unknown key name: $name" }
  return [byte]$VK[$key]
}

function Invoke-Screenshot([string]$outPath) {
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)
  try {
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try { $g.CopyFromScreen($vs.X, $vs.Y, 0, 0, $bmp.Size) } finally { $g.Dispose() }
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally { $bmp.Dispose() }
  return @{ path = $outPath; width = $vs.Width; height = $vs.Height; originX = $vs.X; originY = $vs.Y }
}

function Invoke-Click([int]$x, [int]$y, [string]$button, [bool]$double) {
  [DshNative]::MoveTo($x, $y)
  Start-Sleep -Milliseconds 40
  [DshNative]::Click($button, $double)
  return @{ x = $x; y = $y; button = $button; double = $double }
}

function Invoke-Type([string]$text) {
  if ($text.Length -eq 0) { throw 'text is empty' }
  return @{ length = [DshNative]::SendText($text) }
}

function Invoke-Combo([string]$combo) {
  $parts = $combo.Split('+') | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ -ne '' }
  $mods = @(); $main = $null
  foreach ($p in @($parts)) {
    if (@('ctrl','control','alt','menu','shift','win') -contains $p) { $mods += (Resolve-VK $p) } else { $main = $p }
  }
  if ($null -eq $main) { throw "combo has no main key: $combo" }
  [DshNative]::SendCombo([uint32[]]$mods, (Resolve-VK $main))
  return @{ combo = $combo }
}

function Invoke-Scroll([string]$direction, [int]$clicks, $x, $y) {
  if ($direction -eq 'up') { $dir = 1 } elseif ($direction -eq 'down') { $dir = -1 } else { throw "direction must be up/down" }
  $safe = [Math]::Max(1, [Math]::Min(20, $clicks))
  if ($null -ne $x -and $null -ne $y) { [DshNative]::MoveTo([int]$x, [int]$y) }
  [DshNative]::Wheel($dir, $safe)
  return @{ direction = $direction; clicks = $safe }
}

function Invoke-WindowList {
  $rows = [DshNative]::VisibleWindows()
  $windows = @()
  foreach ($row in $rows) {
    $f = $row.Split([char]1)
    $rect = $f[1].Split(',')
    $windows += @{ pid = [int]$f[0]; rect = @{ left = [int]$rect[0]; top = [int]$rect[1]; right = [int]$rect[2]; bottom = [int]$rect[3] }; foreground = ($f[2] -eq '1'); title = $f[3] }
  }
  return @{ count = $windows.Count; windows = $windows }
}

function Invoke-WindowFocus([string]$match) {
  $rows = [DshNative]::VisibleWindows()
  foreach ($row in $rows) {
    $f = $row.Split([char]1)
    if ($f[3].ToLower().Contains($match.ToLower())) {
      $pid = [int]$f[0]
      if (-not [DshNative]::FocusByPid($pid)) { throw "failed to focus window (pid=$pid)" }
      return @{ focused = $true; pid = $pid; title = $f[3] }
    }
  }
  throw "no visible window whose title contains: $match"
}

function Invoke-Clipboard([string]$action, [string]$text) {
  if ($action -eq 'set') {
    if ([string]::IsNullOrEmpty($text)) { throw 'clipboard text is empty' }
    [System.Windows.Forms.Clipboard]::SetText($text)
    return @{ action = 'set'; length = $text.Length }
  }
  if ($action -eq 'get') {
    $t = [System.Windows.Forms.Clipboard]::GetText()
    return @{ action = 'get'; text = $t }
  }
  throw "action must be get/set"
}

function Invoke-ScreenInfo {
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $monitors = [System.Windows.Forms.Screen]::AllScreens
  $list = @()
  foreach ($m in $monitors) { $list += @{ name = $m.DeviceName; primary = $m.Primary; width = $m.Bounds.Width; height = $m.Bounds.Height; x = $m.Bounds.X; y = $m.Bounds.Y } }
  return @{ virtual = @{ x = $vs.X; y = $vs.Y; width = $vs.Width; height = $vs.Height }; monitors = $list; monitorCount = $monitors.Count }
}

function Invoke-Op([string]$op, $opArgs) {
  switch ($op) {
    'screenshot' { return Invoke-Screenshot ([string]$opArgs.out) }
    'click' {
      $x = [int]$opArgs.x; $y = [int]$opArgs.y
      $button = 'left'; if ($null -ne $opArgs.button -and $opArgs.button -ne '') { $button = [string]$opArgs.button }
      $double = ($opArgs.double -eq $true)
      return Invoke-Click $x $y $button $double
    }
    'type' { return Invoke-Type ([string]$opArgs.text) }
    'key' { return Invoke-Combo ([string]$opArgs.combo) }
    'scroll' {
      $d = 'down'; if ($null -ne $opArgs.direction -and $opArgs.direction -ne '') { $d = [string]$opArgs.direction }
      $c = 3; if ($null -ne $opArgs.clicks) { $c = [int]$opArgs.clicks }
      return Invoke-Scroll $d $c $opArgs.x $opArgs.y
    }
    'window-list' { return Invoke-WindowList }
    'window-focus' { return Invoke-WindowFocus ([string]$opArgs.match) }
    'clipboard' {
      $a = 'get'; if ($null -ne $opArgs.action -and $opArgs.action -ne '') { $a = [string]$opArgs.action }
      $t = ''; if ($null -ne $opArgs.text) { $t = [string]$opArgs.text }
      return Invoke-Clipboard $a $t
    }
    'screen-info' { return Invoke-ScreenInfo }
    default { throw "unknown op: $op" }
  }
}

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  try {
    $req = $line | ConvertFrom-Json
  } catch {
    Write-Output ((@{ id = -1; ok = $false; error = 'request is not valid JSON' }) | ConvertTo-Json -Compress)
    continue
  }
  try {
    $result = Invoke-Op ([string]$req.op) $req.args
    Write-Output ((@{ id = $req.id; ok = $true; result = $result }) | ConvertTo-Json -Compress -Depth 6)
  } catch {
    Write-Output ((@{ id = $req.id; ok = $false; error = $_.Exception.Message }) | ConvertTo-Json -Compress -Depth 4)
  }
}
