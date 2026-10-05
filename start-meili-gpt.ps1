param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$python = Join-Path $root '.venv\Scripts\python.exe'
$node = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
if (-not (Test-Path -LiteralPath $node)) { $node = (Get-Command node -ErrorAction Stop).Source }
if (-not (Test-Path -LiteralPath $python)) { throw 'Local Python environment is missing. See README.md.' }
$local = Join-Path $root '.local'
New-Item -ItemType Directory -Force -Path $local | Out-Null
$configFile = Join-Path $local 'settings.json'
if (-not (Test-Path -LiteralPath $configFile)) {
    $settings = @{ ADMIN_PASSWORD = [guid]::NewGuid().ToString('N'); FORMA_PUBLISH_TOKEN = [guid]::NewGuid().ToString('N') }
    $settings | ConvertTo-Json | Set-Content -LiteralPath $configFile -Encoding UTF8
}
$settings = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
$env:ADMIN_PASSWORD = $settings.ADMIN_PASSWORD
$env:FORMA_PUBLISH_TOKEN = $settings.FORMA_PUBLISH_TOKEN
$env:FORMA_PLATFORM_TOKEN = $settings.FORMA_PUBLISH_TOKEN
$env:CHAO_DATA_DIR = Join-Path $root 'data\study'
$env:FORMA_OCR_URL = 'http://127.0.0.1:4182/ocr'
$env:PDF_RENDER_PORT = '4181'
$env:FORMA_OCR_PORT = '4182'
function Start-LocalService($name, $executable, $arguments, $directory, $port, $healthPath) {
    $pidFile = Join-Path $local "$name.pid"
    $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($listener) {
        $owner = @($listener.OwningProcess | Select-Object -Unique)[0]
        $info = Get-CimInstance Win32_Process -Filter "ProcessId = $owner" -ErrorAction SilentlyContinue
        if ($info.CommandLine -like "*$root*") { $owner | Set-Content -LiteralPath $pidFile; return }
        throw "Port $port is occupied by another service."
    }
    $started = Start-Process -FilePath $executable -ArgumentList $arguments -WorkingDirectory $directory -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $local "$name.stdout.log") -RedirectStandardError (Join-Path $local "$name.stderr.log")
    $started.Id | Set-Content -LiteralPath $pidFile
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 300
        if ($started.HasExited) { throw "$name stopped. See .local\$name.stderr.log." }
        try {
            Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port$healthPath" -TimeoutSec 2 | Out-Null
            $owner = Get-NetTCPConnection -LocalPort $port -State Listen | Select-Object -ExpandProperty OwningProcess -Unique
            $owner | Select-Object -First 1 | Set-Content -LiteralPath $pidFile
            return
        } catch {}
    }
    throw "$name did not respond. See .local\$name.stderr.log."
}
$env:PORT = '8010'
$studyScript = '"' + (Join-Path $root 'study\server.py') + '"'
Start-LocalService 'study' $python @($studyScript) (Join-Path $root 'study') 8010 '/'
$env:PORT = '4180'
$studioScript = '"' + (Join-Path $root 'studio\server.mjs') + '"'
Start-LocalService 'studio' $node @('--use-system-ca', $studioScript) (Join-Path $root 'studio') 4180 '/'
$pdfScript = '"' + (Join-Path $root 'studio\pdf-renderer.mjs') + '"'
Start-LocalService 'pdf' $node @('--use-system-ca', $pdfScript) (Join-Path $root 'studio') 4181 '/health'
$ocrPython = Join-Path $root 'studio\ocr-runtime\Scripts\python.exe'
if (Test-Path -LiteralPath $ocrPython) {
    $ocrScript = '"' + (Join-Path $root 'studio\pdf-ocr.py') + '"'
    Start-LocalService 'ocr' $ocrPython @($ocrScript) (Join-Path $root 'studio') 4182 '/health'
} else { Write-Output 'OCR is not installed in this copy. The platform, studio and PDF viewer are available.' }
Write-Output 'Meili GPT: http://127.0.0.1:8010'
Write-Output 'Meili GPT Studio: http://127.0.0.1:4180'
if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:8010'; Start-Process 'http://127.0.0.1:4180' }
