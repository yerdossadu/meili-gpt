param([string]$BookId = '', [int]$PageNumber = 0)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
& node (Join-Path $root 'export-web-pages.mjs') $BookId $PageNumber
if ($LASTEXITCODE -ne 0) { throw 'Web page export failed.' }
$source = Join-Path $root 'approved-web-pages'
$destination = Join-Path ([Environment]::GetFolderPath('Desktop')) 'web версии страниц'
if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw 'Prepared web pages are missing.' }
New-Item -ItemType Directory -Force -Path $destination | Out-Null
foreach ($entry in Get-ChildItem -LiteralPath $source) {
    Copy-Item -LiteralPath $entry.FullName -Destination $destination -Recurse -Force
}
$count = 0
foreach ($file in Get-ChildItem -LiteralPath $source -File -Recurse) {
    $relative = $file.FullName.Substring($source.Length).TrimStart('\')
    $copy = Join-Path $destination $relative
    if ((Get-FileHash -LiteralPath $file.FullName).Hash -ne (Get-FileHash -LiteralPath $copy).Hash) {
        throw "Copy verification failed: $relative"
    }
    $count++
}
Write-Output "Verified $count files copied to $destination"
