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
  acquireAzToken,
  invalidateClientSecretCache,
} = require('./governlyProxy');
const https = require('https');

// ── Constants ───────────────────────────────────────────────────────────────

const REQUIRED_GRAPH_PERMISSIONS = [
  { name: 'Group.Read.All',                  id: '5b567255-7703-4780-807c-7be8301ae99b' },
  { name: 'GroupMember.ReadWrite.All',       id: 'dbaae8cf-10b5-4b86-a4a1-f871c94c6695', cliCovered: true },
  { name: 'AuditLog.Read.All',               id: 'b0afded3-3588-46d8-8b3d-9842eff778da' },
  { name: 'AuditLogsQuery.Read.All',         id: '5e1e9171-754d-478c-812c-f1755a9a4c2d' },
  { name: 'SecurityEvents.Read.All',         id: 'bf394140-e372-4bf9-a898-299cfc7564e5' },
  { name: 'Directory.Read.All',              id: '7ab1d382-f21e-4acd-a863-ba3e13f7da61' },
  { name: 'User.Read.All',                   id: 'df021288-bdef-4463-88db-98f22de89214' },
];

// Office 365 Management APIs (manage.office.com) — separate resource from Graph
const M365_MGMT_APP_ID = 'c5393580-f805-4401-95e8-94b7a6ef2fc4';
const REQUIRED_M365_PERMISSIONS = [];

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

/** Minimal HTTPS request helper returning { ok, status, body, raw }. */
function httpJson(url, { method = 'GET', token, body, timeoutMs = 30_000 } = {}) {
  if (!token) throw new Error(`httpJson: token is required (called for ${method} ${url})`);
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + (u.search || ''),
      method,
      timeout: timeoutMs,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(data)) } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch (e) {
          console.warn(`[httpJson] JSON parse failed for ${method} ${url}:`, e.message);
        }
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          body: parsed,
          raw,
        });
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error(`httpJson timed out after ${timeoutMs}ms: ${method} ${url}`));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// In-process mutex so two simultaneous /api/sp-setup requests serialize.
let _setupInFlight = null;

let _appObjectIdCache = null;
let _ourSpObjectIdCache = null;
let _graphSpObjectIdCache = null;
let _m365SpObjectIdCache = null;
let _credential = null;

function getCredential() {
  if (!_credential) _credential = new DefaultAzureCredential();
  return _credential;
}

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

async function resolveM365ServicePrincipalId(graphToken) {
  if (_m365SpObjectIdCache) return _m365SpObjectIdCache;
  const url = `https://graph.microsoft.com/v1.0/servicePrincipals?$filter=appId eq '${M365_MGMT_APP_ID}'&$select=id`;
  const resp = await httpJson(url, { token: graphToken });
  if (!resp.ok) throw new Error(`Failed to resolve M365 Management APIs SP: ${resp.status} ${resp.raw.slice(0, 300)}`);
  const id = resp.body?.value?.[0]?.id;
  if (!id) {
    // SP doesn't exist in this tenant yet — it's created automatically by Azure AD
    // when a Global Admin performs admin consent for an app with ActivityFeed.Read.
    throw new Error('Office 365 Management APIs SP not found in this tenant. A Global Admin must consent via the Consent URL in the SP modal.');
  }
  _m365SpObjectIdCache = id;
  return id;
}

async function resolveOurServicePrincipalId(graphToken) {
  if (_ourSpObjectIdCache) return _ourSpObjectIdCache;
  const clientId = getClientId();
  const url = `https://graph.microsoft.com/v1.0/servicePrincipals?$filter=appId eq '${clientId}'&$select=id`;
  const resp = await httpJson(url, { token: graphToken });
  if (!resp.ok) throw new Error(`Failed to resolve our SP: ${resp.status} ${resp.raw.slice(0, 300)}`);
  const id = resp.body?.value?.[0]?.id || null;
  if (id) _ourSpObjectIdCache = id;
  return id;
}

// ── Status check ────────────────────────────────────────────────────────────

async function readVaultSecret(vaultName) {
  try {
    const client = new SecretClient(`https://${vaultName}.vault.azure.net`, getCredential());
    const secret = await client.getSecret(SECRET_NAME);
    return {
      vaultExists: true,
      expiresOn: secret.properties.expiresOn ? secret.properties.expiresOn.toISOString() : null,
      keyId: secret.properties.tags?.keyId || null,
    };
  } catch (err) {
    if (err.code === 'VaultNotFound' || /vault.*not found/i.test(err.message || '')) {
      return { vaultExists: false, expiresOn: null, keyId: null };
    }
    if (err.code === 'SecretNotFound' || err.statusCode === 404) {
      return { vaultExists: true, expiresOn: null, keyId: null };
    }
    throw err;
  }
}

