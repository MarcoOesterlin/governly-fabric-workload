<#
.SYNOPSIS
    Creates the Entra ID (Azure AD) app registration for the Governly Fabric Workload.

.DESCRIPTION
    Uses the Microsoft.Graph PowerShell module (installed automatically if missing).
    Opens a browser popup for interactive sign-in — no code to copy.

    Prerequisites:
      - PowerShell 7+ (pwsh)
      - You must have at least Cloud Application Administrator role in the target tenant

.EXAMPLE
    pwsh .\scripts\CreateGovernlyApp.ps1
#>

param (
    [string]$tenantId
)

$ErrorActionPreference = "Stop"

function PrintInfo {
    param ([string]$key, [string]$value)
    $bold  = [char]27 + "[1m"
    $reset = [char]27 + "[0m"
    Write-Host ("${bold}$key : ${reset}" + $value)
}

# ── Ensure Microsoft.Graph module ────────────────────────────────────────────

Write-Host ""
Write-Host "=========================================="
Write-Host "  Governly — Fabric Workload App Setup"
Write-Host "=========================================="
Write-Host ""

if (-not (Get-Module -Name Microsoft.Graph.Applications -ListAvailable)) {
    Write-Host "Installing Microsoft.Graph.Applications module (one-time)..."
    Install-Module Microsoft.Graph.Applications -Scope CurrentUser -Force -Repository PSGallery
}

Import-Module Microsoft.Graph.Authentication -MinimumVersion 2.0.0 -Force
Import-Module Microsoft.Graph.Applications    -MinimumVersion 2.0.0 -Force

# ── Sign in ──────────────────────────────────────────────────────────────────

Write-Host "Opening browser for sign-in (use your Fabric admin account)..."
$env:MSAL_ENABLE_WAM = "0"  # Force visible browser window instead of hidden WAM popup
Connect-MgGraph -Scopes "Application.ReadWrite.All" -NoWelcome

$context  = Get-MgContext
if (-not $tenantId) { $tenantId = $context.TenantId }
Write-Host "Signed in as $($context.Account) (tenant: $tenantId)"



$applicationName = "Governly Workload"
$workloadName    = "Org.Governly"
$redirectUri     = "http://localhost:60006/close"

# ── Generate Application ID URI ─────────────────────────────────────────────

$randomSuffix     = -join ((65..90) + (97..122) | Get-Random -Count 4 | ForEach-Object { [char]$_ })
$applicationIdUri = "api://localdevinstance/$tenantId/$workloadName/$randomSuffix"

# ── Generate GUIDs for scopes ───────────────────────────────────────────────

$FabricWorkloadControlGuid   = (New-Guid).ToString()
$LabelPolicyReadAllGuid      = (New-Guid).ToString()
$LabelPolicyReadWriteAllGuid = (New-Guid).ToString()

# ── Create the application ──────────────────────────────────────────────────

Write-Host ""
Write-Host "Creating app registration '$applicationName'..."

