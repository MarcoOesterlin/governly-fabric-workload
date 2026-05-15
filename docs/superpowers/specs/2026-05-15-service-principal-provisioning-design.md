# Service Principal Provisioning — Design Spec

**Date:** 2026-05-15  
**Status:** Approved  
**Scope:** SP provisioning subsystem only. Access Management, Purview Audit Logs, and Data Agent Logs pages are separate follow-on specs.

---

## Problem

Governly's downstream features (Access Management, Purview Audit Logs, Data Agent Logs) require specific Microsoft Graph API permissions granted to the existing app registration. Currently, those permissions are either missing or must be set up manually. There is also no mechanism to track secret expiry or renew the `GovernlyClientSecret` without out-of-band tooling.

---

## Approach

Extend the existing app registration (`FRONTEND_APPID`) rather than creating a new one. A one-click button in the Governly header generates a new 90-day secret, stores it in the existing Key Vault, declares the required Graph permissions on the app registration, and surfaces an admin consent URL if consent is still pending.

This model gives workspace admins everything they can self-serve (secret rotation, permission declaration) while delegating the one step that genuinely requires a Global Admin (consent) to a one-click URL.

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
| 1. Read Key Vault | Fetch existing secret metadata and expiry via Key Vault SDK |
| 2. Generate new secret | `POST /applications/{id}/addPassword` — 90-day password credential |
| 3. Store in Key Vault | Overwrite `GovernlyClientSecret` with new secret value; invalidate proxy cache |
| 4. Declare permissions | `PATCH /applications/{id}` to set `requiredResourceAccess` for all required Graph permissions |
| 5. Check consent | `GET /servicePrincipals/{id}/appRoleAssignments` — verify each permission is consented |
| 6. Result | Done ✅, or "Grant Admin Consent" button if any permission is ungranted |

The "Grant Admin Consent" button opens a new browser tab to the tenant admin consent URL. After the admin consents, the user can click "Check Again" to re-verify.

### Required Permissions

These permissions are declared and verified by the provisioning flow:

| Permission | Purpose |
|---|---|
| `Group.Read.All` | List AD groups assigned to workspace/item roles |
| `GroupMember.Read.All` | Expand AD group membership |
| `AuditLog.Read.All` | Access history (when users were added) + Purview audit logs |
| `Directory.Read.All` | Resolve user and group display names |
| `User.Read.All` | Fetch user profile details |

All are Graph application permissions (not delegated), consistent with the existing `client_credentials` flow.

---

## Backend API (devServer additions)

### `GET /api/sp-status`

Returns the current SP health.

**Response:**
```json
{
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

If the Key Vault secret does not exist, `secretExpiry` is `null` and `daysRemaining` is `-1`.

### `POST /api/sp-setup`

Runs the full provisioning sequence:
1. Calls `POST /applications/{appObjectId}/addPassword` with a 90-day `endDateTime`
2. Writes the returned `secretText` to Key Vault as `GovernlyClientSecret` (overwriting the existing version)
3. Calls `PATCH /applications/{appObjectId}` to set `requiredResourceAccess`
4. Clears the proxy's cached `_clientSecret` so the next Graph call picks up the new secret
5. Returns the same shape as `GET /api/sp-status` reflecting the new state

**Notes:**
- `{appObjectId}` is the app registration's **Object ID** (not the client ID stored in `FRONTEND_APPID`). The proxy resolves it at runtime via `GET /applications?$filter=appId eq '{FRONTEND_APPID}'&$select=id` using the existing `client_credentials` Graph token.
- Requires the app to have `Application.ReadWrite.OwnedBy` (or `Application.ReadWrite.All`) and Key Vault Secrets Officer on the vault. These are typically already present or set up by the initial Key Vault setup script.
- Uses the existing `DefaultAzureCredential` for Key Vault access and the `client_credentials` Graph token for app management calls.

### `GET /api/sp-consent-url`

**Response:**
```json
{
  "url": "https://login.microsoftonline.com/{tenantId}/adminconsent?client_id={clientId}"
}
```

The `redirect_uri` parameter is omitted so Azure redirects to its default post-consent page. The frontend opens this URL in a new tab. After consent, the user returns to Governly and clicks "Check Again" to re-verify via `GET /api/sp-status`.

---

## Frontend Components

### `SpProvisionButton` (new component)

Location: `app/items/GovernlyItem/components/SpProvisionButton.tsx`

- Calls `GET /api/sp-status` on mount
- Renders button with status dot
- On click, opens `SpProvisionModal`

### `SpProvisionModal` (new component)

Location: `app/items/GovernlyItem/components/SpProvisionModal.tsx`

- If status is active: renders status summary + "Renew Now" button
- If setup needed: renders step-by-step auto-running flow using a step list component
- "Grant Admin Consent" step opens consent URL via `GET /api/sp-consent-url` + `window.open`
- "Check Again" button re-calls `GET /api/sp-status`

Both components use Fluent UI (`Button`, `Dialog`, `Spinner`, `ProgressBar`, `Badge`) consistent with existing Governly UI patterns.

---

## Key Vault Secret Naming

| Secret name | Content |
|---|---|
| `GovernlyClientSecret` | Active client secret value (overwritten on each renewal) |

The same name is used as today — the proxy reads it unchanged. No migration needed.

---

## Constraints & Out of Scope

- Secret rotation alerts (e.g., email when expiring) are out of scope for this spec.
- The provisioning flow does not create a new App Registration — it extends the existing one only.
- Key Vault creation is out of scope for this spec. The vault identified by `KEYVAULT_NAME` must already exist. (The existing `Setup-DevKeyVault.ps1` script handles initial vault creation.)
- The app object ID (`FRONTEND_APPID`) is already configured in `.env.dev` and used here; no additional env vars are needed.
