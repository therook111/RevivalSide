param(
  [string]$OutputRoot = "",
  [string]$RuntimeCacheDir = "",
  [string]$NodeVersion = "v22.22.3",
  [string]$WiresharkVersion = "4.6.6",
  [string]$WiresharkWin32Version = "3.6.24",
  [string]$PythonPath = "",
  [ValidateSet("win-x64", "win-x86", "win-arm64")]
  [string[]]$RuntimeIdentifiers = @("win-arm64", "win-x64", "win-x86"),
  [switch]$SkipWireshark,
  [switch]$SkipGameplayJsons,
  [switch]$SkipWikiAssets,
  [switch]$Zip
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$rootPath = $root.Path
if (-not $OutputRoot) {
  $OutputRoot = Join-Path $rootPath "prebuilt"
}
if (-not $RuntimeCacheDir) {
  $RuntimeCacheDir = Join-Path $rootPath "prebuilt\revivalside-mega-runtimes"
}
$OutputRoot = [System.IO.Path]::GetFullPath($OutputRoot)
$RuntimeCacheDir = [System.IO.Path]::GetFullPath($RuntimeCacheDir)
New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null
New-Item -ItemType Directory -Force -Path $RuntimeCacheDir | Out-Null

function Get-RidArchitecture([string]$Rid) {
  switch ($Rid) {
    "win-x64" { return "x64" }
    "win-x86" { return "x86" }
    "win-arm64" { return "arm64" }
    default { throw "Unsupported runtime identifier: $Rid" }
  }
}

function Get-PeMachine([string]$FilePath) {
  if (-not (Test-Path -LiteralPath $FilePath)) { return "" }
  $bytes = [System.IO.File]::ReadAllBytes($FilePath)
  if ($bytes.Length -lt 64) { return "" }
  if ([System.BitConverter]::ToUInt16($bytes, 0) -ne 0x5A4D) { return "" }
  $peOffset = [System.BitConverter]::ToInt32($bytes, 0x3C)
  if ($peOffset -lt 0 -or ($peOffset + 6) -gt $bytes.Length) { return "" }
  $machine = [System.BitConverter]::ToUInt16($bytes, $peOffset + 4)
  switch ($machine) {
    0x014c { return "x86" }
    0x8664 { return "x64" }
    0xaa64 { return "arm64" }
    0x01c4 { return "arm" }
    default { return ("0x{0:x}" -f $machine) }
  }
}

function Test-ExecutableArchitecture([string]$FilePath, [string]$ExpectedArchitecture) {
  return (Test-Path -LiteralPath $FilePath) -and ((Get-PeMachine $FilePath) -eq $ExpectedArchitecture)
}

function Assert-ExecutableArchitecture([string]$FilePath, [string]$ExpectedArchitecture, [string]$Name) {
  if (-not (Test-ExecutableArchitecture $FilePath $ExpectedArchitecture)) {
    $actual = Get-PeMachine $FilePath
    throw "$Name architecture mismatch: expected $ExpectedArchitecture, found $actual at $FilePath"
  }
}

function Save-Url([string]$Url, [string]$Destination) {
  if (Test-Path -LiteralPath $Destination) {
    return
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  Write-Host "Downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing
}

function Resolve-NodeRuntime([string]$Rid) {
  $expectedArch = Get-RidArchitecture $Rid
  $cacheOut = Join-Path $RuntimeCacheDir "node\$Rid"
  $cachedNode = Join-Path $cacheOut "node.exe"
  if (Test-ExecutableArchitecture $cachedNode $expectedArch) {
    return $cachedNode
  }

  $localNode = Get-Command node -ErrorAction SilentlyContinue
  if ($localNode -and (Test-ExecutableArchitecture $localNode.Source $expectedArch)) {
    return $localNode.Source
  }

  $nodeArch = switch ($Rid) {
    "win-x64" { "x64" }
    "win-x86" { "x86" }
    "win-arm64" { "arm64" }
  }
  $fileName = "node-$NodeVersion-win-$nodeArch.zip"
  $zipPath = Join-Path $RuntimeCacheDir "downloads\$fileName"
  $url = "https://nodejs.org/dist/$NodeVersion/$fileName"
  Save-Url $url $zipPath

  $extractRoot = Join-Path $RuntimeCacheDir "node-expand\$Rid"
  if (Test-Path -LiteralPath $extractRoot) {
    Remove-Item -LiteralPath $extractRoot -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
  Expand-Archive -LiteralPath $zipPath -DestinationPath $extractRoot -Force

  $nodeDir = Get-ChildItem -LiteralPath $extractRoot -Directory | Select-Object -First 1
  if (-not $nodeDir) {
    throw "Node archive did not contain a runtime directory: $zipPath"
  }
  if (Test-Path -LiteralPath $cacheOut) {
    Remove-Item -LiteralPath $cacheOut -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $cacheOut | Out-Null
  Copy-Item -LiteralPath (Join-Path $nodeDir.FullName "node.exe") -Destination $cachedNode -Force
  Assert-ExecutableArchitecture $cachedNode $expectedArch "node.exe"
  return $cachedNode
}

function Find-InstalledWiresharkDir([string]$ExpectedArchitecture) {
  $candidates = @()
  if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles "Wireshark") }
  if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} "Wireshark") }
  $tsharkCommand = Get-Command tshark -ErrorAction SilentlyContinue
  if ($tsharkCommand) { $candidates += (Split-Path -Parent $tsharkCommand.Source) }
  foreach ($candidate in ($candidates | Select-Object -Unique)) {
    if ((Test-ExecutableArchitecture (Join-Path $candidate "dumpcap.exe") $ExpectedArchitecture) -and
        (Test-ExecutableArchitecture (Join-Path $candidate "tshark.exe") $ExpectedArchitecture)) {
      return $candidate
    }
  }
  return ""
}

