# Service Principal Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-click button in the Governly header that provisions/rotates the app registration's client secret in Key Vault, declares required Graph permissions, and surfaces an admin consent URL when needed.

**Architecture:** A new `spProvisioning.js` backend module exposes three Express endpoints (`/api/sp-status`, `/api/sp-setup`, `/api/sp-consent-url`) that drive a frontend status badge + modal. Backend uses Microsoft Graph for app management and `@azure/arm-keyvault` for vault creation; frontend extends `GovernlyApiClient` with three new methods consumed by two new React components.

**Tech Stack:** Node.js (devServer), Express, `@azure/identity`, `@azure/keyvault-secrets`, `@azure/arm-keyvault`, `@azure/arm-resources`, React 18, Fluent UI v9, TypeScript.

**Spec:** `docs/superpowers/specs/2026-05-15-service-principal-provisioning-design.md`

**Verification approach:** No test framework exists in this repo. Each backend task ends with a `curl` smoke test against the running devServer. Each frontend task ends with manual browser verification at `https://localhost:60006`. Run `npm start` in a separate terminal to keep the devServer alive across tasks.

---

## File Structure

**Backend (devServer/):**
- `spProvisioning.js` (new) — core SP logic: resolve app object ID, status check, vault ensure/create, secret rotation, permission merge, consent verification
- `governlyProxy.js` (modify) — export `acquireGraphTokenViaClientCredentials` and a new `invalidateClientSecretCache()` helper
- `index.js` (modify) — register three new endpoints

**Frontend (app/):**
- `clients/GovernlyApiClient.ts` (modify) — add `getSpStatus`, `provisionSp`, `getSpConsentUrl` + related types
- `items/GovernlyItem/components/SpStatusBadge.tsx` (new) — header button with colored status dot
- `items/GovernlyItem/components/SpProvisionModal.tsx` (new) — modal driving the setup flow
- `items/GovernlyItem/GovernlyItemEditor.tsx` (modify) — render the badge in the header next to "Create Data Agent"

**Config / docs:**
- `package.json` (modify) — add `@azure/arm-keyvault`, `@azure/arm-resources`
- `.env.example` (modify) — document `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`

---

## Required Constants

The set of Graph permissions to declare. **Use this exact list everywhere it appears in code below** — referenced in tasks 4, 7, 9.

```js
// devServer/spProvisioning.js — top of file
const REQUIRED_GRAPH_PERMISSIONS = [
  { name: 'Group.Read.All',                  id: '5b567255-7703-4780-807c-7be8301ae99b' },
  { name: 'GroupMember.Read.All',            id: '98830695-27a2-44f7-8c18-0c3ebc9698f6' },
  { name: 'AuditLog.Read.All',               id: 'b0afded3-3588-46d8-8b3d-9842eff778da' },
  { name: 'Directory.Read.All',              id: '7ab1d382-f21e-4acd-a863-ba3e13f7da61' },
  { name: 'User.Read.All',                   id: 'df021288-bdef-4463-88db-98f22de89214' },
];

// Bootstrap permission (not declared by setup, only verified by status):
const BOOTSTRAP_PERMISSION = { name: 'Application.ReadWrite.OwnedBy', id: '18a4783c-866b-4cc7-a460-3d5e5662c884' };

// Microsoft Graph SP appId (constant, same in every tenant):
const GRAPH_APP_ID = '00000003-0000-0000-c000-000000000000';
```

These IDs are documented Microsoft Graph application permission IDs (stable per Microsoft).

---

## Task 1: Add Azure ARM Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install ARM packages**

```bash
npm install --save-dev @azure/arm-keyvault@^4.2.1 @azure/arm-resources@^5.2.0
```

- [ ] **Step 2: Verify installation**

```bash
node -e "console.log(require('@azure/arm-keyvault').KeyVaultManagementClient.name); console.log(require('@azure/arm-resources').ResourceManagementClient.name)"
```

Expected output:
```
KeyVaultManagementClient
ResourceManagementClient
```

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @azure/arm-keyvault and @azure/arm-resources for SP provisioning

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: Export Graph Token Helper + Cache Invalidator from Proxy

**Files:**
- Modify: `devServer/governlyProxy.js` (around the existing `module.exports` at line ~304)

The new module needs to call `acquireGraphTokenViaClientCredentials()` directly, and rotate the cached `_clientSecret` after writing a new one.

- [ ] **Step 1: Add cache invalidator function**

In `devServer/governlyProxy.js`, immediately after the `readClientSecretFromKeyVault` function (around line 51), add:

```js
function invalidateClientSecretCache() {
  _clientSecret = null;
  _graphToken = null;
  console.log('[Proxy] Client secret + Graph token caches cleared.');
}
```

- [ ] **Step 2: Export both helpers**

Find the existing exports at the bottom of `governlyProxy.js`:

```js
module.exports = async function governlyProxyMiddleware(req, res, next) {
  ...
};

module.exports.acquireFabricToken = () => acquireAzToken(AZ_TOKEN_RESOURCES.fabric);
```

Add immediately after:

```js
module.exports.acquireGraphTokenViaClientCredentials = acquireGraphTokenViaClientCredentials;
module.exports.invalidateClientSecretCache = invalidateClientSecretCache;
```

- [ ] **Step 3: Smoke-test devServer still starts**

In a terminal:
```bash
npm start
```
Wait for "compiled successfully" then Ctrl+C. Expected: no syntax errors, no "is not a function" errors during startup.

- [ ] **Step 4: Commit**

