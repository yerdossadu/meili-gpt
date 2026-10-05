$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$backup = Join-Path $root '.local\backups\fs-before-pdf2htmlex'
$snapshot = Join-Path $root ('.local\backups\pdf2htmlEX-before-rollback-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $snapshot -Force | Out-Null
$files = @{
    'server.mjs' = 'studio\server.mjs'
    'webbook-server.mjs' = 'studio\webbook\server.mjs'
    'console.js' = 'studio\webbook\console.js'
    'console.css' = 'studio\webbook\console.css'
}
foreach ($name in $files.Keys) {
    if (!(Test-Path -LiteralPath (Join-Path $backup $name))) { throw "Backup missing: $name" }
}
foreach ($name in $files.Keys) {
    $target = Join-Path $root $files[$name]
    Copy-Item -LiteralPath $target -Destination (Join-Path $snapshot $name)
    Copy-Item -LiteralPath (Join-Path $backup $name) -Destination $target
}
$console = Join-Path $root 'studio\webbook\console.js'
$text = [IO.File]::ReadAllText($console)
$text = $text.Replace('  const manual = studio.webbookSpeakers || {};', '  const manual = studio.webbookSpeakers || {};'+[Environment]::NewLine+'  if (!chars.length && !Object.keys(manual).length) return { changed: false };')
[IO.File]::WriteAllText($console, $text, [Text.UTF8Encoding]::new($false))
& (Join-Path $root 'restart-studio.ps1')
Write-Output 'Previous FS conversion interface restored. Books and exports retained.'
