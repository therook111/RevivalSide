param(
  [string]$Version = "v18.20.4",
  [string]$CacheDir = (Join-Path (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")) ".cache\nodejs-mobile")
)

$ErrorActionPreference = "Stop"

$kmpRoot = Resolve-Path -LiteralPath $PSScriptRoot
$repoRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$targetDir = Join-Path $kmpRoot "app\libnode"
$targetFull = [System.IO.Path]::GetFullPath($targetDir)
$expectedPrefix = [System.IO.Path]::GetFullPath((Join-Path $kmpRoot "app"))

if (-not $targetFull.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to write outside Android app: $targetFull"
}

New-Item -ItemType Directory -Path $CacheDir -Force | Out-Null
$zipName = "nodejs-mobile-$Version-android.zip"
$zipPath = Join-Path $CacheDir $zipName
$url = "https://github.com/nodejs-mobile/nodejs-mobile/releases/download/$Version/$zipName"

if (-not (Test-Path -LiteralPath $zipPath)) {
  Write-Host "Downloading $url"
  Invoke-WebRequest -Uri $url -OutFile $zipPath
}

if (Test-Path -LiteralPath $targetFull) {
  Remove-Item -LiteralPath $targetFull -Recurse -Force
}
New-Item -ItemType Directory -Path $targetFull -Force | Out-Null

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $targetFull)

$required = @(
  "bin\armeabi-v7a\libnode.so",
  "bin\arm64-v8a\libnode.so",
  "bin\x86_64\libnode.so",
  "include\node\node.h"
)

foreach ($relative in $required) {
  $path = Join-Path $targetFull $relative
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Node Mobile package is missing $relative"
  }
}

Write-Host "Node Mobile $Version vendored under $targetFull"
Get-ChildItem -LiteralPath (Join-Path $targetFull "bin") -Recurse -Filter libnode.so |
  Select-Object FullName, Length