```bash
git add devServer/governlyProxy.js
git commit -m "feat(proxy): export Graph token helper and cache invalidator

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: Create spProvisioning.js Skeleton with Constants and Helpers

**Files:**
- Create: `devServer/spProvisioning.js`

- [ ] **Step 1: Create the skeleton file**

```js
/**
 * Service Principal Provisioning
 *
 * Drives the SP setup flow:
 *   - Resolves the app's Object ID from FRONTEND_APPID
 *   - Reads/writes Graph applications and passwordCredentials
 *   - Ensures an Azure Key Vault exists (creates if missing) and writes secrets
 *   - Verifies which Graph application permissions are admin-consented
 *   - Builds the admin-consent URL
 *
 * Tenant ID and client ID are derived from the proxy's existing AUDIENCE
 * + FRONTEND_APPID env vars (same pattern as governlyProxy.js).
 */

const { DefaultAzureCredential } = require('@azure/identity');
const { SecretClient } = require('@azure/keyvault-secrets');
const {
  acquireGraphTokenViaClientCredentials,
  invalidateClientSecretCache,
} = require('./governlyProxy');
const https = require('https');

// ── Constants ───────────────────────────────────────────────────────────────

const REQUIRED_GRAPH_PERMISSIONS = [
  { name: 'Group.Read.All',                  id: '5b567255-7703-4780-807c-7be8301ae99b' },
  { name: 'GroupMember.Read.All',            id: '98830695-27a2-44f7-8c18-0c3ebc9698f6' },
  { name: 'AuditLog.Read.All',               id: 'b0afded3-3588-46d8-8b3d-9842eff778da' },
  { name: 'Directory.Read.All',              id: '7ab1d382-f21e-4acd-a863-ba3e13f7da61' },
  { name: 'User.Read.All',                   id: 'df021288-bdef-4463-88db-98f22de89214' },
];

const BOOTSTRAP_PERMISSION = { name: 'Application.ReadWrite.OwnedBy', id: '18a4783c-866b-4cc7-a460-3d5e5662c884' };
const GRAPH_APP_ID = '00000003-0000-0000-c000-000000000000';
const SECRET_NAME = 'GovernlyClientSecret';
const SECRET_LIFETIME_DAYS = 90;

// ── Helpers ─────────────────────────────────────────────────────────────────

function getTenantId() {
  const audience = process.env.AUDIENCE || '';
  const tenantId = audience.split('/')[3];
  if (!tenantId) throw new Error('Cannot derive tenantId from AUDIENCE env var.');
  return tenantId;
}

function getClientId() {
  const id = process.env.FRONTEND_APPID;
  if (!id) throw new Error('FRONTEND_APPID env var is not set.');
  return id;
}

function getVaultName() {
  return process.env.KEYVAULT_NAME || `governly-${getTenantId().slice(0, 8)}`;
}

/** Minimal HTTPS request helper returning { ok, status, body }. */
function httpJson(url, { method = 'GET', token, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + (u.search || ''),
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': String(Buffer.byteLength(data)) } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch {}
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          body: parsed,
          raw,
        });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// In-process mutex so two simultaneous /api/sp-setup requests serialize.
let _setupInFlight = null;

let _appObjectIdCache = null;

async function resolveAppObjectId(graphToken) {
  if (_appObjectIdCache) return _appObjectIdCache;
  const clientId = getClientId();
  const url = `https://graph.microsoft.com/v1.0/applications?$filter=appId eq '${clientId}'&$select=id`;
  const resp = await httpJson(url, { token: graphToken });
  if (!resp.ok) throw new Error(`Failed to resolve app object id: ${resp.status} ${resp.raw.slice(0, 300)}`);
  const id = resp.body?.value?.[0]?.id;
  if (!id) throw new Error(`No application found with appId ${clientId}.`);
  _appObjectIdCache = id;
  return id;
}

let _graphSpObjectIdCache = null;

async function resolveGraphServicePrincipalId(graphToken) {
  if (_graphSpObjectIdCache) return _graphSpObjectIdCache;
  const url = `https://graph.microsoft.com/v1.0/servicePrincipals?$filter=appId eq '${GRAPH_APP_ID}'&$select=id`;
  const resp = await httpJson(url, { token: graphToken });
  if (!resp.ok) throw new Error(`Failed to resolve Graph SP: ${resp.status} ${resp.raw.slice(0, 300)}`);
  const id = resp.body?.value?.[0]?.id;
  if (!id) throw new Error('Microsoft Graph service principal not found in this tenant.');
  _graphSpObjectIdCache = id;
  return id;
}

async function resolveOurServicePrincipalId(graphToken) {
  const clientId = getClientId();
  const url = `https://graph.microsoft.com/v1.0/servicePrincipals?$filter=appId eq '${clientId}'&$select=id`;
  const resp = await httpJson(url, { token: graphToken });
  if (!resp.ok) throw new Error(`Failed to resolve our SP: ${resp.status} ${resp.raw.slice(0, 300)}`);
  return resp.body?.value?.[0]?.id || null;
}

