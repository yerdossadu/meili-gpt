$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$server = Join-Path $root 'studio\server.mjs'
$local = Join-Path $root '.local'
$listener = Get-NetTCPConnection -LocalPort 4180 -State Listen -ErrorAction SilentlyContinue
foreach ($processId in @($listener.OwningProcess | Select-Object -Unique)) {
    if (-not $processId) { continue }
    $info = Get-CimInstance Win32_Process -Filter "ProcessId = $processId"
    if ($info.CommandLine -notlike "*$server*") { throw 'Port 4180 belongs to a different project.' }
    Stop-Process -Id $processId
}
$settings = Get-Content -LiteralPath (Join-Path $local 'settings.json') -Raw | ConvertFrom-Json
$env:FORMA_PUBLISH_TOKEN = $settings.FORMA_PUBLISH_TOKEN
$env:FORMA_PLATFORM_TOKEN = $settings.FORMA_PUBLISH_TOKEN
$env:FORMA_OCR_URL = 'http://127.0.0.1:4182/ocr'
$env:PORT = '4180'
$node = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
if (-not (Test-Path -LiteralPath $node)) { $node = (Get-Command node -ErrorAction Stop).Source }
Start-Process -FilePath $node -ArgumentList @('--use-system-ca', ('"' + $server + '"')) -WorkingDirectory (Join-Path $root 'studio') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $local 'studio.stdout.log') -RedirectStandardError (Join-Path $local 'studio.stderr.log') | Out-Null
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 300
    try {
        Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:4180/' -TimeoutSec 2 | Out-Null
        Get-NetTCPConnection -LocalPort 4180 -State Listen | Select-Object -ExpandProperty OwningProcess -Unique | Select-Object -First 1 | Set-Content -LiteralPath (Join-Path $local 'studio.pid')
        Write-Output 'Forma Studio: http://127.0.0.1:4180/'
        return
    } catch {}
}
throw 'FS did not respond. See .local\studio.stderr.log.'
