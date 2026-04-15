<#
.SYNOPSIS
  Builds the Governly Fabric Workload manifest .nupkg for upload to Fabric Admin portal.

.DESCRIPTION
  Reads environment variables (or .env.ghpages), substitutes placeholders in manifest
  templates, and packs them into a .nupkg using nuget-bin.

.EXAMPLE
  # Load .env.ghpages then build:
  Get-Content .\.env.ghpages | ForEach-Object {
    if ($_ -match '^([^#][^=]*)=(.*)$') { $env:($Matches[1]) = $Matches[2] }
  }
  .\scripts\Build\BuildManifestPackage.ps1
#>

param(
  [string]$WorkloadName    = $env:WORKLOAD_NAME    ?? "Org.Governly",
  [string]$WorkloadVersion = $env:WORKLOAD_VERSION ?? "1.0.0",
  [string]$FrontendAppId   = $env:FRONTEND_APPID   ?? "",
  [string]$FrontendUrl     = $env:FRONTEND_URL      ?? "",
  [string]$Audience        = $env:AUDIENCE          ?? ""
)

$ErrorActionPreference = "Stop"

if (-not $FrontendAppId) { throw "FRONTEND_APPID is required. Run .\scripts\CreateGovernlyApp.ps1 first." }
if (-not $FrontendUrl)   { throw "FRONTEND_URL is required (e.g. https://MarcoOesterlin.github.io/governly-fabric-workload)." }
if (-not $Audience)      { throw "AUDIENCE is required (Application ID URI from app registration)." }

$projectRoot = Resolve-Path "$PSScriptRoot\..\.."
$manifestDir = Join-Path $projectRoot "manifest"
$outputDir   = Join-Path $projectRoot "build\Manifest"
$tempDir     = Join-Path ([System.IO.Path]::GetTempPath()) "GovernlyManifest_$(Get-Random)"

New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
New-Item -ItemType Directory -Force -Path $tempDir   | Out-Null

try {
  # Populate template placeholders
  foreach ($file in @("WorkloadManifest.xml", "Classifier.xml")) {
    $content = Get-Content (Join-Path $manifestDir $file) -Raw
    $content = $content `
      -replace "\{\{WORKLOAD_NAME\}\}",    $WorkloadName    `
      -replace "\{\{WORKLOAD_VERSION\}\}", $WorkloadVersion `
      -replace "\{\{FRONTEND_APPID\}\}",   $FrontendAppId   `
      -replace "\{\{FRONTEND_URL\}\}",     $FrontendUrl     `
      -replace "\{\{AUDIENCE\}\}",         $Audience
    $content | Out-File (Join-Path $tempDir $file) -Encoding utf8NoBOM
  }

  # Write .nuspec
  $nuspec = @"
<?xml version="1.0"?>
<package xmlns="http://schemas.microsoft.com/packaging/2010/07/nuspec.xsd">
  <metadata>
    <id>$WorkloadName</id>
    <version>$WorkloadVersion</version>
    <authors>Governly</authors>
    <description>Governly Fabric Workload manifest package</description>
    <requireLicenseAcceptance>false</requireLicenseAcceptance>
  </metadata>
  <files>
    <file src="WorkloadManifest.xml" target="BE\WorkloadManifest.xml" />
    <file src="Classifier.xml" target="BE\Classifier.xml" />
  </files>
</package>
"@
  $nuspec | Out-File (Join-Path $tempDir "$WorkloadName.nuspec") -Encoding utf8NoBOM

  # Pack with nuget (via npx nuget-bin from project root)
  Push-Location $tempDir
  & npx --prefix $projectRoot nuget pack "$WorkloadName.nuspec" -OutputDirectory $tempDir
  Pop-Location

  $src  = Join-Path $tempDir "$WorkloadName.$WorkloadVersion.nupkg"
  $dest = Join-Path $outputDir "$WorkloadName.$WorkloadVersion.nupkg"
  Move-Item $src $dest -Force

  Write-Host ""
  Write-Host "SUCCESS: Manifest package ready at:" -ForegroundColor Green
  Write-Host "  $dest" -ForegroundColor Cyan
  Write-Host ""
  Write-Host "Next step: Upload $dest in Fabric Admin portal > Workloads." -ForegroundColor Yellow
}
finally {
  if (Test-Path $tempDir) { Remove-Item $tempDir -Recurse -Force }
}
