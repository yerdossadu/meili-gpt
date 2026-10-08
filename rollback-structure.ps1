$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$snapshot = Join-Path $taskRoot '.local\backups\before-structure'
foreach ($file in @('auto-web.mjs','auto-web-console.js','auto-web-reader.js')) {
    $source = Join-Path $snapshot $file
    if (-not (Test-Path -LiteralPath $source)) { throw "Missing rollback snapshot: $file" }
}
foreach ($file in @('auto-web.mjs','auto-web-console.js','auto-web-reader.js')) {
    Copy-Item -LiteralPath (Join-Path $snapshot $file) -Destination (Join-Path $taskRoot "studio\webbook\$file") -Force
}
$taskConfig = Join-Path $taskRoot '.codex\config.toml'
if (Test-Path -LiteralPath $taskConfig) {
    $configText = Get-Content -LiteralPath $taskConfig -Raw
    $pattern = '(?ms)(^\[mcp_servers\.paddleocr_local\]\r?\n(?:(?!^\[).)*?^enabled\s*=\s*)true'
    $configText = [regex]::Replace($configText, $pattern, '${1}false')
    Set-Content -LiteralPath $taskConfig -Value $configText -Encoding utf8
}
& (Join-Path $taskRoot 'restart-studio.ps1')
Write-Output 'Previous automatic OCR mode restored. Converted books retained.'
