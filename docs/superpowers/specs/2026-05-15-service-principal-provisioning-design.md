# Service Principal Provisioning — Design Spec

**Date:** 2026-05-15  
**Status:** Approved  
**Scope:** SP provisioning subsystem only. Access Management, Purview Audit Logs, and Data Agent Logs pages are separate follow-on specs.

---

## Problem

Governly's downstream features (Access Management, Purview Audit Logs, Data Agent Logs) require specific Microsoft Graph API permissions granted to the existing app registration. Currently, those permissions are either missing or must be set up manually. There is also no mechanism to track secret expiry or renew the `GovernlyClientSecret` without out-of-band tooling.

---

## Approach

Extend the existing app registration (`FRONTEND_APPID`) rather than creating a new one. A one-click button in the Governly header generates a new 90-day secret, stores it in a Key Vault (creating the vault if it does not yet exist), declares the required Graph permissions on the app registration, and surfaces an admin consent URL if consent is still pending.

This model gives workspace admins everything they can self-serve (secret rotation, permission declaration, vault creation) while delegating the steps that genuinely require a Global Admin (one-time bootstrap consent and post-setup admin consent) to one-click URLs.

### Bootstrap Prerequisite

The flow patches the app registration via Microsoft Graph, which itself requires the app to hold `Application.ReadWrite.OwnedBy`. Because the app cannot grant this permission to itself, it must be consented **once** by a Global Admin before the button works. Two supported bootstrap paths:

1. **One-time consent URL** — Governly detects the missing bootstrap permission on first run and shows a "Bootstrap Required" panel with a single consent URL. The Global Admin clicks it once. Subsequent runs are fully self-service.
2. **Manual** — Admin grants `Application.ReadWrite.OwnedBy` via Azure Portal or `az ad app permission admin-consent`. Documented in README.

After bootstrap, the workspace admin running the button needs only Key Vault Contributor (to create/write the vault) and the app's own credentials.

---

## Architecture

### Entry Point: Header Button

A "Service Principal" button is added to the Governly header toolbar, positioned next to the existing "Create Data Agent" button.

The button shows a colored status dot loaded from `GET /api/sp-status`:

| Color | Meaning |
|---|---|
| 🟢 Green | Active, more than 14 days remaining |
| 🟡 Amber | Expiring in ≤ 14 days — shows "expires in X days" |
| 🔴 Red | Expired or not configured |

### Modal Flow

Clicking the button opens a modal. Behaviour depends on current state:

**If SP is active (green):** Show a status summary panel:
- Secret expiry date
- List of permissions with grant status (✅ / ❌)
- "Renew Now" button to re-run the setup flow

**If SP needs setup or is expiring/expired:** Auto-run the setup flow with a step progress indicator:

| Step | Action |
|---|---|
| 0. Bootstrap check | Verify the app has `Application.ReadWrite.OwnedBy` consented. If not, render the Bootstrap Required panel and stop. |
| 1. Ensure Key Vault | If `KEYVAULT_NAME` resolves to an existing vault, use it. Otherwise, create a vault `governly-{tenantShortId}` in the configured subscription/resource group, assign Key Vault Secrets Officer to the app's SP. |
| 2. Read existing state | Fetch current secret metadata from Key Vault (`expiresOn`, `tags.keyId`) to know what to clean up afterwards. |
| 3. Generate new secret | `POST /applications/{appObjectId}/addPassword` — 90-day password credential. Capture `keyId` and `secretText`. |
| 4. Store in Key Vault | Write `secretText` as `GovernlyClientSecret` with `properties.expiresOn = endDateTime` and `tags.keyId = {newKeyId}`. Invalidate proxy cache. |
| 5. Remove old credential | `POST /applications/{appObjectId}/removePassword` for the prior `keyId` (read in step 2). Skipped on first-ever rotation. |
| 6. Merge permissions | `GET /applications/{appObjectId}` → merge required Graph permissions into existing `requiredResourceAccess` (preserving Fabric, PowerBI, and other entries) → `PATCH` the merged result. |
| 7. Check consent | List `appRoleAssignments` where `principalId` = our SP and `resourceId` = Microsoft Graph SP; map `appRoleId` → permission name; mark each required permission granted/missing. |
| 8. Result | Done ✅, or "Grant Admin Consent" button if any permission is ungranted. After successful return, the header re-fetches `/api/sp-status` so the badge updates. |

**Failure handling:** If step 4 (Key Vault write) fails after step 3 succeeded, the flow automatically calls `removePassword` for the just-created `keyId` to roll back the orphaned credential. Any other step failure is non-destructive (declarations and consent checks are idempotent).

The "Grant Admin Consent" button opens a new browser tab to the tenant admin consent URL. After the admin consents, the user can click "Check Again" to re-verify.

### Required Permissions

These Graph application permissions are declared and verified by the provisioning flow:

| Permission | Purpose |
|---|---|
| `Group.Read.All` | List AD groups assigned to workspace/item roles |
| `GroupMember.Read.All` | Expand AD group membership |
| `AuditLog.Read.All` | Access history (when users were added) + Purview audit logs |
| `Directory.Read.All` | Resolve user and group display names |
| `User.Read.All` | Fetch user profile details |
| `InformationProtectionPolicy.Read.All` | (Existing — preserved on merge.) Sensitivity labels |

These permissions support the Governly downstream pages but are *not* declared by this flow:

| Permission | Required for |
|---|---|
| `Application.ReadWrite.OwnedBy` | The provisioning flow itself (bootstrap-only — see Bootstrap Prerequisite). Granted manually once. |

All are Graph application permissions (not delegated), consistent with the existing `client_credentials` flow.

---

## Backend API (devServer additions)

### `GET /api/sp-status`

