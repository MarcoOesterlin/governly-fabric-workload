<#
.SYNOPSIS
  Downloads (if needed) and starts the Microsoft Fabric Dev Gateway for local workload development.

.DESCRIPTION
  - Reads WORKSPACE_GUID and ENTRA_TENANT_ID from .env.dev (or environment)
  - Downloads DevGateway.zip from Microsoft if not already present in build/DevGateway/
  - Builds the manifest .nupkg via BuildManifestPackage.ps1
  - Obtains a PowerBI-scoped token via Azure CLI
  - Starts Microsoft.Fabric.Workload.DevGateway.dll via dotnet

.PREREQUISITES
  - .NET 8 runtime  : https://dotnet.microsoft.com/download
  - Azure CLI (az)  : https://learn.microsoft.com/cli/azure/install-azure-cli
  - WORKSPACE_GUID and ENTRA_TENANT_ID set in .env.dev
#>

$ErrorActionPreference = "Stop"
$projectRoot = Resolve-Path "$PSScriptRoot\..\.."

# --- Load .env.dev ---
$envFile = Join-Path $projectRoot ".env.dev"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^([^#=][^=]*)=(.*)$') {
            [System.Environment]::SetEnvironmentVariable($Matches[1].Trim(), $Matches[2].Trim(), 'Process')
        }
    }
}

$workspaceGuid   = $env:WORKSPACE_GUID
$tenantId        = $env:ENTRA_TENANT_ID
$workloadName    = $env:WORKLOAD_NAME    ?? "Org.Governly"
$workloadVersion = $env:WORKLOAD_VERSION ?? "1.0.0"
$backendPort     = $env:BACKEND_PORT     ?? "60006"
$logLevel        = $env:LOG_LEVEL        ?? "Information"

# Auto-extract tenant ID from AUDIENCE if not explicitly set
# AUDIENCE format: api://localdevinstance/{tenantId}/{workloadName}/{suffix}
if (-not $tenantId -and $env:AUDIENCE -match 'localdevinstance/([^/]+)/') {
    $tenantId = $Matches[1]
    Write-Host "ℹ️  Tenant ID extracted from AUDIENCE: $tenantId" -ForegroundColor DarkGray
}

if (-not $workspaceGuid) {
    throw "WORKSPACE_GUID is not set. Add it to .env.dev (your Fabric workspace GUID from the workspace URL)."
}
if (-not $tenantId) {
    throw "ENTRA_TENANT_ID is not set. Add it to .env.dev (your Azure/Entra tenant ID)."
}

# --- Prerequisite checks ---
# Locate dotnet — prefer PATH, fall back to default install location
$dotnetCmd = "dotnet"
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    $defaultDotnet = "C:\Program Files\dotnet\dotnet.exe"
    if (Test-Path $defaultDotnet) {
        $dotnetCmd = $defaultDotnet
        Write-Host "ℹ️  Using dotnet from default install path." -ForegroundColor DarkGray
    } else {
        throw ".NET runtime not found. Install .NET 8 from https://dotnet.microsoft.com/download"
    }
}
# Locate az — prefer PATH, fall back to default install location
$azCmd = "az"
if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    $defaultAz = "C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin\az.cmd"
    if (Test-Path $defaultAz) {
        $azCmd = $defaultAz
        Write-Host "ℹ️  Using az from default install path." -ForegroundColor DarkGray
    } else {
        throw "Azure CLI not found. Install from https://learn.microsoft.com/cli/azure/install-azure-cli"
    }
}

# --- Download DevGateway if not already present ---
$devGatewayDir = Join-Path $projectRoot "build\DevGateway"
$devGatewayDll = Join-Path $devGatewayDir "Microsoft.Fabric.Workload.DevGateway.dll"
$downloadUrl   = "https://download.microsoft.com/download/c/4/a/c4a0a569-87cd-4633-a81e-26ef3d4266df/DevGateway.zip"

if (-not (Test-Path $devGatewayDll)) {
    Write-Host "⬇️  Downloading Fabric Dev Gateway..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Force -Path $devGatewayDir | Out-Null
    $zipPath = Join-Path $devGatewayDir "DevGateway.zip"
    Invoke-WebRequest -Uri $downloadUrl -OutFile $zipPath -UseBasicParsing
    Write-Host "📦 Extracting Dev Gateway..." -ForegroundColor Cyan
    Expand-Archive -Path $zipPath -DestinationPath $devGatewayDir -Force
    Remove-Item $zipPath -Force
    if (-not (Test-Path $devGatewayDll)) {
        throw "DevGateway DLL not found after extraction. Expected: $devGatewayDll"
    }
    Write-Host "✅ Dev Gateway ready." -ForegroundColor Green
} else {
    Write-Host "✅ Dev Gateway already downloaded." -ForegroundColor Green
}

# --- Build manifest package ---
Write-Host "📦 Building manifest package..." -ForegroundColor Cyan
& "$projectRoot\scripts\packaging\BuildManifestPackage.ps1"

$nupkgPath = Join-Path $projectRoot "build\Manifest\$workloadName.$workloadVersion.nupkg"
if (-not (Test-Path $nupkgPath)) {
    throw "Manifest package not found after build: $nupkgPath"
}

# --- Azure login & token ---
Write-Host "🔑 Checking Azure CLI login..." -ForegroundColor Cyan
$loginCheck = & $azCmd account show 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "🔐 Not logged in — starting interactive Azure login for tenant $tenantId..." -ForegroundColor Yellow
    & $azCmd config set core.login_experience_v2=off
    & $azCmd login -t $tenantId --allow-no-subscriptions
}

$token = & $azCmd account get-access-token --scope "https://analysis.windows.net/powerbi/api/.default" --query accessToken -o tsv
if (-not $token) {
    throw "Failed to obtain PowerBI access token from Azure CLI."
}
Write-Host "✅ Access token obtained." -ForegroundColor Green

# --- Launch Dev Gateway ---
Write-Host ""
Write-Host "*****************************************************" -ForegroundColor Cyan
Write-Host "****        Starting Fabric Dev Gateway          ****" -ForegroundColor Cyan
Write-Host "*****************************************************" -ForegroundColor Cyan
Write-Host "  Tenant    : $tenantId"
Write-Host "  Workspace : $workspaceGuid"
Write-Host "  Manifest  : $nupkgPath"
Write-Host "  Backend   : http://127.0.0.1:$backendPort/workload"
Write-Host ""

$gatewayArgs = @(
    $devGatewayDll,
    "-LogLevel", $logLevel,
    "-DevMode:UserAuthorizationToken", $token,
    "-DevMode:ManifestPackageFilePath", $nupkgPath,
    "-DevMode:WorkspaceGuid", $workspaceGuid,
    "-DevMode:WorkloadEndpointUrl", "http://127.0.0.1:$backendPort/workload"
)

& $dotnetCmd @gatewayArgs
