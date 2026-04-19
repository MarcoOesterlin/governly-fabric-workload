<#
.SYNOPSIS
    One-time setup: creates an Azure Key Vault, generates a client secret for the
    Governly Azure AD app, stores it in the vault, and prints the KEYVAULT_NAME
    value to add to .env.dev.

.DESCRIPTION
    After running this script you only need KEYVAULT_NAME in .env.dev — no secrets
    ever touch the filesystem. The dev proxy reads the secret at runtime via the
    Azure CLI session you are already logged in with.

    Prerequisites:
      - az login (tenant admin or at minimum Application Administrator + Contributor)
      - Azure CLI installed

.PARAMETER ResourceGroup
    Resource group for the Key Vault. Created if it does not exist. Default: rg-governly-dev

.PARAMETER Location
    Azure region. Default: northeurope

.PARAMETER KeyVaultName
    Key Vault name (3-24 chars, globally unique). Auto-generated from tenant ID if omitted.

.EXAMPLE
    .\Setup-DevKeyVault.ps1
    .\Setup-DevKeyVault.ps1 -ResourceGroup "my-rg" -Location "westeurope"
#>
param(
    [string]$ResourceGroup = "rg-governly-dev",
    [string]$Location      = "northeurope",
    [string]$KeyVaultName  = ""
)

$ErrorActionPreference = "Stop"

# ── Resolve identities ────────────────────────────────────────────────────────

Write-Host "`n🔍 Resolving Azure identities..." -ForegroundColor Cyan

$account  = az account show | ConvertFrom-Json
$tenantId = $account.tenantId
$subId    = $account.id
$subName  = $account.name

# App ID is read from .env.dev so everything stays in sync
$envFile = Join-Path $PSScriptRoot "..\..\\.env.dev"
$appId   = $null
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match "^FRONTEND_APPID=(.+)$") { $appId = $Matches[1].Trim() }
    }
}
if (-not $appId) {
    Write-Error "Could not read FRONTEND_APPID from .env.dev. Make sure the file exists."
    exit 1
}

Write-Host "  Subscription : $subName ($subId)"
Write-Host "  Tenant       : $tenantId"
Write-Host "  App (client) : $appId"

# ── Key Vault name ─────────────────────────────────────────────────────────────

if (-not $KeyVaultName) {
    # Use first 8 chars of tenant ID to stay under the 24-char limit
    $KeyVaultName = "kv-governly-$($tenantId.Substring(0,8))"
}
Write-Host "  Key Vault    : $KeyVaultName"

# ── Resource group ─────────────────────────────────────────────────────────────

Write-Host "`n📦 Ensuring resource group '$ResourceGroup' in $Location..." -ForegroundColor Cyan
az group create --name $ResourceGroup --location $Location --output none
Write-Host "  ✓ Resource group ready"

# ── Key Vault ─────────────────────────────────────────────────────────────────

Write-Host "`n🔐 Creating Key Vault '$KeyVaultName'..." -ForegroundColor Cyan
az keyvault create `
    --name              $KeyVaultName `
    --resource-group    $ResourceGroup `
    --location          $Location `
    --enable-rbac-authorization true `
    --output none
Write-Host "  ✓ Key Vault created"

# ── RBAC: grant current user Secrets Officer so we can write/read secrets ──────

Write-Host "`n🛡  Assigning Key Vault Secrets Officer to current user..." -ForegroundColor Cyan
$kvId  = (az keyvault show --name $KeyVaultName --query "id" -o tsv).Trim()
$userId = (az ad signed-in-user show --query "id" -o tsv).Trim()

az role assignment create `
    --role      "Key Vault Secrets Officer" `
    --assignee  $userId `
    --scope     $kvId `
    --output none

Write-Host "  ✓ Role assigned — waiting 15 s for propagation..."
Start-Sleep -Seconds 15

# ── Client secret ─────────────────────────────────────────────────────────────

Write-Host "`n🔑 Generating client secret for app $appId (1-year expiry)..." -ForegroundColor Cyan
$cred = az ad app credential reset `
    --id           $appId `
    --years        1 `
    --append `
    --display-name "governly-dev-keyvault" `
    --output json | ConvertFrom-Json

$secretValue = $cred.password
Write-Host "  ✓ Client secret generated"

# ── Store in Key Vault ────────────────────────────────────────────────────────

Write-Host "`n📥 Storing secret in Key Vault..." -ForegroundColor Cyan
az keyvault secret set `
    --vault-name $KeyVaultName `
    --name       "GovernlyClientSecret" `
    --value      $secretValue `
    --output none
Write-Host "  ✓ Secret stored as 'GovernlyClientSecret'"

# ── Done ──────────────────────────────────────────────────────────────────────

Write-Host "`n✅ Setup complete!" -ForegroundColor Green
Write-Host "`nAdd (or update) this line in .env.dev:" -ForegroundColor Yellow
Write-Host "  KEYVAULT_NAME=$KeyVaultName" -ForegroundColor White
Write-Host "`nThat's it — no secret values in any file." -ForegroundColor Green
