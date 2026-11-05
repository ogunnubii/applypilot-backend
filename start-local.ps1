param(
  [ValidateSet('start','stop','status','restart','foreground','import','package','shortcut')]
  [string]$Action = 'start',
  [string]$File,
  [string]$Account,
  [switch]$Install,
  [switch]$NoBrowser
)
# ApplyPilot local program for Windows. Runs only on this computer
# (http://localhost:8080, bound to 127.0.0.1). Applications are prepared and
# submitted in your own signed-in Chrome or Edge through the ApplyPilot helper.
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$dataDir = Join-Path $PSScriptRoot 'data'
$pidFile = Join-Path $dataDir 'applypilot.pid'
$logFile = Join-Path $dataDir 'applypilot.log'
$url = 'http://localhost:8080'

function Assert-Node {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 24 or newer from https://nodejs.org, then reopen ApplyPilot.' }
  if ([int]((& node -p 'process.versions.node.split(".")[0]')) -lt 24) { throw 'Node.js 24 or newer is required.' }
  if ($Install -or -not (Test-Path -LiteralPath 'node_modules')) {
    & npm.cmd ci --omit=dev
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
  }
}
function Initialize-Env {
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
  if (-not (Test-Path -LiteralPath '.env.local')) {
    $sessionSecret = & node -p 'require("node:crypto").randomBytes(32).toString("hex")'
    $registrationCode = & node -p 'require("node:crypto").randomBytes(24).toString("hex")'
    $lines = @("PORT=8080", "BIND_HOST=127.0.0.1", "PUBLIC_ORIGIN=$url", "SERVICE_ORIGIN=$url", "LOCAL_BROWSER_ONLY=true", "DATABASE_PATH=./data/applypilot.sqlite", "UPLOAD_DIR=./data/resumes", "SESSION_SECRET=$sessionSecret", "REGISTRATION_CODE=$registrationCode")
    # UTF-8 without a byte-order mark: Windows PowerShell 5.1's "utf8" adds one, which breaks the first setting.
    [System.IO.File]::WriteAllLines((Join-Path $PSScriptRoot '.env.local'), [string[]]$lines, (New-Object System.Text.UTF8Encoding $false))
    Write-Host "Registration code for your new local account: $registrationCode"
    Write-Host 'It is saved in .env.local. Keep that file private.'
  }
}
function Get-RunningProcess {
  if (-not (Test-Path -LiteralPath $pidFile)) { return $null }
  $raw = (Get-Content -LiteralPath $pidFile -Raw).Trim()
  $id = 0
  if (-not [int]::TryParse($raw, [ref]$id)) { Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue; return $null }
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($p -and $p.ProcessName -match '^node') { return $p }
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  return $null
}
function Test-Healthy {
  try { return (Invoke-WebRequest -UseBasicParsing -Uri "$url/api/health" -TimeoutSec 3).StatusCode -eq 200 } catch { return $false }
}
function Build-Extension { & node package-extension.js; if ($LASTEXITCODE -ne 0) { throw 'Extension packaging failed.' } }
function Start-ApplyPilot {
  Assert-Node; Initialize-Env; Build-Extension
  if (Get-RunningProcess) { Write-Host "ApplyPilot is already running at $url" }
  else {
    $p = Start-Process -FilePath (Get-Command node).Source -ArgumentList '--env-file=.env.local','start.js' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err" -PassThru
    [System.IO.File]::WriteAllText($pidFile, [string]$p.Id)
    for ($i = 0; $i -lt 30 -and -not (Test-Healthy); $i++) { Start-Sleep -Milliseconds 500 }
    if (-not (Test-Healthy)) { throw "ApplyPilot did not start. See $logFile and $logFile.err" }
    Write-Host "ApplyPilot is running at $url (log: $logFile)"
  }
  Write-Host 'Use the Start/Stop switch on the dashboard to run or pause applications; it is remembered across restarts.'
  if (-not $NoBrowser) { Start-Process "$url/setup" }
}
function Stop-ApplyPilot {
  $p = Get-RunningProcess
  if (-not $p) { Write-Host 'ApplyPilot is not running.'; return }
  Stop-Process -Id $p.Id
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  Write-Host 'ApplyPilot stopped. Open applications in your browser are left as they are; nothing is submitted while it is stopped.'
}

switch ($Action) {
  'start'      { Start-ApplyPilot }
  'stop'       { Stop-ApplyPilot }
  'restart'    { Stop-ApplyPilot; Start-ApplyPilot }
  'status'     { if (Get-RunningProcess) { Write-Host ("Running at $url" + $(if (Test-Healthy) { '' } else { ' (not responding yet)' })) } else { Write-Host 'Not running.' } }
  'foreground' { Assert-Node; Initialize-Env; Build-Extension; Write-Host "Open $url/setup in Chrome or Edge. Keep this window open."; & node --env-file=.env.local start.js }
  'package'    { Assert-Node; Build-Extension }
  'import'     {
    if (-not $File) { throw 'Use: ApplyPilot.cmd import -File C:\path\to\applypilot-import.json' }
    Assert-Node; Initialize-Env
    $importArgs = @('--env-file=.env.local', 'import-local.js', $File); if ($Account) { $importArgs += $Account }
    & node @importArgs
    if ($LASTEXITCODE -ne 0) { throw 'Import failed.' }
  }
  'shortcut'   {
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'ApplyPilot.lnk'))
    $link.TargetPath = Join-Path $PSScriptRoot 'ApplyPilot.cmd'; $link.WorkingDirectory = $PSScriptRoot; $link.Save()
    Write-Host 'Desktop shortcut created.'
  }
}
