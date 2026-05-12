param(
  [switch]$Remove,
  [string]$Address = "127.0.0.1",
  [string[]]$Names = @(
    "ctsglobal-login.sbside.com"
  )
)

$ErrorActionPreference = "Stop"

function Assert-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated PowerShell prompt."
  }
}

Assert-Admin

$hostsPath = Join-Path $env:SystemRoot "System32\drivers\etc\hosts"
$markerStart = "# BEGIN RevivalSide"
$markerEnd = "# END RevivalSide"
$content = ""
if (Test-Path -LiteralPath $hostsPath) {
  $content = Get-Content -LiteralPath $hostsPath -Raw
}

$backupPath = "$hostsPath.revivalside.$(Get-Date -Format yyyyMMddHHmmss).bak"
Copy-Item -LiteralPath $hostsPath -Destination $backupPath -Force

$pattern = "(?ms)^$([regex]::Escape($markerStart)).*?^$([regex]::Escape($markerEnd))\r?\n?"
$content = [regex]::Replace($content, $pattern, "")

if (-not $Remove) {
  $block = @(
    $markerStart
    "$Address $($Names -join ' ')"
    $markerEnd
    ""
  ) -join [Environment]::NewLine

  if ($content.Length -gt 0 -and -not $content.EndsWith([Environment]::NewLine)) {
    $content += [Environment]::NewLine
  }
  $content += $block
}

Set-Content -LiteralPath $hostsPath -Value $content -Encoding ASCII
Write-Host "[hosts] updated $hostsPath"
Write-Host "[hosts] backup $backupPath"
