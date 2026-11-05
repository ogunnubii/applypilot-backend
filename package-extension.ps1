$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
& node package-extension.js
if ($LASTEXITCODE -ne 0) { throw 'Extension packaging failed.' }