module.exports = {
  REQUIRED_GRAPH_PERMISSIONS,
  BOOTSTRAP_PERMISSION,
  GRAPH_APP_ID,
  SECRET_NAME,
  SECRET_LIFETIME_DAYS,
  getTenantId,
  getClientId,
  getVaultName,
  httpJson,
  resolveAppObjectId,
  resolveGraphServicePrincipalId,
  resolveOurServicePrincipalId,
  invalidateClientSecretCache,
};
```

- [ ] **Step 2: Smoke-test the file loads**

```bash
node -e "const m = require('./devServer/spProvisioning'); console.log(Object.keys(m))"
```

Expected output (order may vary):
```
[
  'REQUIRED_GRAPH_PERMISSIONS', 'BOOTSTRAP_PERMISSION', 'GRAPH_APP_ID',
  'SECRET_NAME', 'SECRET_LIFETIME_DAYS', 'getTenantId', 'getClientId',
  'getVaultName', 'httpJson', 'resolveAppObjectId',
  'resolveGraphServicePrincipalId', 'resolveOurServicePrincipalId',
  'invalidateClientSecretCache'
]
```

- [ ] **Step 3: Commit**

```bash
git add devServer/spProvisioning.js
git commit -m "feat(sp): add spProvisioning module with constants and helpers

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 4: Implement getSpStatus

**Files:**
- Modify: `devServer/spProvisioning.js`

- [ ] **Step 1: Add the status function**

Append to `devServer/spProvisioning.js` (before `module.exports`):

```js
// ── Status check ────────────────────────────────────────────────────────────

async function readVaultSecret(vaultName) {
  try {
    const credential = new DefaultAzureCredential();
    const client = new SecretClient(`https://${vaultName}.vault.azure.net`, credential);
    const secret = await client.getSecret(SECRET_NAME);
    return {
      vaultExists: true,
      expiresOn: secret.properties.expiresOn ? secret.properties.expiresOn.toISOString() : null,
      keyId: secret.properties.tags?.keyId || null,
    };
  } catch (err) {
    if (err.code === 'SecretNotFound' || err.statusCode === 404) {
      return { vaultExists: true, expiresOn: null, keyId: null };
    }
    if (err.code === 'VaultNotFound' || err.statusCode === 404 || /not found/i.test(err.message || '')) {
      return { vaultExists: false, expiresOn: null, keyId: null };
    }
    throw err;
  }
}

/**
 * Lists Graph appRoleAssignments granted to our SP and returns a Set of granted appRoleIds.
 * Returns null if our SP doesn't exist yet (which means nothing is consented).
 */
async function listGrantedGraphRoleIds(graphToken) {
  const ourSpId = await resolveOurServicePrincipalId(graphToken);
  if (!ourSpId) return new Set();
  const graphSpId = await resolveGraphServicePrincipalId(graphToken);
  const url = `https://graph.microsoft.com/v1.0/servicePrincipals/${ourSpId}/appRoleAssignments?$top=999`;
  const resp = await httpJson(url, { token: graphToken });
  if (!resp.ok) throw new Error(`Failed to list app role assignments: ${resp.status} ${resp.raw.slice(0, 300)}`);
  const granted = new Set();
  for (const a of resp.body?.value ?? []) {
    if (a.resourceId === graphSpId) granted.add(a.appRoleId);
  }
  return granted;
}

async function getSpStatus() {
  const graphToken = await acquireGraphTokenViaClientCredentials();
  const vaultName = getVaultName();

  const [vaultInfo, grantedRoleIds] = await Promise.all([
    readVaultSecret(vaultName),
    listGrantedGraphRoleIds(graphToken).catch(() => new Set()),
  ]);

  const bootstrapGranted = grantedRoleIds.has(BOOTSTRAP_PERMISSION.id);
  const permissions = REQUIRED_GRAPH_PERMISSIONS.map(p => ({
    name: p.name,
    granted: grantedRoleIds.has(p.id),
  }));

  let daysRemaining = null;
  if (vaultInfo.expiresOn) {
    const ms = new Date(vaultInfo.expiresOn).getTime() - Date.now();
    daysRemaining = Math.floor(ms / (1000 * 60 * 60 * 24));
  }

  return {
    bootstrapGranted,
    vaultExists: vaultInfo.vaultExists,
    vaultName,
    secretExpiry: vaultInfo.expiresOn,
    daysRemaining,
    permissions,
  };
}

module.exports.getSpStatus = getSpStatus;
```

- [ ] **Step 2: Commit**

```bash
git add devServer/spProvisioning.js
git commit -m "feat(sp): implement getSpStatus

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 5: Wire `/api/sp-status` Endpoint and Smoke Test

**Files:**
- Modify: `devServer/index.js`

- [ ] **Step 1: Register the endpoint**

In `devServer/index.js`, find the line that imports `governlyProxy` (line 8) and add immediately after:

```js
const spProvisioning = require('./spProvisioning');
```

Then in `registerDevServerApis(app)`, immediately before the existing `console.log('*** Mounting Governly DQ Routes ***');` line, add:

```js
  app.get('/api/sp-status', async (_req, res) => {
    try {
      const status = await spProvisioning.getSpStatus();
      res.json(status);
    } catch (err) {
      console.error('[SpStatus] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
```

- [ ] **Step 2: Start devServer**

```bash
npm start
```

Wait for "compiled successfully".

- [ ] **Step 3: Smoke test the endpoint**

In a separate terminal:

```bash
curl -k https://localhost:60006/api/sp-status
```

Expected: JSON with shape (values will vary):
```json
{
  "bootstrapGranted": true,
  "vaultExists": true,
  "vaultName": "<your vault>",
  "secretExpiry": null,
  "daysRemaining": null,
  "permissions": [
    {"name":"Group.Read.All","granted":false},
    ...
  ]
}
```

If any field is missing or the request 500s, fix before continuing.

- [ ] **Step 4: Stop devServer (Ctrl+C in its terminal) and commit**

