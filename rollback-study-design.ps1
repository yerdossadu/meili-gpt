$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PSScriptRoot)
$backup = Join-Path $root 'study\design-versions\2026-10-05-before-redesign'
$checksums = Get-Content -LiteralPath (Join-Path $backup 'checksums.json') -Raw | ConvertFrom-Json
foreach ($name in @('app.html', 'server.py')) {
    $source = Join-Path $backup $name
    $expected = $checksums | Where-Object { [IO.Path]::GetFileName($_.Path) -eq $name }
    if (-not $expected -or (Get-FileHash -LiteralPath $source).Hash -ne $expected.Hash) { throw "Backup verification failed: $name" }
}
$save = Join-Path $root ('.local\backups\study-before-rollback-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $save -Force | Out-Null
foreach ($name in @('app.html', 'server.py')) {
    $target = [IO.Path]::GetFullPath((Join-Path $root "study\$name"))
    if (-not $target.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Target is outside this project.' }
    Copy-Item -LiteralPath $target -Destination (Join-Path $save $name)
    Copy-Item -LiteralPath (Join-Path $backup $name) -Destination $target
}
& (Join-Path $root 'restart-study.ps1')
