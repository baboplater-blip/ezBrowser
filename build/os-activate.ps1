# os-activate.ps1 — 지정 PID 가 소유한 최상위 가시 창을 포그라운드로 전환 시도.
#
# OS 합성 스크린샷(z-order 검증)은 대상 창이 실제로 포그라운드일 때만 의미가 있다.
# 이름 기반이 아니라 PID 기반으로 창을 찾는다 — 사용자의 다른 ezBrowser 인스턴스가
# 떠 있어도 우리가 띄운 프로세스의 창만 정확히 겨냥한다.
#
# 주의: Windows 는 포그라운드 탈취 방지 정책이 있어 백그라운드 프로세스의
# SetForegroundWindow 호출이 항상 성공하는 것은 아니다 — best-effort.
#
# 사용: powershell -NoProfile -ExecutionPolicy Bypass -File os-activate.ps1 -ProcessId <pid>

param(
  [Parameter(Mandatory = $true)]
  [int]$ProcessId
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class BBWin32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@

try {
  $targetHwnd = [IntPtr]::Zero

  $callback = {
    param([IntPtr]$hWnd, [IntPtr]$lParam)
    if ([BBWin32]::IsWindowVisible($hWnd)) {
      $procId = 0
      [void][BBWin32]::GetWindowThreadProcessId($hWnd, [ref]$procId)
      if ($procId -eq $ProcessId) {
        $script:targetHwnd = $hWnd
        return $false
      }
    }
    return $true
  }

  [void][BBWin32]::EnumWindows($callback, [IntPtr]::Zero)

  if ($targetHwnd -eq [IntPtr]::Zero) {
    Write-Error "NO_WINDOW_FOR_PID $ProcessId"
    exit 1
  }

  [void][BBWin32]::ShowWindow($targetHwnd, 9) # SW_RESTORE
  $ok = [BBWin32]::SetForegroundWindow($targetHwnd)
  if ($ok) {
    Write-Output "OK hwnd=$targetHwnd"
    exit 0
  } else {
    Write-Error "SetForegroundWindow returned false (포커스 도난 방지로 거부됐을 수 있음) hwnd=$targetHwnd"
    exit 2
  }
} catch {
  Write-Error "ACTIVATE_FAILED: $($_.Exception.Message)"
  exit 1
}
