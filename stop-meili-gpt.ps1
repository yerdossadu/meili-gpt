$ErrorActionPreference = 'Stop'
$local = Join-Path $PSScriptRoot '.local'
foreach ($name in @('study','studio','pdf','ocr')) {
    $pidFile = Join-Path $local "$name.pid"
    if (-not (Test-Path -LiteralPath $pidFile)) { continue }
    $serviceId = [int](Get-Content -LiteralPath $pidFile)
    $info = Get-CimInstance Win32_Process -Filter "ProcessId = $serviceId" -ErrorAction SilentlyContinue
    if ($info -and $info.CommandLine -like "*$PSScriptRoot*") { Stop-Process -Id $serviceId }
    Remove-Item -LiteralPath $pidFile
}
