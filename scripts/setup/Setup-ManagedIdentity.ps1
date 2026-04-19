<#
.SYNOPSIS
    Assigns a system-managed identity to an Azure resource and grants it
    "Key Vault Secrets User" on the Governly Key Vault.

.DESCRIPTION
    Run this once per deployment target (App Service, Container App, or AKS workload).
    After this script completes, the hosted app reads Key Vault secrets via its
    Managed Identity — no credentials, no rotation, no .env files in production.

    Prerequisites:
      - az login (Contributor on the target resource + Owner/User Access Administrator on the Key Vault)
      - The Key Vault must already exist (run Setup-DevKeyVault.ps1 first)

.PARAMETER ResourceName
    Name of the Azure resource to enable identity on (App Service / Container App / VM name).

.PARAMETER ResourceGroup
    Resource group containing the target resource.

.PARAMETER ResourceType
    Type of Azure resource. Supported: AppService, ContainerApp, VM (default: AppService)

.PARAMETER KeyVaultName
    Key Vault name. Auto-read from .env.dev if omitted.

.EXAMPLE
    # App Service
    .\Setup-ManagedIdentity.ps1 -ResourceName "app-governly-prod" -ResourceGroup "rg-governly-prod"

    # Azure Container App
    .\Setup-ManagedIdentity.ps1 -ResourceName "ca-governly" -ResourceGroup "rg-governly-prod" -ResourceType ContainerApp
#>
param(
    [Parameter(Mandatory)]
    [string]$ResourceName,

    [Parameter(Mandatory)]
    [string]$ResourceGroup,

    [ValidateSet('AppService', 'ContainerApp', 'VM')]
    [string]$ResourceType = 'AppService',

    [string]$KeyVaultName = ''
)

$ErrorActionPreference = "Stop"

# ── Resolve Key Vault name ─────────────────────────────────────────────────────

if (-not $KeyVaultName) {
    $envFile = Join-Path $PSScriptRoot "..\..\\.env.dev"
    if (Test-Path $envFile) {
        Get-Content $envFile | ForEach-Object {
            if ($_ -match "^KEYVAULT_NAME=(.+)$") { $KeyVaultName = $Matches[1].Trim() }
        }
    }
}
if (-not $KeyVaultName) {
    Write-Error "Could not determine Key Vault name. Either pass -KeyVaultName or set KEYVAULT_NAME in .env.dev."
    exit 1
}

Write-Host "`n🔍 Configuration" -ForegroundColor Cyan
Write-Host "  Resource      : $ResourceName ($ResourceType)"
Write-Host "  Resource group: $ResourceGroup"
Write-Host "  Key Vault     : $KeyVaultName"

# ── Enable system-assigned managed identity ───────────────────────────────────

Write-Host "`n🆔 Enabling system-assigned managed identity on $ResourceName..." -ForegroundColor Cyan

$principalId = switch ($ResourceType) {
    'AppService' {
        $result = az webapp identity assign `
            --name           $ResourceName `
            --resource-group $ResourceGroup `
            --output json | ConvertFrom-Json
        $result.principalId
    }
    'ContainerApp' {
        $result = az containerapp identity assign `
            --name           $ResourceName `
            --resource-group $ResourceGroup `
            --system-assigned `
            --output json | ConvertFrom-Json
        $result.principalId
    }
    'VM' {
        $result = az vm identity assign `
            --name           $ResourceName `
            --resource-group $ResourceGroup `
            --output json | ConvertFrom-Json
        $result.systemAssignedIdentity
    }
}

if (-not $principalId) {
    Write-Error "Could not retrieve principal ID after enabling managed identity."
    exit 1
}

Write-Host "  ✓ Managed Identity principal ID: $principalId"

# ── Grant Key Vault Secrets User ──────────────────────────────────────────────

Write-Host "`n🛡  Granting 'Key Vault Secrets User' on vault '$KeyVaultName'..." -ForegroundColor Cyan

$kvId = (az keyvault show --name $KeyVaultName --query "id" -o tsv).Trim()

az role assignment create `
    --role      "Key Vault Secrets User" `
    --assignee  $principalId `
    --scope     $kvId `
    --output none

Write-Host "  ✓ Role assigned — waiting 15 s for propagation..."
Start-Sleep -Seconds 15

# ── Verify ────────────────────────────────────────────────────────────────────

$assignments = az role assignment list --scope $kvId --query "[?principalId=='$principalId'].roleDefinitionName" -o tsv
if ($assignments -match "Key Vault Secrets User") {
    Write-Host "  ✓ Verified: role assignment is active" -ForegroundColor Green
} else {
    Write-Warning "Role assignment not yet visible (AAD propagation can take a few minutes). Re-run the verify step if needed."
}

# ── Done ──────────────────────────────────────────────────────────────────────

Write-Host "`n✅ Done!" -ForegroundColor Green
Write-Host ""
Write-Host "The $ResourceType '$ResourceName' can now read 'GovernlyClientSecret'"
Write-Host "from Key Vault '$KeyVaultName' using its Managed Identity."
Write-Host ""
Write-Host "No app settings or environment variables are needed — DefaultAzureCredential"
Write-Host "will automatically use the Managed Identity when running on Azure." -ForegroundColor DarkGray
