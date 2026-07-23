# os-screenshot.ps1 — 전체 화면(가상 데스크톱 전체) 합성 스크린샷.
# CDP Page.captureScreenshot 은 단일 WebContents 렌더 결과만 캡처하므로
# WebContentsView 간 z-order(겹침) 검증에는 쓸 수 없다 — OS 합성 결과를 직접 찍어야 한다.
#
# 사용: powershell -NoProfile -ExecutionPolicy Bypass -File os-screenshot.ps1 -OutPath <png경로>

param(
  [Parameter(Mandatory = $true)]
  [string]$OutPath
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

try {
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bmp)
  $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)

  $dir = Split-Path -Parent $OutPath
  if ($dir -and -not (Test-Path $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }

  $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose()
  $bmp.Dispose()

  Write-Output "OK $OutPath"
  exit 0
} catch {
  Write-Error "SCREENSHOT_FAILED: $($_.Exception.Message)"
  exit 1
}
