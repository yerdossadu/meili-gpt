$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
& (Join-Path $root 'prepare-railway-study.ps1')
if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw 'Preparing Railway data failed.' }
$cli = Join-Path $root '.local\railway-tools\railway.exe'
if (-not (Test-Path -LiteralPath $cli)) { throw 'The existing Railway CLI is missing.' }
# Upload only this explicit set, never railway-study/.local or local credentials.
$upload = Join-Path $root ('.local\railway-uploads\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $upload -Force | Out-Null
foreach ($file in @('Dockerfile','launch.py','railway.json','requirements.txt')) {
    Copy-Item -LiteralPath (Join-Path $root "railway-study\$file") -Destination $upload
}
foreach ($folder in @('study','seed')) {
    Copy-Item -LiteralPath (Join-Path $root "railway-study\$folder") -Destination $upload -Recurse
}
& (Join-Path $root '.venv\Scripts\python.exe') (Join-Path $root 'deploy\railway\verify_upload.py') $upload
if ($LASTEXITCODE -ne 0) { throw 'Railway package validation failed.' }
& $cli up $upload --path-as-root --no-gitignore --detach --project e672782e-b804-449b-80be-bbe731fff3d6 --service ccf1acdc-3983-4b57-b7c0-f6e75cf86e8c --environment production --message 'Refresh published learning pages and translation runtime'
if ($LASTEXITCODE -ne 0) { throw 'Railway upload failed.' }
Write-Output 'Upload submitted. Verify Railway deployment health and the live page before reporting completion.'