/**
 * Lists all appRoleAssignments for our SP, returning separate Sets for Graph and M365 grants.
 */
async function listGrantedRoleIds(graphToken) {
  const ourSpId = await resolveOurServicePrincipalId(graphToken);
  console.log(`[SpStatus] Our SP object ID: ${ourSpId || '(not found)'}`);
  if (!ourSpId) return { graphGranted: new Set(), m365Granted: new Set(), ourSpId: null };

  const [graphSpId, m365SpId] = await Promise.all([
    resolveGraphServicePrincipalId(graphToken),
    resolveM365ServicePrincipalId(graphToken).catch(() => null),
  ]);
  console.log(`[SpStatus] Graph SP object ID: ${graphSpId}`);
  if (m365SpId) console.log(`[SpStatus] M365 Management APIs SP object ID: ${m365SpId}`);

  const url = `https://graph.microsoft.com/v1.0/servicePrincipals/${ourSpId}/appRoleAssignments?$top=999`;
  const resp = await httpJson(url, { token: graphToken });
  if (!resp.ok) throw new Error(`Failed to list app role assignments: ${resp.status} ${resp.raw.slice(0, 300)}`);

  const graphGranted = new Set();
  const m365Granted  = new Set();
  for (const a of resp.body?.value ?? []) {
    if (a.resourceId === graphSpId) graphGranted.add(a.appRoleId);
    if (m365SpId && a.resourceId === m365SpId) m365Granted.add(a.appRoleId);
  }
  console.log(`[SpStatus] Granted Graph role IDs (${graphGranted.size}):`, [...graphGranted]);
  console.log(`[SpStatus] Granted M365 role IDs (${m365Granted.size}):`, [...m365Granted]);
  return { graphGranted, m365Granted, ourSpId };
}

/** @deprecated — kept for internal callers that only need Graph grants */
async function listGrantedGraphRoleIds(graphToken) {
  const { graphGranted } = await listGrantedRoleIds(graphToken);
  return graphGranted;
}

async function getSpStatus() {
  // Always use the Azure CLI (delegated) token for the SP/role-assignment check.
  // The app's client credentials token only has whatever permissions have already
  // been consented (e.g. InformationProtectionPolicy.Read.All) — during bootstrap
  // it does NOT yet have Directory.Read.All, so querying servicePrincipals returns 403.
  // The signed-in CLI user (Global Admin) always has the necessary read access.
  const cliGraphToken = acquireAzToken('https://graph.microsoft.com');
  const vaultName = getVaultName();

  // Clear SP caches so a freshly-created SP (post-consent) is always re-fetched.
  _ourSpObjectIdCache = null;
  _graphSpObjectIdCache = null;
  _m365SpObjectIdCache = null;

  const [vaultInfo, roleIds] = await Promise.all([
    readVaultSecret(vaultName),
    listGrantedRoleIds(cliGraphToken).catch((err) => {
      console.error('[SpStatus] Failed to list granted roles; returning empty sets:', err.message);
      return { graphGranted: new Set(), m365Granted: new Set(), ourSpId: null };
    }),
  ]);

  const { graphGranted, m365Granted } = roleIds;
  const bootstrapGranted = graphGranted.has(BOOTSTRAP_PERMISSION.id);
  console.log(`[SpStatus] Bootstrap permission ID: ${BOOTSTRAP_PERMISSION.id}, granted: ${bootstrapGranted}`);

  const permissions = [
    ...REQUIRED_GRAPH_PERMISSIONS.map(p => ({
      name: p.name,
      api: 'Microsoft Graph',
      granted: graphGranted.has(p.id),
      cliCovered: p.cliCovered ?? false,
    })),
    ...REQUIRED_M365_PERMISSIONS.map(p => ({
      name: p.name,
      api: 'Office 365 Management APIs',
      granted: m365Granted.has(p.id),
      cliCovered: false,
    })),
  ];

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
    objectId: bootstrapGranted ? await resolveOurServicePrincipalId(acquireAzToken('https://graph.microsoft.com')).catch(() => null) : null,
  };
}

// ── Consent URL ─────────────────────────────────────────────────────────────

