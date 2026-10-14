param(
  [Parameter(Mandatory=$true)][string]$Configuration,
  [switch]$Activate,
  [string]$Approval
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 24 or newer is required.' }
if ([int]((& node -p 'process.versions.node.split(".")[0]')) -lt 24) { throw 'Node.js 24 or newer is required.' }
if ($Activate) {
  if (-not $Approval) { throw 'A reviewed cutover approval file is required.' }
  foreach ($executable in @('pdftotext','pdftoppm')) {
    if (-not (Get-Command $executable -ErrorAction SilentlyContinue)) { throw 'The reviewed Poppler runtime must be installed before activation.' }
  }
  & node migration/local-deployment.mjs activate $Configuration $Approval
} else {
  & node migration/local-deployment.mjs preflight $Configuration
}
exit $LASTEXITCODE
