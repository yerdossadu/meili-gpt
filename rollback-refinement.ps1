$ErrorActionPreference='Stop'
$taskRoot=$PSScriptRoot
$snapshot=Join-Path $taskRoot '.local\backups\before-refinement'
$files=@('auto-web.mjs','auto-web-console.js','auto-web-reader.js','auto-web-reader.css')
foreach($file in $files){if(-not(Test-Path -LiteralPath (Join-Path $snapshot $file))){throw "Missing snapshot: $file"}}
foreach($file in $files){Copy-Item -LiteralPath (Join-Path $snapshot $file) -Destination (Join-Path $taskRoot "studio\webbook\$file") -Force}
& (Join-Path $taskRoot 'restart-studio.ps1')
Write-Output 'Previous OCR interface restored. Generated pages retained.'
