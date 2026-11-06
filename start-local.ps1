param(
  [ValidateSet('start','stop','status','restart','foreground','import','package','shortcut','doctor','gemini')]
  [string]$Action = 'start',
  [string]$File,
  [string]$Account,
  [int]$Port = 0,
  [switch]$Install,
  [switch]$NoBrowser
)
# ApplyPilot local program for Windows. Runs only on this computer
# (http://localhost:<port>, bound to 127.0.0.1; default port 8080, change it with
# -Port, which is saved in .env.local). Applications are prepared and submitted
# in your own signed-in Chrome or Edge through the ApplyPilot helper.
#
# Windows PowerShell 5.1 strips double quotes inside arguments passed to native
# programs, so this script never passes JavaScript source to node on the command
# line (no `node -p` / `node -e`). Keep it that way; checks/launcher.test.js
# enforces it.
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$dataDir = Join-Path $PSScriptRoot 'data'
$envFile = Join-Path $PSScriptRoot '.env.local'
$pidFile = Join-Path $dataDir 'applypilot.pid'
$logFile = Join-Path $dataDir 'applypilot.log'
$utf8 = New-Object System.Text.UTF8Encoding $false

function Read-EnvLines { if (Test-Path -LiteralPath $envFile) { return [System.IO.File]::ReadAllLines($envFile) } return @() }
function Get-EnvValue([string[]]$lines, [string]$key) {
  foreach ($line in $lines) { if ($line -match ('^\s*' + [regex]::Escape($key) + '\s*=\s*(.*?)\s*$')) { return $Matches[1] } }
  return $null
}
function Set-EnvValues([System.Collections.IDictionary]$values) {
  $lines = New-Object 'System.Collections.Generic.List[string]'
  foreach ($existing in @(Read-EnvLines)) { $lines.Add([string]$existing) }
  foreach ($key in $values.Keys) {
    $found = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
      if ($lines[$i] -match ('^\s*' + [regex]::Escape($key) + '\s*=')) { $lines[$i] = "$key=$($values[$key])"; $found = $true }
    }
    if (-not $found) { $lines.Add("$key=$($values[$key])") }
  }
  # UTF-8 without a byte-order mark: Windows PowerShell 5.1's "utf8" adds one, which breaks the first setting.
  [System.IO.File]::WriteAllLines($envFile, [string[]]$lines, $utf8)
}
function New-Secret([int]$bytes) {
  $buffer = New-Object byte[] $bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
  return (($buffer | ForEach-Object { $_.ToString('x2') }) -join '')
}
function Test-PortValue([int]$value) { return ($value -ge 1024 -and $value -le 65535) }

# Port: -Port wins and is saved; otherwise .env.local; otherwise 8080.
# (PowerShell variable names are case-insensitive, so the resolved port is $appPort, not $port.)
$portRequested = $Port -ne 0
if ($portRequested -and -not (Test-PortValue $Port)) { throw 'Use a port between 1024 and 65535, for example -Port 8088.' }
$savedPort = 0
[void][int]::TryParse([string](Get-EnvValue @(Read-EnvLines) 'PORT'), [ref]$savedPort)
$appPort = if ($portRequested) { $Port } elseif (Test-PortValue $savedPort) { $savedPort } else { 8080 }
$url = "http://localhost:$appPort"

