param(
  [Parameter(Mandatory = $true)][string]$ScriptFile
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $ScriptFile)) { throw "script not found: $ScriptFile" }
$source = [IO.File]::ReadAllText($ScriptFile)

$app = New-Object -ComObject Illustrator.Application
$result = $app.DoJavaScript($source)

if (-not [string]::IsNullOrEmpty($result)) { Write-Output $result }
