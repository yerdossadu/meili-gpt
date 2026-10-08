$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$destination = Join-Path $root 'railway-study'
$data = Join-Path $root 'data\study'
$checks = @((Join-Path $data 'library.sqlite3'), (Join-Path $data 'forma\books'), (Join-Path $root 'study\server.py'), (Join-Path $root 'study\testing_gateway.py'))
foreach ($item in $checks) { if (-not (Test-Path -LiteralPath $item)) { throw "Required local source is missing: $item" } }
if (-not (Test-Path -LiteralPath (Join-Path $destination 'Dockerfile'))) { throw 'Railway package is incomplete.' }
$seed = Join-Path $destination 'seed'
& (Join-Path $root '.venv\Scripts\python.exe') (Join-Path $destination 'prepare_seed.py')
if ($LASTEXITCODE -ne 0) { throw 'Could not create the sanitized published lessons seed.' }
New-Item -ItemType Directory -Force -Path (Join-Path $destination 'study'), (Join-Path $seed 'placeholder') | Out-Null
Remove-Item -LiteralPath (Join-Path $seed 'placeholder') -Force
Copy-Item (Join-Path $root 'study\requirements.txt') (Join-Path $destination 'requirements.txt') -Force
foreach ($file in @('server.py','testing_gateway.py','lesson_validation.py','layout.py','forma.py','app.html','manager.html')) { Copy-Item (Join-Path $root "study\$file") (Join-Path $destination "study\$file") -Force }
Copy-Item (Join-Path $root 'study\hanzi') (Join-Path $destination 'study\hanzi') -Recurse -Force
$snapshot = Get-ChildItem -LiteralPath $destination -Recurse -File
$total = ($snapshot | Measure-Object -Property Length -Sum).Sum
Write-Output "Prepared published textbook/workbook and study gateway: $($snapshot.Count) files, $([math]::Round($total / 1MB, 2)) MB"
Write-Output 'The package excludes local user PDFs, settings, API keys, and the Studio project.'
