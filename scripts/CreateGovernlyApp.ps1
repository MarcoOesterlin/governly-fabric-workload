<#
.SYNOPSIS
    Creates the Entra ID (Azure AD) app registration for the Governly Fabric Workload.

.DESCRIPTION
    Based on the official Microsoft Fabric WDK pattern (CreateDevAADApp.ps1).
    Automates all app registration setup: scopes, permissions, pre-authorized clients,
    client secret, redirect URI, and optional claims.

    Prerequisites:
      - Azure CLI installed and on your PATH (https://aka.ms/installazurecli)
      - You must have at least a Cloud Application Administrator role in the target tenant

.PARAMETER tenantId
    The Entra ID tenant ID where the Fabric workspace lives.
    If not provided, the script will prompt for it.

.EXAMPLE
    .\CreateGovernlyApp.ps1 -tenantId "bbbbcccc-1111-dddd-2222-eeee3333ffff"
#>

param (
    [string]$tenantId
)

# ── Helpers ──────────────────────────────────────────────────────────────────

function PostAADRequest {
    param (
        [string]$url,
        [string]$body
    )
    # Write body to temp file to avoid shell quoting issues across platforms
    $tempFile = [System.IO.Path]::GetTempFileName()
    $body | Out-File -FilePath $tempFile -Encoding utf8
    $result = az rest --method POST --url $url --headers "Content-Type=application/json" --body "@$tempFile"
    Remove-Item $tempFile
    return $result
}

function PrintInfo {
    param (
        [string]$key,
        [string]$value
    )
    $bold  = [char]27 + "[1m"
    $reset = [char]27 + "[0m"
    Write-Host ("${bold}$key : ${reset}" + $value)
}

# ── Sign in ──────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "=========================================="
Write-Host "  Governly — Fabric Workload App Setup"
Write-Host "=========================================="
Write-Host ""

$loginResult = az login --allow-no-subscriptions
if (-not $loginResult) {
    Write-Host "Azure CLI login failed. Please install Azure CLI and try again."
    Exit 1
}

# ── Collect parameters ───────────────────────────────────────────────────────

if (-not $tenantId) {
    $tenantId = Read-Host "Enter your Fabric tenant ID (find it at https://entra.microsoft.com → Overview)"
}

$applicationName = "Governly Workload"
$workloadName    = "Org.Governly"
$redirectUri     = "http://localhost:60006/close"

# ── Generate Application ID URI ─────────────────────────────────────────────

$randomLength = Get-Random -Minimum 2 -Maximum 6
$randomSuffix = -join ((65..90) + (97..122) | Get-Random -Count $randomLength | ForEach-Object { [char]$_ })

# Format: api://localdevinstance/<tenantId>/Org.Governly/<random>
$applicationIdUri = "api://localdevinstance/" + $tenantId + "/" + $workloadName + "/" + $randomSuffix

# ── Generate GUIDs for scopes ───────────────────────────────────────────────

$FabricWorkloadControlGuid   = (New-Guid).ToString()
$LabelPolicyReadAllGuid      = (New-Guid).ToString()
$LabelPolicyReadWriteAllGuid = (New-Guid).ToString()

# ── Build the application object ────────────────────────────────────────────

$application = @{
    displayName    = $applicationName
    signInAudience = "AzureADMultipleOrgs"

    # Optional claims — idtyp lets the backend distinguish app-only tokens
    optionalClaims = @{
        accessToken = @(
            @{
                essential = $false
                name      = "idtyp"
            }
        )
    }

    # SPA redirect for Fabric's auth flow
    spa = @{
        redirectUris = @( $redirectUri )
    }

    # Application ID URI (audience)
    identifierUris = @( $applicationIdUri )

    # ── Expose an API: scopes + pre-authorized clients ──────────────────
    api = @{
        oauth2PermissionScopes = @(
            # Required by Fabric for workload ↔ backend communication
            @{
                adminConsentDisplayName = "FabricWorkloadControl"
                adminConsentDescription = "Allows Fabric to communicate with the Governly backend"
                value                   = "FabricWorkloadControl"
                id                      = $FabricWorkloadControlGuid
                isEnabled               = $true
                type                    = "User"
            },
            # Governly-specific: read label policies
            @{
                adminConsentDisplayName = "LabelPolicy.Read.All"
                adminConsentDescription = "Read Governly sensitivity label policies"
                value                   = "LabelPolicy.Read.All"
                id                      = $LabelPolicyReadAllGuid
                isEnabled               = $true
                type                    = "User"
            },
            # Governly-specific: read/write label policies
            @{
                adminConsentDisplayName = "LabelPolicy.ReadWrite.All"
                adminConsentDescription = "Read and write Governly sensitivity label policies"
                value                   = "LabelPolicy.ReadWrite.All"
                id                      = $LabelPolicyReadWriteAllGuid
                isEnabled               = $true
                type                    = "User"
            }
        )

        preAuthorizedApplications = @(
            # Fabric frontend — pre-authorize for Governly item scopes
            @{
                appId                  = "871c010f-5e61-4fb1-83ac-98610a7e9110"
                delegatedPermissionIds = @(
                    $LabelPolicyReadAllGuid,
                    $LabelPolicyReadWriteAllGuid
                )
            },
            # Power BI Service / Fabric backend — pre-authorize for workload control
            @{
                appId                  = "00000009-0000-0000-c000-000000000000"
                delegatedPermissionIds = @(
                    $FabricWorkloadControlGuid
                )
            },
            # Fabric backend operations client
            @{
                appId                  = "d2450708-699c-41e3-8077-b0c8341509aa"
                delegatedPermissionIds = @(
                    $FabricWorkloadControlGuid
                )
            }
        )
    }

    # ── API Permissions (delegated) ─────────────────────────────────────
    requiredResourceAccess = @(
        # Power BI Service / Microsoft Fabric
        @{
            resourceAppId  = "00000009-0000-0000-c000-000000000000"
            resourceAccess = @(
                @{ id = "7ba630b9-8110-4e27-8d17-81e5f2218787"; type = "Scope" }, # Fabric.Extend
                @{ id = "b2f1b2fa-f35c-407c-979c-a858a808ba85"; type = "Scope" }, # Workspace.Read.All
                @{ id = "d2bc95fc-440e-4b0e-bafd-97182de7aef5"; type = "Scope" }, # Item.Read.All
                @{ id = "7a27a256-301d-4359-b77b-c2b759d2e362"; type = "Scope" }, # Item.ReadWrite.All
                @{ id = "13060bfd-9305-4ec6-8388-8916580f4fa9"; type = "Scope" }  # Lakehouse.Read.All
            )
        },
        # Microsoft Graph
        @{
            resourceAppId  = "00000003-0000-0000-c000-000000000000"
            resourceAccess = @(
                @{ id = "e1fe6dd8-ba31-4d61-89e7-88639da4683d"; type = "Scope" }, # User.Read
                @{ id = "4ad84827-5578-4e18-ad7a-86530b12f884"; type = "Scope" }  # InformationProtectionPolicy.Read
            )
        },
        # Azure Storage (for lakehouse access)
        @{
            resourceAppId  = "e406a681-f3d4-42a8-90b6-c2b029497af1"
            resourceAccess = @(
                @{ id = "03e0da56-190b-40ad-a80c-ea378c433f7f"; type = "Scope" }  # user_impersonation
            )
        }
    )
}

# ── Create the application ──────────────────────────────────────────────────

Write-Host ""
Write-Host "Creating app registration '$applicationName'..."

$applicationJson = ($application | ConvertTo-Json -Compress -Depth 10)
$result = PostAADRequest -url "https://graph.microsoft.com/v1.0/applications" -body $applicationJson
$resultObject = $result | ConvertFrom-Json

$applicationObjectId = $resultObject.id
if ($null -eq $applicationObjectId) {
    Write-Host "Failed to create the application. Check your permissions and try again."
    Exit 1
}

$applicationId = $resultObject.appId
Write-Host "Application created successfully."

# ── Generate a client secret ────────────────────────────────────────────────

Write-Host "Generating client secret..."

$startUtc = [DateTime]::UtcNow
$endUtc   = $startUtc.AddDays(180)

$passwordCreds = @{
    passwordCredential = @{
        displayName   = "GovernlySecret"
        startDateTime = $startUtc.ToString('u') -replace ' ', 'T'
        endDateTime   = $endUtc.ToString('u') -replace ' ', 'T'
    }
}
$passwordCredsJson = ($passwordCreds | ConvertTo-Json -Compress -Depth 10)

$addPasswordResult = PostAADRequest -url ("https://graph.microsoft.com/v1.0/applications/" + $applicationObjectId + "/addPassword") -body $passwordCredsJson
$addPasswordObject = ($addPasswordResult | ConvertFrom-Json)
$secret = $addPasswordObject.secretText

if ($null -eq $secret) {
    Write-Host "WARNING: Failed to generate secret automatically. Please add one manually in the Azure Portal."
}

# ── Print results ────────────────────────────────────────────────────────────

$green = [char]27 + "[32m"
$reset = [char]27 + "[0m"

Write-Host ""
Write-Host "${green}=========================================="
Write-Host "  Governly App Registration — Complete!"
Write-Host "==========================================${reset}"
Write-Host ""
PrintInfo -key "Application Name"              -value $applicationName
PrintInfo -key "Application (Client) Id"       -value $applicationId
PrintInfo -key "ApplicationIdUri / Audience"    -value $applicationIdUri
PrintInfo -key "Redirect URI"                   -value $redirectUri
PrintInfo -key "Client Secret"                  -value $secret
PrintInfo -key "Secret Expires"                 -value $endUtc.ToString("yyyy-MM-dd")
Write-Host ""
Write-Host "── Next Steps ──────────────────────────────────────────────────"
Write-Host ""
Write-Host "1. Copy these values into your .env file:"
Write-Host ""
Write-Host "   CLIENTID=$applicationId"
Write-Host "   CLIENTSECRET=$secret"
Write-Host "   WORKLOAD_NAME=$workloadName"
Write-Host "   BACKEND_PORT=5000"
Write-Host "   PUBLISHER_TENANT_ID=$tenantId"
Write-Host "   AUDIENCE=$applicationIdUri"
Write-Host ""
Write-Host "2. Grant admin consent (open this URL as a tenant admin):"
Write-Host "   https://login.microsoftonline.com/$tenantId/adminconsent?client_id=$applicationId"
Write-Host ""
Write-Host "3. View your app registration in the Azure Portal:"
Write-Host "   https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/Overview/appId/$applicationId/isMSAApp~/false"
Write-Host ""
