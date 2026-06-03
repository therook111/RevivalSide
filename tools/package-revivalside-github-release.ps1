param(
  [string]$OutputDir = "",
  [string]$UniversalInstallerDir = "",
  [string]$ReleaseTag = "",
  [string]$ReleaseBaseUrl = "",
  [int]$ChunkSizeMB = 1900,
  [switch]$SkipUniversalBuild,
  [switch]$SkipPayloadArchive,
  [switch]$KeepArchive,
  [switch]$Upload
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$rootPath = $root.Path
$prebuiltRoot = [System.IO.Path]::GetFullPath((Join-Path $rootPath "prebuilt"))
$prebuiltRootWithSlash = $prebuiltRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar

if (-not $OutputDir) {
  $OutputDir = Join-Path $rootPath "prebuilt\revivalside-github-release"
}
if (-not $UniversalInstallerDir) {
  $UniversalInstallerDir = Join-Path $rootPath "prebuilt\revivalside-universal-installer"
}
if (-not $ReleaseTag) {
  $packageJson = Get-Content -Raw -LiteralPath (Join-Path $rootPath "package.json") | ConvertFrom-Json
  $ReleaseTag = "v$($packageJson.version)"
}

$outputPath = [System.IO.Path]::GetFullPath($OutputDir)
$universalPath = [System.IO.Path]::GetFullPath($UniversalInstallerDir)
if ($outputPath -ne $prebuiltRoot -and -not $outputPath.StartsWith($prebuiltRootWithSlash, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "OutputDir must stay under $prebuiltRoot; resolved OutputDir=$outputPath"
}
if ($universalPath -ne $prebuiltRoot -and -not $universalPath.StartsWith($prebuiltRootWithSlash, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "UniversalInstallerDir must stay under $prebuiltRoot; resolved UniversalInstallerDir=$universalPath"
}

function Resolve-ReleaseBaseUrl {
  if ($ReleaseBaseUrl) { return $ReleaseBaseUrl.TrimEnd("/") }
  $remote = (& git -C $rootPath remote get-url RevivalSide 2>$null)
  if (-not $remote) { $remote = (& git -C $rootPath remote get-url origin 2>$null) }
  if (-not $remote) { throw "Could not detect git remote. Pass -ReleaseBaseUrl https://github.com/OWNER/REPO/releases/download/$ReleaseTag" }
  if ($remote -match "github\.com[:/](?<owner>[^/]+)/(?<repo>[^/.]+)(\.git)?$") {
    return "https://github.com/$($Matches.owner)/$($Matches.repo)/releases/download/$ReleaseTag"
  }
  throw "Could not parse GitHub owner/repo from remote '$remote'. Pass -ReleaseBaseUrl explicitly."
}

function Remove-PdbFiles([string]$Directory) {
  if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { return }
  Get-ChildItem -LiteralPath $Directory -File -Filter "*.pdb" -ErrorAction SilentlyContinue |
    Remove-Item -Force
}

function Get-FileSha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-CompatibleRelativePath([string]$BasePath, [string]$TargetPath) {
  $baseFull = [System.IO.Path]::GetFullPath($BasePath)
  $targetFull = [System.IO.Path]::GetFullPath($TargetPath)
  $separator = [System.IO.Path]::DirectorySeparatorChar
  if (-not $baseFull.EndsWith($separator)) {
    $baseFull = $baseFull + $separator
  }
  $baseUri = New-Object System.Uri($baseFull)
  $targetUri = New-Object System.Uri($targetFull)
  if ($baseUri.Scheme -ne $targetUri.Scheme) {
    throw "Cannot create relative path across URI schemes: $baseFull -> $targetFull"
  }
  $relativeUri = $baseUri.MakeRelativeUri($targetUri)
  return [System.Uri]::UnescapeDataString($relativeUri.ToString()).Replace("/", $separator)
}

function New-PayloadZip([string]$PayloadDir, [string]$ZipPath) {
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  if (Test-Path -LiteralPath $ZipPath) { Remove-Item -LiteralPath $ZipPath -Force }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ZipPath) | Out-Null
  $zip = [System.IO.Compression.ZipFile]::Open($ZipPath, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    $files = Get-ChildItem -LiteralPath $PayloadDir -Recurse -File
    $count = 0
    foreach ($file in $files) {
      $relative = (Get-CompatibleRelativePath $PayloadDir $file.FullName).Replace("\", "/")
      $entryName = "payload/$relative"
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $entryName, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
      $count++
      if (($count % 2500) -eq 0) { Write-Host "Zipped $count files..." }
    }
    Write-Host "Zipped $count files into $ZipPath"
  }
  finally {
    $zip.Dispose()
  }
}

function Split-File([string]$SourcePath, [string]$DestinationDir, [string]$PartPrefix, [long]$ChunkSizeBytes) {
  New-Item -ItemType Directory -Force -Path $DestinationDir | Out-Null
  Get-ChildItem -LiteralPath $DestinationDir -File -Filter "$PartPrefix.part*" -ErrorAction SilentlyContinue |
    Remove-Item -Force

  $parts = @()
  $buffer = New-Object byte[] (4MB)
  $inputStream = [System.IO.File]::OpenRead($SourcePath)
  try {
    $partIndex = 1
    while ($inputStream.Position -lt $inputStream.Length) {
      $partName = "{0}.part{1:D3}" -f $PartPrefix, $partIndex
      $partPath = Join-Path $DestinationDir $partName
      $outputStream = [System.IO.File]::Open($partPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
      try {
        $written = 0L
        while ($written -lt $ChunkSizeBytes -and $inputStream.Position -lt $inputStream.Length) {
          $toRead = [int][Math]::Min($buffer.Length, $ChunkSizeBytes - $written)
          $read = $inputStream.Read($buffer, 0, $toRead)
          if ($read -le 0) { break }
          $outputStream.Write($buffer, 0, $read)
          $written += $read
        }
      }
      finally {
        $outputStream.Dispose()
      }
      $item = Get-Item -LiteralPath $partPath
      $parts += [ordered]@{
        name = $partName
        size = $item.Length
        sha256 = Get-FileSha256 $partPath
      }
      Write-Host ("Wrote {0} ({1:N2} MB)" -f $partName, ($item.Length / 1MB))
      $partIndex++
    }
  }
  finally {
    $inputStream.Dispose()
  }
  return $parts
}

$releaseBaseUrlResolved = Resolve-ReleaseBaseUrl
$manifestAssetName = "RevivalSidePayloadManifest.json"
$manifestUrl = "$releaseBaseUrlResolved/$manifestAssetName"

if (-not $SkipUniversalBuild) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $rootPath "tools\package-revivalside-universal-installer.ps1") -OutputDir $universalPath
  if ($LASTEXITCODE -ne 0) { throw "Universal installer packaging failed" }
}

$payloadDir = Join-Path $universalPath "payload"
if (-not (Test-Path -LiteralPath $payloadDir -PathType Container)) {
  throw "Payload folder was not found: $payloadDir"
}

if (Test-Path -LiteralPath $outputPath) {
  Remove-Item -LiteralPath $outputPath -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $outputPath | Out-Null

Write-Host "Publishing web setup with manifest URL: $manifestUrl"
dotnet publish (Join-Path $rootPath "tools\RevivalSideInstallerApp\RevivalSideInstallerApp.csproj") `
  -c Release -r win-x86 --self-contained true `
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:EnableCompressionInSingleFile=true `
  -p:DebugType=None -p:DebugSymbols=false `
  "-p:RevivalSideReleaseManifestUrl=$manifestUrl" `
  --nologo `
  -o $outputPath
if ($LASTEXITCODE -ne 0) { throw "Web setup publish failed" }
Remove-PdbFiles $outputPath

if (-not $SkipPayloadArchive) {
  $archiveName = "RevivalSidePayload-$ReleaseTag.zip"
  $partPrefix = $archiveName
  $archivePath = Join-Path $outputPath $archiveName
  New-PayloadZip $payloadDir $archivePath
  $archiveItem = Get-Item -LiteralPath $archivePath
  $archiveSha256 = Get-FileSha256 $archivePath
  $chunks = Split-File $archivePath $outputPath $partPrefix ([long]$ChunkSizeMB * 1MB)
  $manifest = [ordered]@{
    schemaVersion = 1
    payloadId = "revivalside-$ReleaseTag-$($archiveSha256.Substring(0, 12))"
    archiveName = $archiveName
    archiveSize = $archiveItem.Length
    archiveSha256 = $archiveSha256
    chunks = $chunks
  }
  $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $outputPath $manifestAssetName) -Encoding UTF8
  if (-not $KeepArchive) { Remove-Item -LiteralPath $archivePath -Force }
}

@"
RevivalSide GitHub Release Package

Upload every file in this folder to the GitHub release for ${ReleaseTag}:

  gh release create $ReleaseTag "$outputPath\*" --title "RevivalSide $ReleaseTag"

Or, if the release already exists:

  gh release upload $ReleaseTag "$outputPath\*" --clobber

The only file users need to download manually is RevivalSideSetup.exe.
The setup executable downloads $manifestAssetName and payload parts from:

  $releaseBaseUrlResolved
"@ | Set-Content -LiteralPath (Join-Path $outputPath "README.txt") -Encoding UTF8

if ($Upload) {
  $assets = Get-ChildItem -LiteralPath $outputPath -File | ForEach-Object { $_.FullName }
  & gh release view $ReleaseTag *> $null
  if ($LASTEXITCODE -ne 0) {
    & gh release create $ReleaseTag $assets --title "RevivalSide $ReleaseTag"
  }
  else {
    & gh release upload $ReleaseTag $assets --clobber
  }
  if ($LASTEXITCODE -ne 0) { throw "gh release upload failed" }
}

Write-Host "Packaged GitHub release assets at $outputPath"
