$ErrorActionPreference = 'Stop'
$extensionPath = Join-Path $PSScriptRoot 'extension'
$archivePath = Join-Path $PSScriptRoot 'web/applypilot-local.zip'
Compress-Archive -Path (Join-Path $extensionPath '*') -DestinationPath $archivePath -Force
Write-Host "Extension packaged at $archivePath"