/**
 * Ensures Application.ReadWrite.OwnedBy is declared in requiredResourceAccess
 * (using the delegated Azure CLI token of the currently signed-in user) so that
 * the admin consent page actually includes it when the admin visits the URL.
 */
async function getConsentUrl() {
  const tenantId = getTenantId();
  const clientId = getClientId();

  try {
    const graphToken = acquireAzToken('https://graph.microsoft.com');
    const appObjectId = await resolveAppObjectId(graphToken);

    const appResp = await httpJson(
      `https://graph.microsoft.com/v1.0/applications/${appObjectId}?$select=requiredResourceAccess`,
      { token: graphToken }
    );

    if (appResp.ok) {
      const existingRRA = appResp.body.requiredResourceAccess || [];
      const merged = mergeGraphPermissions(existingRRA);

      const patchResp = await httpJson(
        `https://graph.microsoft.com/v1.0/applications/${appObjectId}`,
        { method: 'PATCH', token: graphToken, body: { requiredResourceAccess: merged } }
      );
      if (patchResp.ok) {
        console.log('[SP] All required permissions declared in requiredResourceAccess.');
      } else {
        console.warn('[SP] PATCH to declare permissions failed:', patchResp.status, patchResp.raw.slice(0, 300));
      }
    } else {
      console.warn('[SP] Could not read app requiredResourceAccess:', appResp.status, appResp.raw.slice(0, 300));
    }
  } catch (e) {
    console.warn('[SP] Could not auto-declare permissions (continuing anyway):', e.message);
  }

  const url = `https://login.microsoftonline.com/${tenantId}/adminconsent?client_id=${clientId}`;
  return { url, bootstrapUrl: url };
}

// ── Grant missing permissions directly (no consent URL needed) ──────────────

/**
 * Directly grants all missing required Graph application permissions via appRoleAssignments.
 * This is equivalent to clicking "Grant admin consent" in the Azure Portal.
 * Requires the signed-in CLI user to be a Global Admin.
 */
async function grantMissingPermissions() {
  const graphToken = acquireAzToken('https://graph.microsoft.com');
  const ourSpId = await resolveOurServicePrincipalId(graphToken);
  if (!ourSpId) throw new Error('Service principal not found — run Setup first.');

  const { graphGranted, m365Granted } = await listGrantedRoleIds(graphToken);
  const graphSpId = await resolveGraphServicePrincipalId(graphToken);
  const m365SpId  = await resolveM365ServicePrincipalId(graphToken).catch(() => null);

  // Grant missing Graph permissions
  const missingGraph = [BOOTSTRAP_PERMISSION, ...REQUIRED_GRAPH_PERMISSIONS].filter(p => !graphGranted.has(p.id));
  console.log(`[GrantPermissions] ${missingGraph.length} missing Graph permissions:`, missingGraph.map(p => p.name));
  for (const p of missingGraph) {
    const resp = await httpJson(
      `https://graph.microsoft.com/v1.0/servicePrincipals/${ourSpId}/appRoleAssignments`,
      { method: 'POST', token: graphToken, body: { principalId: ourSpId, resourceId: graphSpId, appRoleId: p.id } }
    );
    if (resp.ok) console.log(`[GrantPermissions] Granted Graph: ${p.name}`);
    else if (resp.status === 409) console.log(`[GrantPermissions] Already granted: ${p.name}`);
    else console.warn(`[GrantPermissions] Failed to grant ${p.name}: ${resp.status} ${resp.raw.slice(0, 200)}`);
  }

  // Grant missing M365 Management APIs permissions
  if (m365SpId) {
    const missingM365 = REQUIRED_M365_PERMISSIONS.filter(p => !m365Granted.has(p.id));
    console.log(`[GrantPermissions] ${missingM365.length} missing M365 permissions:`, missingM365.map(p => p.name));
    for (const p of missingM365) {
      const resp = await httpJson(
        `https://graph.microsoft.com/v1.0/servicePrincipals/${ourSpId}/appRoleAssignments`,
        { method: 'POST', token: graphToken, body: { principalId: ourSpId, resourceId: m365SpId, appRoleId: p.id } }
      );
      if (resp.ok) console.log(`[GrantPermissions] Granted M365: ${p.name}`);
      else if (resp.status === 409) console.log(`[GrantPermissions] Already granted: ${p.name}`);
      else console.warn(`[GrantPermissions] Failed to grant M365 ${p.name}: ${resp.status} ${resp.raw.slice(0, 200)}`);
    }
  } else {
    console.warn('[GrantPermissions] Could not resolve M365 Management APIs SP — skipping ActivityFeed.Read grant');
  }

  // Also update the app manifest so permissions appear in Azure Portal
  try {
    const appObjectId = await resolveAppObjectId(graphToken);
    const appResp = await httpJson(
      `https://graph.microsoft.com/v1.0/applications/${appObjectId}?$select=requiredResourceAccess`,
      { token: graphToken }
    );
    if (appResp.ok) {
      const merged = mergeGraphPermissions(appResp.body.requiredResourceAccess || []);
      await httpJson(`https://graph.microsoft.com/v1.0/applications/${appObjectId}`, {
        method: 'PATCH', token: graphToken, body: { requiredResourceAccess: merged },
      });
    }
  } catch (e) {
    console.warn('[GrantPermissions] Could not update app manifest (non-fatal):', e.message);
  }

  return getSpStatus();
}