$resultObject = New-MgApplication `
    -DisplayName $applicationName `
    -SignInAudience "AzureADMultipleOrgs" `
    -IdentifierUris @($applicationIdUri) `
    -Spa @{ RedirectUris = @($redirectUri) } `
    -OptionalClaims @{
        AccessToken = @(@{ Essential = $false; Name = "idtyp" })
    } `
    -Api @{
        Oauth2PermissionScopes = @(
            @{
                AdminConsentDisplayName = "FabricWorkloadControl"
                AdminConsentDescription = "Allows Fabric to communicate with the Governly workload"
                Value                   = "FabricWorkloadControl"
                Id                      = $FabricWorkloadControlGuid
                IsEnabled               = $true
                Type                    = "User"
            },
            @{
                AdminConsentDisplayName = "LabelPolicy.Read.All"
                AdminConsentDescription = "Read Governly sensitivity label policies"
                Value                   = "LabelPolicy.Read.All"
                Id                      = $LabelPolicyReadAllGuid
                IsEnabled               = $true
                Type                    = "User"
            },
            @{
                AdminConsentDisplayName = "LabelPolicy.ReadWrite.All"
                AdminConsentDescription = "Read and write Governly sensitivity label policies"
                Value                   = "LabelPolicy.ReadWrite.All"
                Id                      = $LabelPolicyReadWriteAllGuid
                IsEnabled               = $true
                Type                    = "User"
            }
        )
        PreAuthorizedApplications = @(
            @{ AppId = "871c010f-5e61-4fb1-83ac-98610a7e9110"; DelegatedPermissionIds = @($LabelPolicyReadAllGuid, $LabelPolicyReadWriteAllGuid) },
            @{ AppId = "00000009-0000-0000-c000-000000000000"; DelegatedPermissionIds = @($FabricWorkloadControlGuid) },
            @{ AppId = "d2450708-699c-41e3-8077-b0c8341509aa"; DelegatedPermissionIds = @($FabricWorkloadControlGuid) }
        )
    } `
    -RequiredResourceAccess @(
        @{
            ResourceAppId  = "00000009-0000-0000-c000-000000000000"
            ResourceAccess = @(
                @{ Id = "7ba630b9-8110-4e27-8d17-81e5f2218787"; Type = "Scope" },
                @{ Id = "b2f1b2fa-f35c-407c-979c-a858a808ba85"; Type = "Scope" },
                @{ Id = "d2bc95fc-440e-4b0e-bafd-97182de7aef5"; Type = "Scope" },
                @{ Id = "7a27a256-301d-4359-b77b-c2b759d2e362"; Type = "Scope" },
                @{ Id = "13060bfd-9305-4ec6-8388-8916580f4fa9"; Type = "Scope" }
            )
        },
        @{
            ResourceAppId  = "00000003-0000-0000-c000-000000000000"
            ResourceAccess = @(
                @{ Id = "e1fe6dd8-ba31-4d61-89e7-88639da4683d"; Type = "Scope" },
                @{ Id = "4ad84827-5578-4e18-ad7a-86530b12f884"; Type = "Scope" }
            )
        }
    )

$applicationObjectId = $resultObject.Id
$applicationId       = $resultObject.AppId
Write-Host "Application created successfully."

# ── Print results ────────────────────────────────────────────────────────────

$green = [char]27 + "[32m"
$reset = [char]27 + "[0m"

Write-Host ""
Write-Host "${green}=========================================="
Write-Host "  Governly App Registration — Complete!"
Write-Host "==========================================${reset}"
Write-Host ""
PrintInfo -key "Application Name"           -value $applicationName
PrintInfo -key "Application (Client) Id"    -value $applicationId
PrintInfo -key "ApplicationIdUri / Audience" -value $applicationIdUri
PrintInfo -key "Redirect URI"               -value $redirectUri
Write-Host ""
Write-Host "── Next Steps ──────────────────────────────────────────────────"
Write-Host ""
Write-Host "1. Add these to .env.ghpages:"
Write-Host ""
Write-Host "   FRONTEND_APPID=$applicationId"
Write-Host "   AUDIENCE=$applicationIdUri"
Write-Host ""
Write-Host "2. Grant admin consent (open in browser as a tenant admin):"
Write-Host "   https://login.microsoftonline.com/$tenantId/adminconsent?client_id=$applicationId"
Write-Host ""
Write-Host "3. Run: npm run deploy  (to rebuild with FRONTEND_APPID)"
Write-Host "4. Run: npm run build:manifest  (to create Fabric .nupkg)"
Write-Host "5. Upload the .nupkg in Fabric Admin portal → Workloads"
Write-Host ""
Write-Host "── Portal link ─────────────────────────────────────────────────"
Write-Host "   https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/Overview/appId/$applicationId"
Write-Host ""
