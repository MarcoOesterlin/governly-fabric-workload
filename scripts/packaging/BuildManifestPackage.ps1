<#
.SYNOPSIS
  Builds the Governly Fabric Workload manifest .nupkg for upload to Fabric Admin portal.

.DESCRIPTION
  Reads environment variables (or .env.ghpages), substitutes placeholders in manifest
  templates, and creates the .nupkg as a ZIP directly (no nuget.exe required).
  Package structure follows the official Microsoft WDK sample exactly.

.EXAMPLE
  # Load .env.ghpages then build:
  Get-Content .\.env.ghpages | ForEach-Object {
    if ($_ -match '^([^#][^=]*)=(.*)$') { [System.Environment]::SetEnvironmentVariable($Matches[1].Trim(), $Matches[2].Trim()) }
  }
  .\scripts\packaging\BuildManifestPackage.ps1
#>

param(
  [string]$WorkloadName    = $env:WORKLOAD_NAME    ?? "Org.Governly",
  [string]$WorkloadVersion = $env:WORKLOAD_VERSION ?? "1.0.0",
  [string]$FrontendAppId   = $env:FRONTEND_APPID   ?? "",
  [string]$FrontendUrl     = $env:FRONTEND_URL      ?? "",
  [string]$Audience        = $env:AUDIENCE          ?? ""
)

$ErrorActionPreference = "Stop"

if (-not $FrontendAppId) { throw "FRONTEND_APPID is required." }
if (-not $FrontendUrl)   { throw "FRONTEND_URL is required." }
if (-not $Audience)      { throw "AUDIENCE is required." }

$projectRoot = Resolve-Path "$PSScriptRoot\..\.."
$manifestDir = Join-Path $projectRoot "manifest"
$outputDir   = Join-Path $projectRoot "build\Manifest"

New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

Add-Type -Assembly System.IO.Compression
Add-Type -Assembly System.IO.Compression.FileSystem

$nupkgPath = Join-Path $outputDir "Org.Governly.$WorkloadVersion.nupkg"
if (Test-Path $nupkgPath) { Remove-Item $nupkgPath -Force }

function Expand-Template([string]$path) {
  $content = Get-Content $path -Raw -Encoding UTF8
  $content `
    -replace "\{\{WORKLOAD_NAME\}\}",    $WorkloadName    `
    -replace "\{\{WORKLOAD_VERSION\}\}", $WorkloadVersion `
    -replace "\{\{FRONTEND_APPID\}\}",   $FrontendAppId   `
    -replace "\{\{FRONTEND_URL\}\}",     $FrontendUrl     `
    -replace "\{\{AUDIENCE\}\}",         $Audience
}

function Add-TextEntry([System.IO.Compression.ZipArchive]$zip, [string]$entryPath, [string]$content) {
  $entry  = $zip.CreateEntry($entryPath, [System.IO.Compression.CompressionLevel]::Optimal)
  $stream = $entry.Open()
  $bytes  = [System.Text.Encoding]::UTF8.GetBytes($content)
  $stream.Write($bytes, 0, $bytes.Length)
  $stream.Dispose()
}

function Add-BinaryEntry([System.IO.Compression.ZipArchive]$zip, [string]$entryPath, [string]$filePath) {
  $entry  = $zip.CreateEntry($entryPath, [System.IO.Compression.CompressionLevel]::Optimal)
  $stream = $entry.Open()
  $bytes  = [System.IO.File]::ReadAllBytes($filePath)
  $stream.Write($bytes, 0, $bytes.Length)
  $stream.Dispose()
}

$fs  = [System.IO.File]::Open($nupkgPath, [System.IO.FileMode]::Create)
$zip = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)

try {
  # --- [Content_Types].xml ---
  $contentTypes = @'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels"   ContentType="application/vnd.openxmlformats-package.relationships+xml" />
  <Default Extension="psmdcp" ContentType="application/vnd.openxmlformats-package.core-properties+xml" />
  <Default Extension="nuspec" ContentType="application/octet" />
  <Default Extension="xml"    ContentType="application/octet" />
  <Default Extension="json"   ContentType="application/octet" />
  <Default Extension="png"    ContentType="application/octet" />
</Types>
'@
  Add-TextEntry $zip "[Content_Types].xml" $contentTypes

  # --- _rels/.rels ---
  $rels = @'
<?xml version="1.0" encoding="utf-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Type="http://schemas.microsoft.com/packaging/2010/07/manifest" Target="/ManifestPackageRelease.nuspec" Id="R1" />
</Relationships>
'@
  Add-TextEntry $zip "_rels/.rels" $rels

  # --- ManifestPackageRelease.nuspec (id matches official WDK sample) ---
  $nuspec = @"
<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://schemas.microsoft.com/packaging/2010/07/nuspec.xsd">
  <metadata>
    <id>ManifestPackageRelease</id>
    <version>$WorkloadVersion</version>
    <authors>Governly</authors>
    <owners>Governly</owners>
    <description>Governly Fabric Workload manifest package</description>
    <requireLicenseAcceptance>false</requireLicenseAcceptance>
  </metadata>
</package>
"@
  Add-TextEntry $zip "ManifestPackageRelease.nuspec" $nuspec

  # --- BE/ manifest files ---
  Add-TextEntry $zip "BE/WorkloadManifest.xml" (Expand-Template (Join-Path $manifestDir "WorkloadManifest.xml"))
  Add-TextEntry $zip "BE/Instance.xml"         (Expand-Template (Join-Path $manifestDir "Instance.xml"))

  # --- FE/ files (product.json lowercase, matching official WDK nuspec target) ---
  Add-TextEntry $zip "FE/product.json" (Get-Content (Join-Path $manifestDir "FE\Product.json") -Raw -Encoding UTF8)
  Add-TextEntry $zip "FE/Instance.json" (Get-Content (Join-Path $manifestDir "FE\Instance.json") -Raw -Encoding UTF8)

  # --- FE/assets/ ---
  $feAssetsDir = Join-Path $manifestDir "FE\assets"
  Get-ChildItem -Recurse -File $feAssetsDir | ForEach-Object {
    $rel = $_.FullName.Substring($feAssetsDir.Length + 1).Replace('\', '/')
    if ($_.Extension -eq ".png") {
      Add-BinaryEntry $zip "FE/assets/$rel" $_.FullName
    } else {
      Add-TextEntry $zip "FE/assets/$rel" (Get-Content $_.FullName -Raw -Encoding UTF8)
    }
  }

} finally {
  $zip.Dispose()
  $fs.Dispose()
}

Write-Host ""
Write-Host "SUCCESS: Manifest package ready at:" -ForegroundColor Green
Write-Host "  $nupkgPath" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next step: Upload $nupkgPath in Fabric Admin portal > Workloads." -ForegroundColor Yellow
