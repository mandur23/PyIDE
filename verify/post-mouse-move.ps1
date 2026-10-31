# Posts a button-less WM_MOUSEMOVE to the top-level windows of one test instance, five times a second, for -Seconds. It
# goes to those windows' message queues only: the real mouse does not move and no other window sees anything. What ends
# a system drag on a desktop with no mouse (verify/lib.mjs endingSystemDrags).
param([Parameter(Mandatory = $true)][int]$ProcessId, [int]$Seconds = 60)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class TestWindows {
  delegate bool EnumProc(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr data);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  const uint WM_MOUSEMOVE = 0x0200;

  public static void PostMouseMove(uint owner) {
    EnumWindows((window, data) => {
      uint pid;
      GetWindowThreadProcessId(window, out pid);
      if (pid == owner) PostMessage(window, WM_MOUSEMOVE, IntPtr.Zero, IntPtr.Zero);
      return true;
    }, IntPtr.Zero);
  }
}
'@
$end = [DateTime]::UtcNow.AddSeconds($Seconds)
while ([DateTime]::UtcNow -lt $end) {
  [TestWindows]::PostMouseMove([uint32]$ProcessId)
  Start-Sleep -Milliseconds 200
}
