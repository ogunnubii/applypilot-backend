param([switch]$Install)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 24 or newer, then reopen PowerShell.' }
if ([int]((& node -p 'process.versions.node.split(".")[0]')) -lt 24) { throw 'Node.js 24 or newer is required.' }
if ($Install -or -not (Test-Path -LiteralPath 'node_modules')) {
  & npm.cmd ci
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
}
if (-not (Test-Path -LiteralPath '.env.local')) {
  $sessionSecret = & node -p 'require("node:crypto").randomBytes(32).toString("hex")'
  $registrationCode = & node -p 'require("node:crypto").randomBytes(24).toString("hex")'
  @("PORT=8080", "BIND_HOST=127.0.0.1", "PUBLIC_ORIGIN=http://localhost:8080", "SERVICE_ORIGIN=http://localhost:8080", "LOCAL_BROWSER_ONLY=true", "DATABASE_PATH=./data/applypilot.sqlite", "UPLOAD_DIR=./data/resumes", "SESSION_SECRET=$sessionSecret", "REGISTRATION_CODE=$registrationCode") | Set-Content -LiteralPath '.env.local' -Encoding utf8
  Write-Host "Registration code for your new local account: $registrationCode"
}
Write-Host 'Open http://localhost:8080/setup in Chrome or Edge. Keep this terminal running.'
Write-Host 'Your registration code is saved in .env.local. Keep that file private.'
& node --env-file=.env.local start.js
