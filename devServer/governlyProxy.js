/**
 * Governly API Proxy
 *
 * Proxies Fabric, Graph, and PowerBI API calls:
 * - Fabric / PowerBI: Azure CLI credentials (az account get-access-token)
 * - Graph: On-Behalf-Of (OBO) flow
 *     1. Frontend acquires a workload token via Fabric SDK (user already signed in)
 *     2. Frontend sends the token in the proxy request body (accessToken field)
 *     3. Proxy reads a client secret from Azure Key Vault (KEYVAULT_NAME in .env.dev)
 *     4. Proxy exchanges the workload token for a Graph token via OBO
 *   → No secrets in .env files, no device codes, no user interaction.
 *   → Run scripts/setup/Setup-DevKeyVault.ps1 once to provision the vault.
 *
 * Endpoint: POST /api/proxy
 * Body: { api: 'fabric'|'graph'|'powerbi', method, path, body?, accessToken? }
 */

const { execSync } = require('child_process');
const https = require('https');
const http = require('http');
const { DefaultAzureCredential } = require('@azure/identity');
const { SecretClient } = require('@azure/keyvault-secrets');

// ── Key Vault: read client secret once at first Graph call ────────────────────
// DefaultAzureCredential works in both environments with no code changes:
//   Local dev  → falls back to your existing `az login` session
//   Azure prod → uses the resource's Managed Identity automatically

let _clientSecret = null;

async function readClientSecretFromKeyVault() {
  if (_clientSecret) return _clientSecret;

  const vaultName = process.env.KEYVAULT_NAME;
  if (!vaultName) {
    throw new Error(
      'KEYVAULT_NAME is not set in .env.dev. ' +
      'Run scripts/setup/Setup-DevKeyVault.ps1 to provision the Key Vault, ' +
      'then add KEYVAULT_NAME=<vault-name> to .env.dev.'
    );
  }

  console.log(`[Proxy] Reading client secret from Key Vault "${vaultName}"...`);
  const credential = new DefaultAzureCredential();
  const client = new SecretClient(`https://${vaultName}.vault.azure.net`, credential);
  const secret = await client.getSecret('GovernlyClientSecret');

  _clientSecret = secret.value;
  console.log('[Proxy] Client secret loaded from Key Vault ✓');
  return _clientSecret;
}

/**
 * Resets the in-memory client-secret and Graph-token caches.
 * Call this after writing a new client secret to Key Vault so the next
 * Graph call re-reads the secret and re-acquires a fresh token.
 */
function invalidateClientSecretCache() {
  _clientSecret = null;
  _graphToken = null;
  console.log('[Proxy] Client secret + Graph token caches cleared.');
}

// ── Graph token via client credentials (app-only) ────────────────────────────
// Uses the client secret stored in Key Vault to get a Graph app token directly.
// No user token or OBO exchange needed — the app has InformationProtectionPolicy.Read.All.

let _graphToken = null; // { token: string, expiresAt: number } | null

async function acquireGraphTokenViaClientCredentials() {
  // Reuse cached token if still valid (with 60s buffer)
  if (_graphToken && Date.now() < _graphToken.expiresAt - 60_000) {
    return _graphToken.token;
  }

  const clientSecret = await readClientSecretFromKeyVault();
  const clientId     = process.env.FRONTEND_APPID;
  const audience     = process.env.AUDIENCE || '';
  const tenantId     = audience.split('/')[3];

  if (!clientId || !tenantId) {
    throw new Error('FRONTEND_APPID and AUDIENCE must be set in .env.dev for client credentials token.');
  }

  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     clientId,
    client_secret: clientSecret,
    scope:         'https://graph.microsoft.com/.default',
  });

  const bodyStr = body.toString();
  const response = await httpRequest(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': String(Buffer.byteLength(bodyStr)),
      },
      body: bodyStr,
    }
  );

  if (!response.ok) {
    throw new Error(`Client credentials token failed (${response.status}): ${response.body.slice(0, 400)}`);
  }

  const data = JSON.parse(response.body);
  _graphToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };

  // Decode roles from JWT payload for debugging
  try {
    const payload = JSON.parse(Buffer.from(data.access_token.split('.')[1], 'base64url').toString());
    console.log('[Proxy] Graph token roles:', payload.roles ?? '(none)');
  } catch {}

  console.log('[Proxy] Graph app token acquired via client credentials ✓');
  return _graphToken.token;
}

// ── Azure CLI token cache (Fabric / PowerBI) ──────────────────────────────────

const tokenCache = {};

function isTokenExpired(cached) {
  if (!cached) return true;
  return new Date(cached.expiresOn).getTime() - Date.now() < 5 * 60 * 1000;
}