// ── Key Vault ensure (create if missing) ───────────────────────────────────

async function ensureVault(vaultName) {
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
  const kvMgmt = new KeyVaultManagementClient(getCredential(), subscriptionId);

  const location = process.env.AZURE_LOCATION || 'westeurope';
  if (!process.env.AZURE_LOCATION) {
    console.warn(`[SP] AZURE_LOCATION not set; defaulting to "westeurope". Set it in .env.dev to override.`);
  }

  console.log(`[SP] Creating Key Vault "${vaultName}" in ${resourceGroup}...`);
  let vault;
  try {
    vault = await kvMgmt.vaults.beginCreateOrUpdateAndWait(resourceGroup, vaultName, {
      location,
      properties: {
        tenantId,
        sku: { family: 'A', name: 'standard' },
        enableRbacAuthorization: true,
        accessPolicies: [],
      },
    });
  } catch (err) {
    if (err.statusCode === 409 || err.code === 'ConflictError') {
      throw new Error(
        `Key Vault "${vaultName}" exists in soft-deleted state. ` +
        `Run: az keyvault recover --name ${vaultName}  (to recover it)  OR  ` +
        `az keyvault purge --name ${vaultName}  (to permanently delete it so it can be recreated).`
      );
    }
    throw err;
  }
  if (!process.env.KEYVAULT_NAME) {
    console.log(`[SP] Add KEYVAULT_NAME=${vaultName} to .env.dev to enable the proxy.`);
  }
  console.log(
    `[SP] Vault "${vaultName}" created. URI: ${vault?.properties?.vaultUri}. ` +
    `NOTE: an RBAC role (Key Vault Secrets Officer) must be assigned to your ` +
    `signed-in identity / app SP before secrets can be written.`
  );
  return { vaultName, created: true };
}

// ── Setup flow ─────────────────────────────────────────────────────────────

