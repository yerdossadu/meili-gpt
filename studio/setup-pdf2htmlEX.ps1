$ErrorActionPreference = 'Stop'
$directory = Join-Path $PSScriptRoot '.tools\pdf2htmlEX'
New-Item -ItemType Directory -Force -Path $directory | Out-Null
$archive = Join-Path $directory 'runtime.zip'
$source = 'https://soft.rubypdf.com/download/pdf2htmlex/pdf2htmlEX-win32-0.14.6-with-poppler-data.zip'
Invoke-WebRequest -UseBasicParsing -Uri $source -OutFile $archive -TimeoutSec 120
$expected = 'E92AA55699C3E9D9B4B4954BEA157E59B5C3363CBE9A7713495C553544026354'
if ((Get-FileHash -LiteralPath $archive).Hash -ne $expected) { throw 'Runtime archive differs from the verified build. Extraction stopped.' }
Expand-Archive -LiteralPath $archive -DestinationPath $directory -Force
& (Join-Path $directory 'pdf2htmlEX.exe') --version
if ($LASTEXITCODE -ne 0) { throw 'pdf2htmlEX failed to start.' }
Write-Output 'pdf2htmlEX installed locally. Restart Forma Studio.'
