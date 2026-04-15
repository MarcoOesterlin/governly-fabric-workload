<#
.SYNOPSIS
    Creates the Entra ID (Azure AD) app registration for the Governly Fabric Workload.

.DESCRIPTION
    Uses native PowerShell + device code flow — no Azure CLI required.
    Automates all app registration setup: scopes, permissions, pre-authorized clients,
    client secret, redirect URI, and optional claims.

    Prerequisites:
      - PowerShell 7+ (pwsh) — already installed on this machine
      - You must have at least a Cloud Application Administrator role in the target tenant
      - A browser to complete the sign-in

.EXAMPLE
    pwsh .\scripts\CreateGovernlyApp.ps1
#>

param (
    [string]$tenantId
)

$ErrorActionPreference = "Stop"

# ── Helpers ──────────────────────────────────────────────────────────────────

function GraphPost {
    param ([string]$url, [hashtable]$body, [string]$token)
    return Invoke-RestMethod -Method POST -Uri $url `
        -Headers @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" } `
        -Body ($body | ConvertTo-Json -Compress -Depth 10)
}

function PrintInfo {
    param ([string]$key, [string]$value)
    $bold  = [char]27 + "[1m"
    $reset = [char]27 + "[0m"
    Write-Host ("${bold}$key : ${reset}" + $value)
}

# ── Device code sign-in (no Azure CLI needed) ─────────────────────────────

Write-Host ""
Write-Host "=========================================="
Write-Host "  Governly — Fabric Workload App Setup"
Write-Host "=========================================="
Write-Host ""
Write-Host "Authenticating via device code flow..."
Write-Host ""

$PUBLIC_CLIENT_ID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46"  # Azure CLI public client (widely trusted)
$scope = "https://graph.microsoft.com/Application.ReadWrite.All offline_access"

$dcResponse = Invoke-RestMethod -Method POST `
    -Uri "https://login.microsoftonline.com/common/oauth2/v2.0/devicecode" `
    -Body @{ client_id = $PUBLIC_CLIENT_ID; scope = $scope }

Write-Host $dcResponse.message
Write-Host ""

# Open browser automatically if possible
try { Start-Process "https://microsoft.com/devicelogin" } catch {}

# Poll for token
$accessToken = $null
$pollBody = @{
    client_id   = $PUBLIC_CLIENT_ID
    grant_type  = "urn:ietf:params:oauth:grant-type:device_code"
    device_code = $dcResponse.device_code
}

Write-Host "Waiting for sign-in..." -NoNewline
while ($null -eq $accessToken) {
    Start-Sleep -Seconds 5
    try {
        $tokenResponse = Invoke-RestMethod -Method POST `
            -Uri "https://login.microsoftonline.com/common/oauth2/v2.0/token" `
            -Body $pollBody
        $accessToken = $tokenResponse.access_token
        # Extract tenant from token claims
        $claims = [System.Text.Json.JsonDocument]::Parse(
            [System.Text.Encoding]::UTF8.GetString(
                [System.Convert]::FromBase64String(
                    ($accessToken.Split('.')[1].PadRight(($accessToken.Split('.')[1].Length + 3) -band -4, '='))
                )
            )
        ).RootElement
        if (-not $tenantId) {
            $tenantId = $claims.GetProperty("tid").GetString()
        }
        Write-Host " ✅"
    } catch {
        $errBody = $_.ErrorDetails.Message | ConvertFrom-Json -ErrorAction SilentlyContinue
        if ($errBody.error -ne "authorization_pending") { throw }
        Write-Host "." -NoNewline
    }
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

$resultObject = GraphPost -url "https://graph.microsoft.com/v1.0/applications" -body $application -token $accessToken

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

$addPasswordObject = GraphPost `
    -url "https://graph.microsoft.com/v1.0/applications/$applicationObjectId/addPassword" `
    -body $passwordCreds `
    -token $accessToken
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
