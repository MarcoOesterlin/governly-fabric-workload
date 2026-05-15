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
        try { parsed = raw ? JSON.parse(raw) : null; } catch {}
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
 * Returns an empty Set if our SP doesn't exist yet (which means nothing is consented).
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
  readVaultSecret,
  listGrantedGraphRoleIds,
  getSpStatus,
};
