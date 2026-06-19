param(
  [string]$XapkPath = "C:\Users\moemy\Downloads\CounterSide_9.21.3352381_APKPure.xapk",
  [string]$Serial = "10.0.2.240:5555",
  [switch]$SkipConnect
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $XapkPath)) {
  throw "XAPK was not found: $XapkPath"
}

$adb = "adb"
if (-not $SkipConnect) {
  & $adb connect $Serial | Write-Host
}

$workRoot = Join-Path ([System.IO.Path]::GetTempPath()) "revivalside-counterside-xapk"
$extractDir = Join-Path $workRoot ([System.IO.Path]::GetFileNameWithoutExtension($XapkPath))
if (Test-Path -LiteralPath $extractDir) {
  Remove-Item -LiteralPath $extractDir -Recurse -Force
}
New-Item -ItemType Directory -Path $extractDir -Force | Out-Null

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($XapkPath, $extractDir)

$manifestPath = Join-Path $extractDir "manifest.json"
if (-not (Test-Path -LiteralPath $manifestPath)) {
  throw "XAPK manifest.json was not found after extraction."
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$apkPaths = @()
foreach ($split in $manifest.split_apks) {
  $apkPath = Join-Path $extractDir ([string]$split.file)
  if (-not (Test-Path -LiteralPath $apkPath)) {
    throw "APK listed in manifest was not found: $apkPath"
  }
  $apkPaths += $apkPath
}

if ($apkPaths.Count -eq 0) {
  throw "XAPK manifest did not list split_apks."
}

Write-Host "Installing $($manifest.package_name) $($manifest.version_name) to $Serial"
& $adb -s $Serial install-multiple -r @apkPaths
if ($LASTEXITCODE -ne 0) {
  throw "adb install-multiple failed with exit code $LASTEXITCODE"
}

Write-Host "Resolved launch activity:"
& $adb -s $Serial shell cmd package resolve-activity --brief $manifest.package_name
