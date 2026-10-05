$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$server = Join-Path $root 'study\server.py'
$local = Join-Path $root '.local'
$listener = Get-NetTCPConnection -LocalPort 8010 -State Listen -ErrorAction SilentlyContinue
foreach ($processId in @($listener.OwningProcess | Select-Object -Unique)) {
    if (-not $processId) { continue }
    $info = Get-CimInstance Win32_Process -Filter "ProcessId = $processId"
    if ($info.CommandLine -notlike "*$server*") { throw 'Port 8010 belongs to a different project.' }
    Stop-Process -Id $processId
}
$settings = Get-Content -LiteralPath (Join-Path $local 'settings.json') -Raw | ConvertFrom-Json
$env:ADMIN_PASSWORD = $settings.ADMIN_PASSWORD
$env:FORMA_PUBLISH_TOKEN = $settings.FORMA_PUBLISH_TOKEN
$env:CHAO_DATA_DIR = Join-Path $root 'data\study'
$env:PORT = '8010'
$started = Start-Process -FilePath (Join-Path $root '.venv\Scripts\python.exe') -ArgumentList @(('"' + $server + '"')) -WorkingDirectory (Join-Path $root 'study') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $local 'study.stdout.log') -RedirectStandardError (Join-Path $local 'study.stderr.log')
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 300
    try {
        Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8010/' -TimeoutSec 2 | Out-Null
        Get-NetTCPConnection -LocalPort 8010 -State Listen | Select-Object -ExpandProperty OwningProcess -Unique | Select-Object -First 1 | Set-Content -LiteralPath (Join-Path $local 'study.pid')
        Write-Output 'Meili GPT: http://127.0.0.1:8010/'
        exit 0
    } catch {}
}
throw 'Study did not respond. See .local\study.stderr.log.'