function acquireAzToken(resource) {
  if (!isTokenExpired(tokenCache[resource])) {
    return tokenCache[resource].accessToken;
  }
  console.log(`[Proxy] Acquiring Azure CLI token for ${resource}...`);
  try {
    const out = execSync(`az account get-access-token --resource "${resource}"`, {
      encoding: 'utf8',
      timeout: 20000,
    });
    tokenCache[resource] = JSON.parse(out);
    console.log(`[Proxy] Token acquired, expires ${tokenCache[resource].expiresOn}`);
    return tokenCache[resource].accessToken;
  } catch (err) {
    throw new Error(
      `Azure CLI token acquisition failed for ${resource}. ` +
      `Make sure you are logged in: run "az login" in your terminal. ` +
      `Details: ${err.message}`
    );
  }
}

// ── Minimal HTTP client using Node built-ins ─────────────────────────────────

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const lib = isHttps ? https : http;

    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + (parsedUrl.search || ''),
      method: options.method || 'GET',
      headers: options.headers || {},
    };

    const req = lib.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          contentType: res.headers['content-type'] || 'application/json',
          body,
        });
      });
    });

    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ── API configuration ─────────────────────────────────────────────────────────

const API_BASES = {
  fabric: 'https://api.fabric.microsoft.com/v1',
  graph: 'https://graph.microsoft.com/beta',
  powerbi: 'https://api.powerbi.com/v1.0/myorg',
};

const AZ_TOKEN_RESOURCES = {
  fabric: 'https://api.fabric.microsoft.com',
  powerbi: 'https://analysis.windows.net/powerbi/api',
};

// ── Proxy route ───────────────────────────────────────────────────────────────

/**
 * Parse the "blocked until" UTC datetime from a Fabric 429 body.
 * Returns milliseconds to wait, or a default fallback.
 */
function parse429WaitMs(body, fallbackMs = 30_000) {
  try {
    const data = JSON.parse(body);
    const msg = data.message ?? '';
    // "...until: 4/18/2026 11:46:39 PM (UTC)"
    const match = msg.match(/until:\s*(.+?)\s*\(UTC\)/i);
    if (match) {
      const untilMs = Date.parse(match[1] + ' UTC');
      if (!isNaN(untilMs)) {
        const waitMs = untilMs - Date.now() + 2000; // +2s buffer
        return Math.max(0, Math.min(waitMs, 120_000)); // cap at 2 min
      }
    }
  } catch {}
  return fallbackMs;
}

/**
 * POST /api/proxy
 * Plain middleware (no Express Router) to avoid Express v4/v5 compatibility
 * issues with webpack-dev-server, which bundles its own Express v4.
 */
async function handleProxyRequest(req, res) {
  const { api, method = 'GET', path, body } = req.body ?? {};

  if (!api || !path) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'Request body must include "api" and "path".' }));
  }
  if (!API_BASES[api]) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: `Unknown api "${api}". Must be one of: fabric, graph, powerbi.` }));
  }

  try {
    let token;
    if (api === 'graph') {
      token = await acquireGraphTokenViaClientCredentials();
    } else {
      token = acquireAzToken(AZ_TOKEN_RESOURCES[api]);
    }
    const url = `${API_BASES[api]}${path}`;
    console.log(`[Proxy] → ${method} ${url}`);

    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Governly-DevProxy/1.0',
    };

    const requestBody = body !== undefined ? JSON.stringify(body) : undefined;
    if (requestBody) {
      headers['Content-Length'] = String(Buffer.byteLength(requestBody));
    }

    let result = await httpRequest(url, { method, headers, body: requestBody });

    // Auto-retry once on 429: wait until the "blocked until" time then retry
    if (result.status === 429) {
      const waitMs = parse429WaitMs(result.body);
      console.warn(`[Proxy] 429 rate-limited. Retrying in ${Math.ceil(waitMs / 1000)}s...`);
      await new Promise(r => setTimeout(r, waitMs));
      result = await httpRequest(url, { method, headers, body: requestBody });
    }

    if (!result.ok) {
      console.warn(`[Proxy] ← ${result.status} ${url}`);
      console.warn(`[Proxy] Error body: ${result.body.slice(0, 500)}`);
    } else {
      console.log(`[Proxy] ← ${result.status} ${url}`);
    }
    res.statusCode = result.status;
    res.setHeader('Content-Type', result.contentType);
    res.end(result.body);
  } catch (err) {
    console.error('[Proxy] Error:', err.message);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message }));
  }
}

/**
 * Body parser for JSON — reads and parses the raw request body.
 * Avoids dependency on any Express version's body-parser.
 */
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body !== undefined) { resolve(); return; }
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('application/json')) { resolve(); return; }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        req.body = JSON.parse(Buffer.concat(chunks).toString());
        resolve();
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

module.exports = async function governlyProxyMiddleware(req, res, next) {
  if (req.method !== 'POST' || req.url !== '/api/proxy') return next();
  try {
    await parseJsonBody(req);
    await handleProxyRequest(req, res);
  } catch (err) {
    console.error('[Proxy] Unhandled error:', err.message);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message }));
  }
};

/** Expose Fabric token acquisition for use by other route registrations. */
module.exports.acquireFabricToken = () => acquireAzToken(AZ_TOKEN_RESOURCES.fabric);
module.exports.acquireGraphTokenViaClientCredentials = acquireGraphTokenViaClientCredentials;
module.exports.invalidateClientSecretCache = invalidateClientSecretCache;
