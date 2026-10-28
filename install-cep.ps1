param()

$ErrorActionPreference = 'Stop'

$source = Join-Path $PSScriptRoot 'cep-extension'
$target = Join-Path $env:APPDATA 'Adobe\CEP\extensions\com.dsh.aebridge'

if (-not (Test-Path -LiteralPath $source)) { throw "cep-extension folder not found next to this script" }
if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item -Path (Join-Path $source '*') -Destination $target -Recurse -Force

foreach ($version in 9..13) {
  $key = "HKCU:\Software\Adobe\CSXS.$version"
  New-Item -Path $key -Force | Out-Null
  New-ItemProperty -Path $key -Name 'PlayerDebugMode' -Value '1' -PropertyType String -Force | Out-Null
}

Write-Host ""
Write-Host "CEP extension installed: $target"
Write-Host "Next: restart After Effects, then Window > Extensions > DSH AE Bridge."
Write-Host ""