async function _provisionSpInner() {
  // Use the Azure CLI delegated token (Global Admin) for all provisioning Graph calls.
  // This avoids the Application.ReadWrite.OwnedBy ownership requirement — the CLI user
  // is a Global Admin and has full rights on the app registration regardless.
  const graphToken = acquireAzToken('https://graph.microsoft.com');
  const vaultName = getVaultName();

  // Step 0: Bootstrap check (still validate before proceeding)
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
  const newSecretText = addPwResp.body?.secretText;
  const newKeyId = addPwResp.body?.keyId;
  if (!newSecretText || !newKeyId) {
    throw new Error('addPassword returned no secretText / keyId.');
  }

  // Step 4: Write to Key Vault. On failure, roll back the new credential.
  try {
    const client = new SecretClient(`https://${vaultName}.vault.azure.net`, getCredential());
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

function mergeAllPermissions(existingRRA) {
  const out = existingRRA.map(r => ({
    resourceAppId: r.resourceAppId,
    resourceAccess: [...(r.resourceAccess || [])],
  }));

  // Merge Graph permissions
  let graphEntry = out.find(r => r.resourceAppId === GRAPH_APP_ID);
  if (!graphEntry) {
    graphEntry = { resourceAppId: GRAPH_APP_ID, resourceAccess: [] };
    out.push(graphEntry);
  }
  const graphSeen = new Set(graphEntry.resourceAccess.map(a => a.id));
  for (const p of [BOOTSTRAP_PERMISSION, ...REQUIRED_GRAPH_PERMISSIONS]) {
    if (!graphSeen.has(p.id)) {
      graphEntry.resourceAccess.push({ id: p.id, type: 'Role' });
      graphSeen.add(p.id);
    }
  }

  // Merge M365 Management APIs permissions
  let m365Entry = out.find(r => r.resourceAppId === M365_MGMT_APP_ID);
  if (!m365Entry) {
    m365Entry = { resourceAppId: M365_MGMT_APP_ID, resourceAccess: [] };
    out.push(m365Entry);
  }
  const m365Seen = new Set(m365Entry.resourceAccess.map(a => a.id));
  for (const p of REQUIRED_M365_PERMISSIONS) {
    if (!m365Seen.has(p.id)) {
      m365Entry.resourceAccess.push({ id: p.id, type: 'Role' });
      m365Seen.add(p.id);
    }
  }

  return out;
}

/** @deprecated — use mergeAllPermissions */
function mergeGraphPermissions(existingRRA) {
  return mergeAllPermissions(existingRRA);
}

async function provisionSp() {
  if (_setupInFlight) return _setupInFlight;
  _setupInFlight = _provisionSpInner().finally(() => { _setupInFlight = null; });
  return _setupInFlight;
}

/**
 * Add the Governly service principal to the Purview "Audit Logs" role group
 * via Exchange Online PowerShell so app-only audit log queries work.
 *
 * Requires: ExchangeOnlineManagement PowerShell module (auto-installs if missing).
 * The signed-in user must have Exchange Online admin rights (Global Admin qualifies).
 */
async function addSpToPurviewAuditRole() {
  const { spawn } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  const spId = await resolveOurServicePrincipalId(acquireAzToken('https://graph.microsoft.com'));

  // There is no Graph API for Purview compliance role groups — only Exchange Online PowerShell works.
  // Connect-IPPSSession targets the Security & Compliance endpoint (where "Audit Logs" role group lives).
  // We open a visible pwsh window so the interactive browser auth works; we return immediately.
  const ps = `
$ErrorActionPreference = 'Stop'
Write-Host "=== Governly: Adding SP to Purview Audit Logs role group ===" -ForegroundColor Cyan
Write-Host "SP Object ID: ${spId}" -ForegroundColor Gray

if (-not (Get-Module ExchangeOnlineManagement -ListAvailable)) {
  Write-Host "Installing ExchangeOnlineManagement module..." -ForegroundColor Yellow
  Install-Module ExchangeOnlineManagement -Force -Scope CurrentUser -AllowClobber
}
Import-Module ExchangeOnlineManagement -Force

Write-Host "Connecting to Security & Compliance PowerShell (a browser sign-in will open)..." -ForegroundColor Yellow
Connect-IPPSSession -ShowBanner:$false

Write-Host "Adding SP to 'Audit Logs' role group..." -ForegroundColor Yellow
try {
  Add-RoleGroupMember -Identity "Audit Logs" -Member "${spId}"
  Write-Host "SUCCESS: SP added to Audit Logs role group." -ForegroundColor Green
} catch {
  Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
}

Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "Done. You can close this window." -ForegroundColor Cyan
Read-Host "Press Enter to close"
`;

  const scriptPath = path.join(os.tmpdir(), `governly-purview-${Date.now()}.ps1`);
  fs.writeFileSync(scriptPath, ps, 'utf8');

  // Open in a new visible terminal window — interactive auth needs a real UI.
  // The API returns immediately; the user completes sign-in in the opened window.
  spawn('cmd.exe', ['/c', 'start', 'pwsh.exe', '-NoProfile', '-File', scriptPath], {
    detached: true,
    stdio: 'ignore',
  }).unref();

  return { success: true, spId, output: 'A PowerShell window has been opened. Sign in with an Exchange Online admin account to complete the role assignment.' };
}

module.exports = {
  REQUIRED_GRAPH_PERMISSIONS,
  REQUIRED_M365_PERMISSIONS,
  BOOTSTRAP_PERMISSION,
  GRAPH_APP_ID,
  M365_MGMT_APP_ID,
  SECRET_NAME,
  SECRET_LIFETIME_DAYS,
  getTenantId,
  getClientId,
  getVaultName,
  httpJson,
  resolveAppObjectId,
  resolveGraphServicePrincipalId,
  resolveM365ServicePrincipalId,
  resolveOurServicePrincipalId,
  invalidateClientSecretCache,
  readVaultSecret,
  listGrantedGraphRoleIds,
  listGrantedRoleIds,
  getSpStatus,
  getConsentUrl,
  ensureVault,
  mergeGraphPermissions,
  mergeAllPermissions,
  grantMissingPermissions,
  provisionSp,
  addSpToPurviewAuditRole,
};
