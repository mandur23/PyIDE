# Runs a command on a separate, unseen Windows desktop and closes the desktop afterwards, so the Electron windows
# the verify suites open never appear on the desktop the user is working on. Output goes to -Out and is printed.
#   powershell -File verify/on-desktop.ps1 -Out verify/out/run.txt node verify/core.mjs
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$TimeoutMinutes = 30,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Command
)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class OtherDesktop {
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr devmode, int flags, uint access, IntPtr sa);
  [DllImport("user32.dll", SetLastError = true)]
  static extern bool CloseDesktop(IntPtr desktop);

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags,
    IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  const uint GENERIC_ALL = 0x10000000;
  const uint CREATE_NO_WINDOW = 0x08000000;

  // Child processes inherit the desktop, so everything the command starts opens its windows there.
  // A command still running after timeoutMs (a test stuck on something nobody can see) is ended with its whole tree.
  public static int Run(string name, string commandLine, string cwd, uint timeoutMs) {
    IntPtr desktop = CreateDesktop(name, IntPtr.Zero, IntPtr.Zero, 0, GENERIC_ALL, IntPtr.Zero);
    if (desktop == IntPtr.Zero) throw new Win32Exception();
    try {
      var si = new STARTUPINFO();
      si.cb = Marshal.SizeOf(si);
      si.lpDesktop = @"WinSta0\" + name;
      PROCESS_INFORMATION pi;
      if (!CreateProcess(null, commandLine, IntPtr.Zero, IntPtr.Zero, false, CREATE_NO_WINDOW, IntPtr.Zero, cwd, ref si, out pi))
        throw new Win32Exception();
      if (WaitForSingleObject(pi.hProcess, timeoutMs) != 0) {
        System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("taskkill", "/PID " + pi.dwProcessId + " /T /F") { CreateNoWindow = true, UseShellExecute = false }).WaitForExit();
        WaitForSingleObject(pi.hProcess, 10000);
      }
      uint code;
      GetExitCodeProcess(pi.hProcess, out code);
      CloseHandle(pi.hThread);
      CloseHandle(pi.hProcess);
      return (int)code;
    } finally {
      CloseDesktop(desktop);
    }
  }
}
'@

$root = Split-Path $PSScriptRoot -Parent
$outPath = [IO.Path]::GetFullPath((Join-Path $root $Out))
New-Item -ItemType Directory -Force (Split-Path $outPath) | Out-Null
$quoted = ($Command | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' '
$code = [OtherDesktop]::Run("PyIDE-Tests-$PID", "cmd.exe /d /s /c `"$quoted > `"$outPath`" 2>&1`"", $root, [uint32]($TimeoutMinutes * 60000))
Get-Content $outPath -Encoding UTF8
exit $code
