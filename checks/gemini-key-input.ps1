$ErrorActionPreference = 'Stop'
$launcher = Join-Path (Split-Path -Parent $PSScriptRoot) 'start-local.ps1'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($launcher, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Launcher has a PowerShell syntax error' }
$definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'ConvertFrom-GeminiKeyInput' }, $true)
if (-not $definition) { throw 'Key input function missing' }
# Extract only the pure validation function; never start the app or touch .env.
. ([ScriptBlock]::Create($definition.Extent.Text))
$standard = 'AIza' + ('A' * 35)
$modern = 'AQ.' + ('B' * 70)
$longModern = 'AQ.' + ('C' * 300)
foreach ($candidate in @($standard, $modern, $longModern, ($modern + '=='))) {
  if ((ConvertFrom-GeminiKeyInput $candidate) -cne $candidate) { throw 'A supported opaque key was changed or rejected' }
}
foreach ($candidate in @(('  ' + $modern + "`r`n"), ('"' + $modern + '"'), ("'" + $modern + "'"))) {
  if ((ConvertFrom-GeminiKeyInput $candidate) -cne $modern) { throw 'Paste padding was not normalized correctly' }
}
if ((ConvertFrom-GeminiKeyInput '   ') -ne '') { throw 'Empty input must cancel' }
foreach ($candidate in @('short', ($modern + "`nOTHER_SETTING=1"), ($modern + ' extra'), ('https://example.test/' + $modern), ('GEMINI_API_KEY=' + $modern), ($modern + ';Start-Process calc'), ('AQ.' + ('D' * 5000)))) {
  $rejected = $false
  try { $null = ConvertFrom-GeminiKeyInput $candidate } catch { $rejected = $true }
  if (-not $rejected) { throw 'Unsafe or malformed input was accepted' }
}
Write-Host 'PASS: Gemini key input compatibility and injection checks'