Returns the current SP health.

**Response:**
```json
{
  "bootstrapGranted": true,
  "vaultExists": true,
  "vaultName": "governly-kv-abc123",
  "secretExpiry": "2026-08-13T00:00:00Z",
  "daysRemaining": 89,
  "permissions": [
    { "name": "Group.Read.All", "granted": true },
    { "name": "GroupMember.Read.All", "granted": false },
    { "name": "AuditLog.Read.All", "granted": true },
    { "name": "Directory.Read.All", "granted": false },
    { "name": "User.Read.All", "granted": false }
  ]
}
```

If the Key Vault secret does not exist, `secretExpiry` and `daysRemaining` are both `null`. If `bootstrapGranted` is `false`, the frontend renders the Bootstrap Required panel and disables the setup flow.

### `POST /api/sp-setup`

Runs the full provisioning sequence (steps 1–7 of the Modal Flow table). Refuses to run if `bootstrapGranted` is false.

**Behaviour:**
1. Resolves the app object ID via `GET /applications?$filter=appId eq '{FRONTEND_APPID}'&$select=id` (cached on first success).
2. Ensures Key Vault exists; creates if missing using the configured subscription/resource group.
3. Reads existing secret + tags to capture prior `keyId`.
4. Calls `POST /applications/{appObjectId}/addPassword` with a 90-day `endDateTime`.
5. Writes the returned `secretText` to Key Vault as `GovernlyClientSecret` with `expiresOn` and `tags.keyId` set. **On write failure**, calls `removePassword` for the new credential to roll back.
6. Calls `removePassword` for the prior `keyId` (skipped if none).
7. Reads current `requiredResourceAccess`, merges in the required Graph permissions (preserving existing entries), and `PATCH`es the result.
8. Clears the proxy's cached `_clientSecret` so the next Graph call picks up the new secret.
9. Returns the same shape as `GET /api/sp-status` reflecting the new state.

**Notes:**
- `{appObjectId}` is the app registration's **Object ID** (not the client ID stored in `FRONTEND_APPID`).
- Concurrency: the endpoint serializes runs via an in-process mutex so two simultaneous clicks don't double-rotate.
- In a multi-instance proxy deployment, the in-memory `_clientSecret` cache invalidation only affects the instance handling the request. For dev (single process) this is fine; production multi-instance deployments should either pin the rotation request to a single instance or accept up to one stale-secret attempt before automatic re-fetch.
- Uses `DefaultAzureCredential` for Key Vault access and the `client_credentials` Graph token for app management calls.

### `GET /api/sp-consent-url`

**Response:**
```json
{
  "url": "https://login.microsoftonline.com/{tenantId}/adminconsent?client_id={clientId}",
  "bootstrapUrl": "https://login.microsoftonline.com/{tenantId}/adminconsent?client_id={clientId}"
}
```

Both URLs target the same admin consent endpoint — Azure shows the user every ungranted permission currently declared on the app, including `Application.ReadWrite.OwnedBy` if it hasn't been bootstrapped yet. The `bootstrapUrl` is surfaced separately in the UI's Bootstrap Required panel for clarity. Tenant ID is derived from the proxy's existing `AUDIENCE` env var (same pattern as `acquireGraphTokenViaClientCredentials`).

---

## Frontend Components

### `SpProvisionButton` (new component)

Location: `app/items/GovernlyItem/components/SpProvisionButton.tsx`

- Calls `GET /api/sp-status` on mount
- Renders button with status dot
- On click, opens `SpProvisionModal`

### `SpProvisionModal` (new component)

Location: `app/items/GovernlyItem/components/SpProvisionModal.tsx`

- If `bootstrapGranted` is false: renders Bootstrap Required panel with the consent URL and explanatory copy. No setup flow runs until bootstrap completes.
- If status is active: renders status summary + "Renew Now" button
- If setup needed: renders step-by-step auto-running flow using a step list component
- "Grant Admin Consent" step opens consent URL via `GET /api/sp-consent-url` + `window.open`
- "Check Again" button re-calls `GET /api/sp-status`
- On successful completion, signals the parent header to re-fetch `/api/sp-status` so the badge color updates without a page refresh.

Both components use Fluent UI (`Button`, `Dialog`, `Spinner`, `ProgressBar`, `Badge`) consistent with existing Governly UI patterns.

---

## Key Vault Secret Naming

| Secret name | Tags | Content |
|---|---|---|
| `GovernlyClientSecret` | `keyId` = Graph `passwordCredential.keyId` | Active client secret value (overwritten on each renewal, with `expiresOn` set to match the credential's 90-day expiry) |

The same name is used as today — the proxy reads it unchanged. The `keyId` tag is added so the rotation flow knows which prior credential to remove via Graph.

---

## Configuration

Two new env vars (with sane defaults) for vault auto-creation:

| Env var | Purpose | Default |
|---|---|---|
| `AZURE_SUBSCRIPTION_ID` | Subscription used when creating a new Key Vault | Required only when vault doesn't exist |
| `AZURE_RESOURCE_GROUP` | Resource group for the new Key Vault | Required only when vault doesn't exist |

If `KEYVAULT_NAME` already resolves to an existing vault, neither is needed.

---

## Constraints & Out of Scope

- Secret rotation alerts (e.g., email when expiring) are out of scope.
- The provisioning flow does not create a new App Registration — it extends the existing one only.
- Bootstrap consent of `Application.ReadWrite.OwnedBy` is a one-time manual step (Azure cannot self-bootstrap an app's right to modify itself).
- Multi-instance proxy cache coherency is not addressed — see Notes on `POST /api/sp-setup`.
- Tenant ID is derived from the existing `AUDIENCE` env var; no new tenant config is added.