```bash
git add devServer/index.js
git commit -m "feat(sp): expose GET /api/sp-status endpoint

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 6: Implement getConsentUrl + Wire `/api/sp-consent-url`

**Files:**
- Modify: `devServer/spProvisioning.js`
- Modify: `devServer/index.js`

- [ ] **Step 1: Add the function**

Append to `devServer/spProvisioning.js` (before `module.exports.getSpStatus`):

```js
function getConsentUrl() {
  const tenantId = getTenantId();
  const clientId = getClientId();
  const url = `https://login.microsoftonline.com/${tenantId}/adminconsent?client_id=${clientId}`;
  return { url, bootstrapUrl: url };
}

module.exports.getConsentUrl = getConsentUrl;
```

- [ ] **Step 2: Register the endpoint**

In `devServer/index.js`, immediately after the `app.get('/api/sp-status', ...)` block from Task 5, add:

```js
  app.get('/api/sp-consent-url', (_req, res) => {
    try {
      res.json(spProvisioning.getConsentUrl());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
```

- [ ] **Step 3: Smoke test**

```bash
npm start
# in another terminal:
curl -k https://localhost:60006/api/sp-consent-url
```

Expected:
```json
{"url":"https://login.microsoftonline.com/<tenantId>/adminconsent?client_id=<clientId>","bootstrapUrl":"https://login.microsoftonline.com/<tenantId>/adminconsent?client_id=<clientId>"}
```

- [ ] **Step 4: Stop devServer and commit**

```bash
git add devServer/spProvisioning.js devServer/index.js
git commit -m "feat(sp): add /api/sp-consent-url endpoint

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 7: Implement Vault Ensure Helper

**Files:**
- Modify: `devServer/spProvisioning.js`

The setup flow may need to create the vault. Isolate this so the rotation logic stays readable.

- [ ] **Step 1: Add ensureVault**

Append to `devServer/spProvisioning.js`:

```js
// ── Key Vault ensure (create if missing) ───────────────────────────────────

async function ensureVault(vaultName) {
  const credential = new DefaultAzureCredential();
  const existing = await readVaultSecret(vaultName);
  if (existing.vaultExists) return { vaultName, created: false };

  const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID;
  const resourceGroup = process.env.AZURE_RESOURCE_GROUP;
  if (!subscriptionId || !resourceGroup) {
    throw new Error(
      `Key Vault "${vaultName}" does not exist and AZURE_SUBSCRIPTION_ID / ` +
      `AZURE_RESOURCE_GROUP are not set in .env.dev. Either create the vault ` +
      `manually or set both env vars to enable auto-provisioning.`
    );
  }

  const { KeyVaultManagementClient } = require('@azure/arm-keyvault');
  const tenantId = getTenantId();
  const kvMgmt = new KeyVaultManagementClient(credential, subscriptionId);

  console.log(`[SP] Creating Key Vault "${vaultName}" in ${resourceGroup}...`);
  await kvMgmt.vaults.beginCreateOrUpdateAndWait(resourceGroup, vaultName, {
    location: process.env.AZURE_LOCATION || 'westeurope',
    properties: {
      tenantId,
      sku: { family: 'A', name: 'standard' },
      enableRbacAuthorization: true,
      accessPolicies: [],
    },
  });
  console.log(`[SP] Vault "${vaultName}" created. ` +
    `NOTE: an RBAC role (Key Vault Secrets Officer) must be assigned to your ` +
    `signed-in identity / app SP before secrets can be written.`);
  return { vaultName, created: true };
}

module.exports.ensureVault = ensureVault;
```

- [ ] **Step 2: Smoke-test module still loads**

```bash
node -e "const m = require('./devServer/spProvisioning'); console.log(typeof m.ensureVault)"
```

Expected: `function`

- [ ] **Step 3: Commit**

```bash
git add devServer/spProvisioning.js
git commit -m "feat(sp): add ensureVault helper for auto-creating Key Vault

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 8: Implement provisionSp (the full setup flow)

**Files:**
- Modify: `devServer/spProvisioning.js`

This is the largest single backend task. It implements steps 3–7 from the spec's modal flow table.

- [ ] **Step 1: Add the orchestration function**

Append to `devServer/spProvisioning.js`:

```js
// ── Setup flow ─────────────────────────────────────────────────────────────

async function _provisionSpInner() {
  const graphToken = await acquireGraphTokenViaClientCredentials();
  const vaultName = getVaultName();

  // Step 0: Bootstrap check
  const grantedRoleIds = await listGrantedGraphRoleIds(graphToken);
  if (!grantedRoleIds.has(BOOTSTRAP_PERMISSION.id)) {
    throw new Error(
      `Bootstrap permission "${BOOTSTRAP_PERMISSION.name}" is not consented. ` +
      `A Global Admin must visit /api/sp-consent-url and grant consent before ` +
      `setup can run.`
    );
  }

  // Step 1: Ensure vault
  await ensureVault(vaultName);

  // Step 2: Read existing state to know what to clean up
  const priorVaultInfo = await readVaultSecret(vaultName);
  const priorKeyId = priorVaultInfo.keyId;

  // Step 3: Generate new secret via Graph
  const appObjectId = await resolveAppObjectId(graphToken);
  const endDateTime = new Date(Date.now() + SECRET_LIFETIME_DAYS * 24 * 3600 * 1000).toISOString();

  const addPwResp = await httpJson(
    `https://graph.microsoft.com/v1.0/applications/${appObjectId}/addPassword`,
    {
      method: 'POST',
      token: graphToken,
      body: {
        passwordCredential: {
          displayName: 'Governly Auto-Rotated',
          endDateTime,
        },
      },
    }
  );
  if (!addPwResp.ok) {
    throw new Error(`addPassword failed: ${addPwResp.status} ${addPwResp.raw.slice(0, 400)}`);
  }
  const newSecretText = addPwResp.body.secretText;
  const newKeyId = addPwResp.body.keyId;
  if (!newSecretText || !newKeyId) {
    throw new Error('addPassword returned no secretText / keyId.');
  }

  // Step 4: Write to Key Vault. On failure, roll back the new credential.
  try {
    const credential = new DefaultAzureCredential();
    const client = new SecretClient(`https://${vaultName}.vault.azure.net`, credential);
    await client.setSecret(SECRET_NAME, newSecretText, {
      expiresOn: new Date(endDateTime),
      tags: { keyId: newKeyId },
    });
    invalidateClientSecretCache();
  } catch (kvErr) {
    console.error('[SP] Key Vault write failed, rolling back new credential:', kvErr.message);
    try {
      await httpJson(
        `https://graph.microsoft.com/v1.0/applications/${appObjectId}/removePassword`,
        { method: 'POST', token: graphToken, body: { keyId: newKeyId } }
      );
    } catch (rollbackErr) {
      console.error('[SP] Rollback also failed:', rollbackErr.message);
    }
    throw new Error(`Key Vault write failed: ${kvErr.message}`);
  }

  // Step 5: Remove prior credential (best-effort; never fail the rotation for this).
  if (priorKeyId && priorKeyId !== newKeyId) {
    try {
      await httpJson(
        `https://graph.microsoft.com/v1.0/applications/${appObjectId}/removePassword`,
        { method: 'POST', token: graphToken, body: { keyId: priorKeyId } }
      );
    } catch (e) {
      console.warn(`[SP] Failed to remove old credential ${priorKeyId}: ${e.message}`);
    }
  }

  // Step 6: Merge required Graph permissions into requiredResourceAccess
  const appResp = await httpJson(
    `https://graph.microsoft.com/v1.0/applications/${appObjectId}?$select=requiredResourceAccess`,
    { token: graphToken }
  );
  if (!appResp.ok) throw new Error(`Get application failed: ${appResp.status} ${appResp.raw.slice(0, 300)}`);

  const existingRRA = appResp.body.requiredResourceAccess || [];
  const merged = mergeGraphPermissions(existingRRA);

  const patchResp = await httpJson(
    `https://graph.microsoft.com/v1.0/applications/${appObjectId}`,
    {
      method: 'PATCH',
      token: graphToken,
      body: { requiredResourceAccess: merged },
    }
  );
  if (!patchResp.ok) {
    throw new Error(`PATCH application failed: ${patchResp.status} ${patchResp.raw.slice(0, 400)}`);
  }

  // Step 7: Re-check status and return
  return getSpStatus();
}

function mergeGraphPermissions(existingRRA) {
  const out = existingRRA.map(r => ({
    resourceAppId: r.resourceAppId,
    resourceAccess: [...(r.resourceAccess || [])],
  }));
  let graphEntry = out.find(r => r.resourceAppId === GRAPH_APP_ID);
  if (!graphEntry) {
    graphEntry = { resourceAppId: GRAPH_APP_ID, resourceAccess: [] };
    out.push(graphEntry);
  }
  const seen = new Set(graphEntry.resourceAccess.map(a => a.id));
  for (const p of REQUIRED_GRAPH_PERMISSIONS) {
    if (!seen.has(p.id)) {
      graphEntry.resourceAccess.push({ id: p.id, type: 'Role' });
      seen.add(p.id);
    }
  }
  return out;
}

async function provisionSp() {
  if (_setupInFlight) return _setupInFlight;
  _setupInFlight = _provisionSpInner().finally(() => { _setupInFlight = null; });
  return _setupInFlight;
}

module.exports.provisionSp = provisionSp;
module.exports.mergeGraphPermissions = mergeGraphPermissions;
```

- [ ] **Step 2: Smoke-test the module loads**

```bash
node -e "const m = require('./devServer/spProvisioning'); console.log(typeof m.provisionSp, typeof m.mergeGraphPermissions)"
```

Expected: `function function`

- [ ] **Step 3: Sanity-check mergeGraphPermissions in isolation**

```bash
node -e "
const { mergeGraphPermissions, GRAPH_APP_ID } = require('./devServer/spProvisioning');
const existing = [
  { resourceAppId: 'fabric-app-id', resourceAccess: [{ id: 'x', type: 'Role' }] },
  { resourceAppId: GRAPH_APP_ID, resourceAccess: [{ id: '5b567255-7703-4780-807c-7be8301ae99b', type: 'Role' }] }
];
const out = mergeGraphPermissions(existing);
console.log(JSON.stringify(out, null, 2));
console.log('Fabric preserved:', out.some(r => r.resourceAppId === 'fabric-app-id'));
console.log('Graph entry has 5 roles:', out.find(r => r.resourceAppId === GRAPH_APP_ID).resourceAccess.length === 5);
"
```

Expected output ends with:
```
Fabric preserved: true
Graph entry has 5 roles: true
```

If either is `false`, the merge logic is broken — fix before continuing.

- [ ] **Step 4: Commit**

```bash
git add devServer/spProvisioning.js
git commit -m "feat(sp): implement provisionSp full setup flow with rollback and merge

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 9: Wire `/api/sp-setup` Endpoint

**Files:**
- Modify: `devServer/index.js`

- [ ] **Step 1: Register the endpoint**

In `devServer/index.js`, immediately after the `/api/sp-consent-url` block from Task 6, add:

```js
  app.post('/api/sp-setup', async (_req, res) => {
    try {
      const status = await spProvisioning.provisionSp();
      res.json(status);
    } catch (err) {
      console.error('[SpSetup] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
```

- [ ] **Step 2: Smoke test (read-only — does not run real provisioning)**

```bash
npm start
# in another terminal:
curl -k -X POST https://localhost:60006/api/sp-setup
```

Expected outcomes (any one is acceptable for this smoke test):
- 500 with body containing `"Bootstrap permission ... is not consented"` (means the flow ran far enough to detect bootstrap state)
- 500 with body containing `KEYVAULT_NAME` / `AZURE_SUBSCRIPTION_ID` (env not configured)
- 200 with the new status JSON (means provisioning succeeded)

A 404 or "Cannot POST /api/sp-setup" means the route is not registered correctly — fix it.

- [ ] **Step 3: Stop devServer and commit**

```bash
git add devServer/index.js
git commit -m "feat(sp): expose POST /api/sp-setup endpoint

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 10: Update .env.example Documentation

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Append SP/vault env vars**

Add to the bottom of `.env.example`:

```
##########################################################
# Service Principal Provisioning
##########################################################
# Existing Key Vault to read/write GovernlyClientSecret. If unset, defaults
# to "governly-{tenantShortId}". Created automatically by the SP setup flow
# if it does not exist (requires AZURE_SUBSCRIPTION_ID + AZURE_RESOURCE_GROUP).
KEYVAULT_NAME={{KEYVAULT_NAME}}
# Required only when the Key Vault above does not exist and should be auto-created.
AZURE_SUBSCRIPTION_ID={{AZURE_SUBSCRIPTION_ID}}
AZURE_RESOURCE_GROUP={{AZURE_RESOURCE_GROUP}}
# Region for the auto-created vault. Defaults to "westeurope".
AZURE_LOCATION={{AZURE_LOCATION}}
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs: document SP provisioning env vars in .env.example

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 11: Extend GovernlyApiClient with SP Methods + Types

**Files:**
- Modify: `app/clients/GovernlyApiClient.ts`

- [ ] **Step 1: Add types and methods**

In `app/clients/GovernlyApiClient.ts`, immediately after the existing `LabelSuggestionsResult` interface (around line 86), add:

```ts
export interface SpPermissionStatus {
  name: string;
  granted: boolean;
}

export interface SpStatus {
  bootstrapGranted: boolean;
  vaultExists: boolean;
  vaultName: string;
  secretExpiry: string | null;
  daysRemaining: number | null;
  permissions: SpPermissionStatus[];
}

export interface SpConsentUrls {
  url: string;
  bootstrapUrl: string;
}
```

Then inside the `GovernlyApiClient` class, immediately before the `// ── Data Quality ───` comment (around line 423), add:

```ts
  // ── Service Principal ────────────────────────────────────────────────────

  async getSpStatus(): Promise<SpStatus> {
    const resp = await fetch('/api/sp-status');
    if (!resp.ok) throw new Error(`getSpStatus failed (${resp.status}): ${await resp.text()}`);
    return resp.json() as Promise<SpStatus>;
  }

  async provisionSp(): Promise<SpStatus> {
    const resp = await fetch('/api/sp-setup', { method: 'POST' });
    if (!resp.ok) throw new Error(`provisionSp failed (${resp.status}): ${await resp.text()}`);
    return resp.json() as Promise<SpStatus>;
  }

  async getSpConsentUrl(): Promise<SpConsentUrls> {
    const resp = await fetch('/api/sp-consent-url');
    if (!resp.ok) throw new Error(`getSpConsentUrl failed (${resp.status}): ${await resp.text()}`);
    return resp.json() as Promise<SpConsentUrls>;
  }
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors. If errors appear, fix them.

- [ ] **Step 3: Commit**

```bash
git add app/clients/GovernlyApiClient.ts
git commit -m "feat(client): add SP status/setup/consent methods to GovernlyApiClient

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 12: Create SpProvisionModal Component

**Files:**
- Create: `app/items/GovernlyItem/components/SpProvisionModal.tsx`

This task is intentionally larger because the modal has multiple states (bootstrap-needed, healthy, in-progress, consent-needed, error) that must coexist in one component for the UX to flow.

- [ ] **Step 1: Check the components directory exists**

```bash
ls app/items/GovernlyItem/components 2>/dev/null || mkdir -p app/items/GovernlyItem/components
```

- [ ] **Step 2: Create the component**

Create `app/items/GovernlyItem/components/SpProvisionModal.tsx`:

```tsx
import React, { useState, useCallback } from 'react';
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Button, Spinner, Badge, MessageBar, MessageBarBody,
} from '@fluentui/react-components';
import {
  CheckmarkCircle24Filled, ErrorCircle24Filled, Warning24Filled,
  ShieldCheckmark24Regular, Open24Regular,
} from '@fluentui/react-icons';
import { GovernlyApiClient, SpStatus } from '../../../clients/GovernlyApiClient';

interface SpProvisionModalProps {
  open: boolean;
  apiClient: GovernlyApiClient;
  initialStatus: SpStatus | null;
  onClose: () => void;
  onStatusChange: (status: SpStatus) => void;
}

type Phase = 'idle' | 'running' | 'done' | 'error';

export const SpProvisionModal: React.FC<SpProvisionModalProps> = ({
  open, apiClient, initialStatus, onClose, onStatusChange,
}) => {
  const [status, setStatus] = useState<SpStatus | null>(initialStatus);
  const [phase, setPhase] = useState<Phase>('idle');
  const [errorMsg, setErrorMsg] = useState<string | undefined>();

  React.useEffect(() => { setStatus(initialStatus); }, [initialStatus]);

  const refreshStatus = useCallback(async () => {
    try {
      const fresh = await apiClient.getSpStatus();
      setStatus(fresh);
      onStatusChange(fresh);
    } catch (e: any) {
      setErrorMsg(e?.message ?? String(e));
    }
  }, [apiClient, onStatusChange]);

  const runSetup = useCallback(async () => {
    setPhase('running');
    setErrorMsg(undefined);
    try {
      const fresh = await apiClient.provisionSp();
      setStatus(fresh);
      onStatusChange(fresh);
      setPhase('done');
    } catch (e: any) {
      setErrorMsg(e?.message ?? String(e));
      setPhase('error');
    }
  }, [apiClient, onStatusChange]);

  const openConsent = useCallback(async () => {
    try {
      const urls = await apiClient.getSpConsentUrl();
      window.open(urls.url, '_blank', 'noopener,noreferrer');
    } catch (e: any) {
      setErrorMsg(e?.message ?? String(e));
    }
  }, [apiClient]);

  const renderBootstrap = () => (
    <>
      <MessageBar intent="warning">
        <MessageBarBody>
          One-time setup required: a Global Admin must consent to <code>Application.ReadWrite.OwnedBy</code> before
          Governly can manage its own secrets and permissions. This is a one-click consent.
        </MessageBarBody>
      </MessageBar>
      <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
        <Button appearance="primary" icon={<Open24Regular />} onClick={openConsent}>
          Open Admin Consent URL
        </Button>
        <Button onClick={refreshStatus}>Check Again</Button>
      </div>
    </>
  );

  const renderHealthy = (s: SpStatus) => {
    const ungranted = s.permissions.filter(p => !p.granted);
    return (
      <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <CheckmarkCircle24Filled style={{ color: '#107c10' }} />
          <span>
            Service Principal active. Secret expires{' '}
            <strong>{s.secretExpiry ? new Date(s.secretExpiry).toLocaleDateString() : 'unknown'}</strong>
            {s.daysRemaining != null && <> ({s.daysRemaining} days remaining)</>}.
          </span>
        </div>
        <div style={{ marginBottom: 16 }}>
          <strong>Permissions:</strong>
          <ul style={{ marginTop: 4 }}>
            {s.permissions.map(p => (
              <li key={p.name}>
                {p.granted
                  ? <Badge color="success" appearance="tint">✓</Badge>
                  : <Badge color="danger" appearance="tint">✗</Badge>}
                {' '}{p.name}
              </li>
            ))}
          </ul>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button appearance="primary" onClick={runSetup}>Renew Now</Button>
          {ungranted.length > 0 && (
            <Button icon={<Open24Regular />} onClick={openConsent}>Grant Admin Consent</Button>
          )}
        </div>
      </>
    );
  };

  const renderRunning = () => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <Spinner size="small" />
      <span>Provisioning service principal — generating secret, writing to Key Vault, declaring permissions…</span>
    </div>
  );

  const renderError = () => (
    <>
      <MessageBar intent="error">
        <MessageBarBody>
          <ErrorCircle24Filled style={{ verticalAlign: 'middle', marginRight: 6 }} />
          {errorMsg}
        </MessageBarBody>
      </MessageBar>
      <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
        <Button appearance="primary" onClick={runSetup}>Retry</Button>
        <Button onClick={refreshStatus}>Refresh Status</Button>
      </div>
    </>
  );

  const renderInitialSetup = () => (
    <>
      <MessageBar intent="info">
        <MessageBarBody>
          No active client secret found in Key Vault <code>{status?.vaultName}</code>.
          Click below to generate a 90-day secret, store it in the vault, and declare required Graph permissions.
        </MessageBarBody>
      </MessageBar>
      <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
        <Button appearance="primary" icon={<ShieldCheckmark24Regular />} onClick={runSetup}>Run Setup</Button>
      </div>
    </>
  );

  const renderBody = () => {
    if (phase === 'running') return renderRunning();
    if (phase === 'error') return renderError();
    if (!status) return <Spinner size="small" />;
    if (!status.bootstrapGranted) return renderBootstrap();
    if (status.secretExpiry == null) return renderInitialSetup();
    return renderHealthy(status);
  };

  return (
    <Dialog open={open} onOpenChange={(_, data) => !data.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Service Principal</DialogTitle>
          <DialogContent>{renderBody()}</DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
};
```

- [ ] **Step 3: Verify it compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/items/GovernlyItem/components/SpProvisionModal.tsx
git commit -m "feat(ui): add SpProvisionModal component

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 13: Create SpStatusBadge Component

**Files:**
- Create: `app/items/GovernlyItem/components/SpStatusBadge.tsx`

- [ ] **Step 1: Create the component**

```tsx
import React, { useEffect, useState, useCallback } from 'react';
import { Spinner } from '@fluentui/react-components';
import { ShieldCheckmark24Regular } from '@fluentui/react-icons';
import { GovernlyApiClient, SpStatus } from '../../../clients/GovernlyApiClient';
import { SpProvisionModal } from './SpProvisionModal';

interface SpStatusBadgeProps {
  apiClient: GovernlyApiClient;
}

type Color = 'green' | 'amber' | 'red' | 'gray';

function statusColor(s: SpStatus | null): Color {
  if (!s) return 'gray';
  if (!s.bootstrapGranted) return 'red';
  if (s.daysRemaining == null) return 'red';
  if (s.daysRemaining <= 0) return 'red';
  if (s.daysRemaining <= 14) return 'amber';
  return 'green';
}

const COLOR_HEX: Record<Color, string> = {
  green: '#107c10',
  amber: '#ca5010',
  red: '#c4314b',
  gray: '#605e5c',
};

export const SpStatusBadge: React.FC<SpStatusBadgeProps> = ({ apiClient }) => {
  const [status, setStatus] = useState<SpStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await apiClient.getSpStatus());
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [apiClient]);

  useEffect(() => { refresh(); }, [refresh]);

  const color = statusColor(status);
  const label = (() => {
    if (loading) return 'Service Principal';
    if (!status) return 'SP error';
    if (!status.bootstrapGranted) return 'SP setup required';
    if (status.daysRemaining == null) return 'SP not configured';
    if (status.daysRemaining <= 0) return 'SP expired';
    if (status.daysRemaining <= 14) return `SP expires in ${status.daysRemaining}d`;
    return 'Service Principal';
  })();

  const title = (() => {
    if (!status) return 'Click to set up the service principal';
    if (!status.bootstrapGranted) return 'A Global Admin must consent to Application.ReadWrite.OwnedBy';
    if (status.secretExpiry) return `Secret expires ${new Date(status.secretExpiry).toLocaleDateString()}`;
    return 'No client secret in Key Vault';
  })();

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={title}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '5px 14px', borderRadius: 6, border: '1px solid transparent',
          cursor: 'pointer', fontSize: 13, fontWeight: 600,
          color: '#323130', background: 'rgba(0,120,212,0.08)',
          transition: 'background 0.15s',
        }}
      >
        {loading
          ? <Spinner size="extra-tiny" />
          : <ShieldCheckmark24Regular style={{ fontSize: 16, color: '#0078d4' }} />}
        <span
          aria-label={`status: ${color}`}
          style={{
            display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
            background: COLOR_HEX[color],
          }}
        />
        {label}
      </button>
      <SpProvisionModal
        open={open}
        apiClient={apiClient}
        initialStatus={status}
        onClose={() => setOpen(false)}
        onStatusChange={(s) => setStatus(s)}
      />
    </>
  );
};
```

- [ ] **Step 2: Verify it compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/items/GovernlyItem/components/SpStatusBadge.tsx
git commit -m "feat(ui): add SpStatusBadge header component

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 14: Mount SpStatusBadge in the Header

**Files:**
- Modify: `app/items/GovernlyItem/GovernlyItemEditor.tsx`

- [ ] **Step 1: Import the component**

In `app/items/GovernlyItem/GovernlyItemEditor.tsx`, find the existing imports near the top (around lines 27–29) and add immediately after them:

```ts
import { SpStatusBadge } from './components/SpStatusBadge';
```

- [ ] **Step 2: Render the badge in the header**

Find the existing "Create Data Agent" button block in the header (around line 274 — starts with `{workspaceId && (` and ends with the closing `)}` of that conditional, around line 299). Immediately **after** that closing `)}` and **before** the next `{workspaceId && (` block (the "Open Workspace" button at line 301), insert:

```tsx
        <SpStatusBadge apiClient={apiClient} />
```

- [ ] **Step 3: Verify TypeScript and start the devServer**

```bash
npx tsc --noEmit
npm start
```

Wait for "compiled successfully", then open `https://localhost:60006` and navigate to a Governly item editor.

- [ ] **Step 4: Manual verification**

In the browser, in the Governly item editor header you should see, from left to right:
1. `Governly` title
2. `Create Data Agent` button (existing)
3. **`Service Principal` button with a colored status dot** (new)
4. `Open Workspace` button
5. `Refresh` button

Click the Service Principal button. The modal should open and show one of:
- "One-time setup required" (bootstrap pending)
- "No active client secret found" (initial setup)
- "Service Principal active" (healthy)
- An error message if `/api/sp-status` failed

Close the modal. The badge color should reflect status (green / amber / red / gray).

If any of these is broken, fix before continuing.

- [ ] **Step 5: Stop devServer and commit**

```bash
git add app/items/GovernlyItem/GovernlyItemEditor.tsx
git commit -m "feat(ui): mount SpStatusBadge in the Governly header

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 15: End-to-End Verification

This task verifies the full flow against a real tenant. Skip individual steps that don't apply to your environment.

**Files:** none (verification only)

- [ ] **Step 1: Start devServer**

```bash
npm start
```

- [ ] **Step 2: Verify status endpoint**

```bash
curl -k https://localhost:60006/api/sp-status | jq
```

Inspect the response. Note current `bootstrapGranted`, `vaultExists`, and `daysRemaining`.

- [ ] **Step 3: Verify consent URL endpoint**

```bash
curl -k https://localhost:60006/api/sp-consent-url | jq
```

Confirm both `url` and `bootstrapUrl` start with `https://login.microsoftonline.com/<tenant>/adminconsent`.

- [ ] **Step 4: Verify the badge color matches the spec**

| API daysRemaining | API bootstrapGranted | Expected badge color |
|---|---|---|
| `null` or ≤ 0 | true | red |
| any | false | red |
| 1–14 | true | amber |
| > 14 | true | green |

- [ ] **Step 5: Verify the modal flow (only run setup if you intend to actually rotate the secret)**

- Open the modal. It opens without errors.
- If bootstrap pending: clicking "Open Admin Consent URL" opens the Azure consent page in a new tab.
- If healthy: the permissions list renders with ✓/✗ badges.
- "Close" closes the modal.

- [ ] **Step 6: Stop devServer and final commit (if any cleanup)**

If everything works, no further commit needed. If you found small issues and patched them inline:

```bash
git add -A
git commit -m "fix(sp): address E2E verification findings

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Done

The SP provisioning subsystem is complete. The next subsystem (Access Management page) can now consume the Graph permissions this enabled, and will be designed in a separate spec/plan.