function Resolve-WiresharkRuntime([string]$Rid) {
  $expectedArch = Get-RidArchitecture $Rid
  $cachedDir = Join-Path $RuntimeCacheDir "wireshark\$Rid"
  if ((Test-ExecutableArchitecture (Join-Path $cachedDir "dumpcap.exe") $expectedArch) -and
      (Test-ExecutableArchitecture (Join-Path $cachedDir "tshark.exe") $expectedArch)) {
    return $cachedDir
  }

  $installed = Find-InstalledWiresharkDir $expectedArch
  if ($installed) {
    return $installed
  }

  return ""
}

function Resolve-WiresharkInstaller([string]$Rid) {
  if ($Rid -eq "win-x86") {
    $fileName = "Wireshark-win32-$WiresharkWin32Version.exe"
    $url = "https://www.wireshark.org/download/win32/all-versions/$fileName"
  } else {
    $wiresharkArch = Get-RidArchitecture $Rid
    $fileName = "Wireshark-$WiresharkVersion-$wiresharkArch.exe"
    $url = "https://2.na.dl.wireshark.org/win64/$fileName"
  }

  $installerPath = Join-Path $RuntimeCacheDir "downloads\$fileName"
  Save-Url $url $installerPath
  return $installerPath
}

$packageScript = Join-Path $rootPath "tools\package-revivalside-mega-release.ps1"
$built = @()
foreach ($rid in $RuntimeIdentifiers) {
  $outputDir = Join-Path $OutputRoot "revivalside-mega-release-$rid"
  $nodePath = Resolve-NodeRuntime $rid
  $packageArgs = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", $packageScript,
    "-RuntimeIdentifier", $rid,
    "-OutputDir", $outputDir,
    "-NodePath", $nodePath
  )
  if ($SkipWireshark) {
    $packageArgs += "-SkipWireshark"
  } else {
    $wiresharkDir = Resolve-WiresharkRuntime $rid
    if ($wiresharkDir) {
      $packageArgs += @("-WiresharkDir", $wiresharkDir)
    } else {
      $wiresharkInstaller = Resolve-WiresharkInstaller $rid
      $packageArgs += @("-SkipWireshark", "-WiresharkInstallerPath", $wiresharkInstaller)
    }
  }
  if ($SkipGameplayJsons) { $packageArgs += "-SkipGameplayJsons" }
  if ($PythonPath) { $packageArgs += @("-PythonPath", $PythonPath) }
  if ($SkipWikiAssets) { $packageArgs += "-SkipWikiAssets" }
  if ($Zip) { $packageArgs += "-Zip" }
  Write-Host "Packaging $rid"
  & powershell @packageArgs
  if ($LASTEXITCODE -ne 0) {
    throw "Packaging failed for $rid"
  }
  $built += $outputDir
}

Write-Host "Built packages:"
foreach ($item in $built) {
  Write-Host "  $item"
  if ($Zip) {
    Write-Host "  $item.zip"
  }
}
