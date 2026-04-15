<#
.SYNOPSIS
    Creates the Entra ID (Azure AD) app registration for the Governly Fabric Workload.

.DESCRIPTION
    Uses a local HTTP listener + PKCE auth code flow — opens your browser directly,
    no code to copy or paste. Works from any terminal including VS Code.

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

# ── Auth: local HTTP listener + PKCE (no code to copy) ───────────────────────

Write-Host ""
Write-Host "=========================================="
Write-Host "  Governly — Fabric Workload App Setup"
Write-Host "=========================================="
Write-Host ""

# Uses the well-known Azure CLI public client which has http://localhost registered
$clientId    = "04b07795-8ddb-461a-bbee-02f9e1bf7b46"
$port        = 62001
$redirectUri = "http://localhost:$port/callback"
$scope       = "https://graph.microsoft.com/Application.ReadWrite.All openid profile"

# PKCE
$codeVerifier = -join ((65..90) + (97..122) + (48..57) | Get-Random -Count 64 | ForEach-Object { [char]$_ })
$sha256       = [System.Security.Cryptography.SHA256]::Create()
$codeChallenge = [Convert]::ToBase64String($sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($codeVerifier))).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$state        = [System.Guid]::NewGuid().ToString("N")

$authUrl = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize" +
    "?client_id=$clientId" +
    "&response_type=code" +
    "&redirect_uri=$([Uri]::EscapeDataString($redirectUri))" +
    "&scope=$([Uri]::EscapeDataString($scope))" +
    "&code_challenge=$codeChallenge" +
    "&code_challenge_method=S256" +
    "&state=$state"

# Start local listener
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()

Write-Host "Opening browser for sign-in..."
Start-Process $authUrl

Write-Host "Waiting for sign-in to complete (browser will redirect back)..."
$context = $listener.GetContext()
$listener.Stop()

# Parse auth code from query string
$query = $context.Request.Url.Query.TrimStart('?')
$params = @{}
$query.Split('&') | ForEach-Object {
    $kv = $_.Split('=', 2)
    if ($kv.Count -eq 2) { $params[$kv[0]] = [Uri]::UnescapeDataString($kv[1]) }
}

# Close browser tab
$html = '<html><body><script>window.close()</script><p>Sign-in complete. You can close this window.</p></body></html>'
$buf = [Text.Encoding]::UTF8.GetBytes($html)
$context.Response.ContentLength64 = $buf.Length
$context.Response.OutputStream.Write($buf, 0, $buf.Length)
$context.Response.OutputStream.Close()

if ($params['error']) { throw "Auth error: $($params['error']) — $($params['error_description'])" }
if ($params['state'] -ne $state) { throw "State mismatch — possible CSRF" }

$code = $params['code']

# Exchange code for tokens
$tokenResponse = Invoke-RestMethod -Method POST `
    -Uri "https://login.microsoftonline.com/common/oauth2/v2.0/token" `
    -Body @{
        client_id      = $clientId
        grant_type     = "authorization_code"
        code           = $code
        redirect_uri   = $redirectUri
        code_verifier  = $codeVerifier
    }

$accessToken = $tokenResponse.access_token

# Extract tenant ID from token if not provided
if (-not $tenantId) {
    $payload = $accessToken.Split('.')[1]
    $pad = 4 - ($payload.Length % 4); if ($pad -lt 4) { $payload += '=' * $pad }
    $claims = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload)) | ConvertFrom-Json
    $tenantId = $claims.tid
}

$me = Invoke-RestMethod -Uri "https://graph.microsoft.com/v1.0/me" -Headers @{ Authorization = "Bearer $accessToken" }
Write-Host "Signed in as $($me.userPrincipalName) (tenant: $tenantId)"

function GraphPost {
    param([string]$url, [hashtable]$body)
    return Invoke-RestMethod -Method POST -Uri $url `
        -Headers @{ Authorization = "Bearer $accessToken"; "Content-Type" = "application/json" } `
        -Body ($body | ConvertTo-Json -Compress -Depth 10)
}


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

$appBody = @{
    displayName    = $applicationName
    signInAudience = "AzureADMultipleOrgs"
    optionalClaims = @{ accessToken = @(@{ essential = $false; name = "idtyp" }) }
    spa            = @{ redirectUris = @($redirectUri) }
    identifierUris = @($applicationIdUri)
    api = @{
        oauth2PermissionScopes = @(
            @{ adminConsentDisplayName = "FabricWorkloadControl"; adminConsentDescription = "Allows Fabric to communicate with the Governly workload"; value = "FabricWorkloadControl"; id = $FabricWorkloadControlGuid; isEnabled = $true; type = "User" },
            @{ adminConsentDisplayName = "LabelPolicy.Read.All";  adminConsentDescription = "Read Governly sensitivity label policies";               value = "LabelPolicy.Read.All";  id = $LabelPolicyReadAllGuid;      isEnabled = $true; type = "User" },
            @{ adminConsentDisplayName = "LabelPolicy.ReadWrite.All"; adminConsentDescription = "Read and write Governly sensitivity label policies"; value = "LabelPolicy.ReadWrite.All"; id = $LabelPolicyReadWriteAllGuid; isEnabled = $true; type = "User" }
        )
        preAuthorizedApplications = @(
            @{ appId = "871c010f-5e61-4fb1-83ac-98610a7e9110"; delegatedPermissionIds = @($LabelPolicyReadAllGuid, $LabelPolicyReadWriteAllGuid) },
            @{ appId = "00000009-0000-0000-c000-000000000000"; delegatedPermissionIds = @($FabricWorkloadControlGuid) },
            @{ appId = "d2450708-699c-41e3-8077-b0c8341509aa"; delegatedPermissionIds = @($FabricWorkloadControlGuid) }
        )
    }
    requiredResourceAccess = @(
        @{ resourceAppId = "00000009-0000-0000-c000-000000000000"; resourceAccess = @(
            @{ id = "7ba630b9-8110-4e27-8d17-81e5f2218787"; type = "Scope" },
            @{ id = "b2f1b2fa-f35c-407c-979c-a858a808ba85"; type = "Scope" },
            @{ id = "d2bc95fc-440e-4b0e-bafd-97182de7aef5"; type = "Scope" },
            @{ id = "7a27a256-301d-4359-b77b-c2b759d2e362"; type = "Scope" },
            @{ id = "13060bfd-9305-4ec6-8388-8916580f4fa9"; type = "Scope" }
        )},
        @{ resourceAppId = "00000003-0000-0000-c000-000000000000"; resourceAccess = @(
            @{ id = "e1fe6dd8-ba31-4d61-89e7-88639da4683d"; type = "Scope" },
            @{ id = "4ad84827-5578-4e18-ad7a-86530b12f884"; type = "Scope" }
        )}
    )
}

$resultObject    = GraphPost -url "https://graph.microsoft.com/v1.0/applications" -body $appBody
$applicationObjectId = $resultObject.id
$applicationId       = $resultObject.appId
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
