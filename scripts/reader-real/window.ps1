# Window controller for the real-engine Reader smoke test. Reads one command per line on stdin
# and replies one line: `place PID W H` (restore without activation at the bottom of the
# z-order), `size PID W H`, `close PID` (WM_CLOSE, the native close path), `minimize PID`
# (without activation), `state PID` (`ok VISIBLE ICONIC` of the main window, shown or hidden),
# `monitor PID` (`ok WIDTH HEIGHT DPI` of the main window's monitor, in physical pixels),
# `monitors` (`ok X,Y,W,H,DPI ...`, each monitor's work area in physical pixels), `move PID X Y`
# (to a physical position, without activation) or `quit`. It never activates or focuses the window and sends no mouse or keyboard input.
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class KomoriReaderRealWindow {
  public delegate bool P(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Ri, B; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(P p, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hh, uint f);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct MI { public int cb; public R m; public R w; public int f; }
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr h, ref MI mi);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr h, int t, out uint x, out uint y);
  public static string Monitor(IntPtr h) {
    // Per-monitor aware for this query only, so the monitor reports physical pixels.
    IntPtr previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
    try {
      IntPtr m = MonitorFromWindow(h, 2);
      MI mi = new MI(); mi.cb = Marshal.SizeOf(mi); GetMonitorInfo(m, ref mi);
      uint x, y; GetDpiForMonitor(m, 0, out x, out y);
      return string.Format("ok {0} {1} {2}", mi.m.Ri - mi.m.L, mi.m.B - mi.m.T, x);
    } finally { SetThreadDpiAwarenessContext(previous); }
  }
  public delegate bool M(IntPtr h, IntPtr dc, IntPtr r, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr c, M m, IntPtr l);
  public static string Monitors() {
    IntPtr previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
    try {
      var all = new System.Collections.Generic.List<string>();
      EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (m, dc, r, l) => {
        MI mi = new MI(); mi.cb = Marshal.SizeOf(mi); GetMonitorInfo(m, ref mi);
        uint x, y; GetDpiForMonitor(m, 0, out x, out y);
        all.Add(string.Format("{0},{1},{2},{3},{4}", mi.w.L, mi.w.T, mi.w.Ri - mi.w.L, mi.w.B - mi.w.T, x));
        return true;
      }, IntPtr.Zero);
      return "ok " + string.Join(" ", all);
    } finally { SetThreadDpiAwarenessContext(previous); }
  }
  public static void Move(IntPtr h, int x, int y) {
    IntPtr previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
    try { SetWindowPos(h, IntPtr.Zero, x, y, 0, 0, 0x0001 | 0x0004 | 0x0010); }
    finally { SetThreadDpiAwarenessContext(previous); }
  }
}
"@
$W = [KomoriReaderRealWindow]
function Find-Main([int]$procId) {
  $script:found = [IntPtr]::Zero
  [void]$W::EnumWindows({ param($h, $l)
    $p = 0; [void]$W::GetWindowThreadProcessId($h, [ref]$p)
    $c = New-Object Text.StringBuilder 64; [void]$W::GetClassName($h, $c, 64)
    if ($p -eq $procId -and $c.ToString() -eq 'Tauri Window' -and $W::IsWindowVisible($h)) { $script:found = $h }
    $true }, [IntPtr]::Zero)
  return $script:found
}
# The main window shown or hidden: the largest of the process's Tauri windows.
function Find-Any([int]$procId) {
  $script:found = [IntPtr]::Zero; $script:area = -1
  [void]$W::EnumWindows({ param($h, $l)
    $p = 0; [void]$W::GetWindowThreadProcessId($h, [ref]$p)
    $c = New-Object Text.StringBuilder 64; [void]$W::GetClassName($h, $c, 64)
    if ($p -eq $procId -and $c.ToString() -eq 'Tauri Window') {
      $r = New-Object KomoriReaderRealWindow+R; [void]$W::GetWindowRect($h, [ref]$r)
      $size = ($r.Ri - $r.L) * ($r.B - $r.T)
      if ($size -gt $script:area) { $script:found = $h; $script:area = $size }
    }
    $true }, [IntPtr]::Zero)
  return $script:found
}
$SWP_NOMOVE = 0x0002; $SWP_NOZORDER = 0x0004; $SWP_NOACTIVATE = 0x0010
[Console]::Out.WriteLine('ready')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line -or $line -eq 'quit') { break }
  $a = $line.Trim() -split '\s+'
  if ($a[0] -eq 'monitors') { [Console]::Out.WriteLine($W::Monitors()); continue }
  if ($a[0] -eq 'state') {
    $h = Find-Any ([int]$a[1])
    if ($h -eq [IntPtr]::Zero) { [Console]::Out.WriteLine('err no window') }
    else { [Console]::Out.WriteLine("ok $([int]$W::IsWindowVisible($h)) $([int]$W::IsIconic($h))") }
    continue
  }
  $h = [IntPtr]::Zero
  for ($i = 0; $i -lt 100 -and $h -eq [IntPtr]::Zero; $i++) {
    $h = Find-Main ([int]$a[1])
    if ($h -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 100 }
  }
  if ($h -eq [IntPtr]::Zero) { [Console]::Out.WriteLine('err no window'); continue }
  if ($a[0] -eq 'monitor') { [Console]::Out.WriteLine($W::Monitor($h)); continue }
  switch ($a[0]) {
    'place' {
      if ($W::IsIconic($h)) { [void]$W::ShowWindow($h, 4) }
      [void]$W::SetWindowPos($h, [IntPtr]1, 1000, 120, [int]$a[2], [int]$a[3], $SWP_NOACTIVATE)
    }
    'size' {
      [void]$W::SetWindowPos($h, [IntPtr]::Zero, 0, 0, [int]$a[2], [int]$a[3], $SWP_NOMOVE -bor $SWP_NOZORDER -bor $SWP_NOACTIVATE)
    }
    'close' { [void]$W::PostMessage($h, 0x10, [IntPtr]::Zero, [IntPtr]::Zero) }
    'minimize' { [void]$W::ShowWindow($h, 7) }
    'move' { $W::Move($h, [int]$a[2], [int]$a[3]) }
  }
  $r = New-Object KomoriReaderRealWindow+R; [void]$W::GetWindowRect($h, [ref]$r)
  [Console]::Out.WriteLine("ok $($r.Ri - $r.L) $($r.B - $r.T)")
}