function Assert-Node {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 24 or newer from https://nodejs.org, then reopen ApplyPilot.' }
  $version = [string](& node --version)
  if ($version -notmatch '^v(\d+)\.') { throw "Could not read the Node.js version ($version)." }
  if ([int]$Matches[1] -lt 24) { throw "Node.js 24 or newer is required (found $version)." }
  if ($Install -or -not (Test-Path -LiteralPath 'node_modules')) {
    & npm.cmd ci --omit=dev
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
  }
}
function Initialize-Env {
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
  if (-not (Test-Path -LiteralPath $envFile)) {
    $registrationCode = New-Secret 24
    Set-EnvValues ([ordered]@{ PORT = $appPort; BIND_HOST = '127.0.0.1'; PUBLIC_ORIGIN = $url; SERVICE_ORIGIN = $url; LOCAL_BROWSER_ONLY = 'true'; DATABASE_PATH = './data/applypilot.sqlite'; UPLOAD_DIR = './data/resumes'; SESSION_SECRET = (New-Secret 32); REGISTRATION_CODE = $registrationCode })
    Write-Host "Registration code for your new local account: $registrationCode"
    Write-Host 'It is saved in .env.local. Keep that file private.'
  } elseif ($portRequested -or (Get-EnvValue @(Read-EnvLines) 'PUBLIC_ORIGIN') -ne $url) {
    # Keep the port and the origins the server and helper use in step.
    Set-EnvValues ([ordered]@{ PORT = $appPort; PUBLIC_ORIGIN = $url; SERVICE_ORIGIN = $url })
  }
}
function Get-RunningProcess {
  if (-not (Test-Path -LiteralPath $pidFile)) { return $null }
  $raw = ([System.IO.File]::ReadAllText($pidFile)).Trim()
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
function Test-PortFree {
  # Something answering on the port (for example a Docker service) means it is taken.
  $client = New-Object System.Net.Sockets.TcpClient
  try { if ($client.ConnectAsync('127.0.0.1', $appPort).Wait(700) -and $client.Connected) { return $false } } catch {} finally { $client.Dispose() }
  # Loopback only (a 0.0.0.0 test bind would raise a Windows Firewall prompt). The
  # connection test above covers services bound to 0.0.0.0, such as Docker ports.
  $listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback), $appPort
  try { $listener.ExclusiveAddressUse = $true; $listener.Start() } catch { return $false } finally { try { $listener.Stop() } catch {} }
  return $true
}
function Build-Extension { & node package-extension.js; if ($LASTEXITCODE -ne 0) { throw 'Extension packaging failed.' } }
function Start-ApplyPilot {
  Assert-Node; Initialize-Env; Build-Extension
  if (Get-RunningProcess) { Write-Host "ApplyPilot is already running at $url" }
  else {
    # Never stop or reuse another program's port.
    if (-not (Test-PortFree)) { throw "Port $appPort is already used by another program on this PC. ApplyPilot leaves it running. Start ApplyPilot on a free port instead, for example: ApplyPilot.cmd start -Port 8088" }
    $p = Start-Process -FilePath (Get-Command node).Source -ArgumentList '--env-file=.env.local','start.js' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err" -PassThru
    [System.IO.File]::WriteAllText($pidFile, [string]$p.Id)
    for ($i = 0; $i -lt 30 -and -not (Test-Healthy); $i++) { Start-Sleep -Milliseconds 500 }
    if (-not (Test-Healthy)) { throw "ApplyPilot did not start. See $logFile and $logFile.err" }
    Write-Host "ApplyPilot is running at $url (log: $logFile)"
  }
  if ($appPort -ne 8080) { Write-Host "In the ApplyPilot helper popup choose This PC (localhost) and set the local port to $appPort." }
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
  'status'     { if (Get-RunningProcess) { Write-Host ("Running at $url" + $(if (Test-Healthy) { '' } else { ' (not responding yet)' })) } else { Write-Host "Not running (configured for $url)." } }
  'foreground' {
    Assert-Node; Initialize-Env; Build-Extension
    if (-not (Test-PortFree)) { throw "Port $appPort is already used by another program on this PC. Use -Port with a free port, for example -Port 8088." }
    Write-Host "Open $url/setup in Chrome or Edge. Keep this window open."
    & node --env-file=.env.local start.js
  }
  'package'    { Assert-Node; Build-Extension }
  'import'     {
    if (-not $File) { throw 'Use: ApplyPilot.cmd import -File C:\path\to\applypilot-import.json' }
    Assert-Node; Initialize-Env
    $importArgs = @('--env-file=.env.local', 'import-local.js', $File); if ($Account) { $importArgs += $Account }
    & node @importArgs
    if ($LASTEXITCODE -ne 0) { throw 'Import failed.' }
  }
  'doctor'     { Assert-Node; Initialize-Env; & node --env-file=.env.local doctor.js }
  'gemini'     {
    # The key is typed into a hidden prompt and written only to .env.local (git-ignored).
    # It is never printed, logged or sent anywhere except Google's Gemini API.
    Initialize-Env
    $secure = Read-Host 'Paste your Gemini API key (input hidden; press Enter alone to cancel)' -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    if (-not $key) { Write-Host 'No change.'; return }
    if ($key -notmatch '^[A-Za-z0-9_\-]{20,200}$') { $key = $null; throw 'That does not look like a Gemini API key. Nothing was saved.' }
    Set-EnvValues ([ordered]@{ GEMINI_API_KEY = $key })
    $key = $null
    Write-Host 'Gemini key saved to .env.local (not shown). Run ApplyPilot.cmd restart, then turn on Gemini professional-fact drafting in your profile.'
  }
  'shortcut'   {
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'ApplyPilot.lnk'))
    $link.TargetPath = Join-Path $PSScriptRoot 'ApplyPilot.cmd'; $link.WorkingDirectory = $PSScriptRoot; $link.Save()
    Write-Host 'Desktop shortcut created.'
  }
}
