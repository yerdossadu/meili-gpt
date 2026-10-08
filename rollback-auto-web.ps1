$ErrorActionPreference = 'Stop'
$backup = Join-Path $PSScriptRoot '.local/backups/auto-web-before'
Copy-Item -LiteralPath (Join-Path $backup 'server.mjs') -Destination (Join-Path $PSScriptRoot 'studio/server.mjs')
Copy-Item -LiteralPath (Join-Path $backup 'console.js') -Destination (Join-Path $PSScriptRoot 'studio/webbook/console.js')
& (Join-Path $PSScriptRoot 'restart-studio.ps1')
Write-Output 'Автоматический режим отключён. Сохранённые результаты и исходные материалы остаются в библиотеке.'
