// devServer/oversharingReport.js
'use strict';

const https = require('https');
const { acquireFabricToken, acquirePowerBIToken } = require('./governlyProxy');

const FABRIC_BASE = 'https://api.fabric.microsoft.com/v1';
const HIGH_ACCESS_THRESHOLD = 10;

async function jsonRequest(url, { method = 'GET', token, body } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    if (bodyStr) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
    }
    const req = https.request({
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + (parsed.search || ''),
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let data;
        try { data = JSON.parse(text); } catch { data = text; }
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data });
      });
      res.on('error', reject);
    });
    req.setTimeout(30_000, () => req.destroy(new Error(`Timeout: ${url}`)));
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function getAllItems(workspaceId) {
  const token = acquireFabricToken();
  let url = `${FABRIC_BASE}/workspaces/${encodeURIComponent(workspaceId)}/items`;
  const items = [];
  while (url) {
    const result = await jsonRequest(url, { token });
    if (!result.ok) throw new Error(`Fabric items failed (${result.status}) for workspace ${workspaceId}`);
    items.push(...(result.data.value ?? []));
    url = result.data['continuationToken']
      ? `${FABRIC_BASE}/workspaces/${encodeURIComponent(workspaceId)}/items?continuationToken=${encodeURIComponent(result.data.continuationToken)}`
      : null;
  }
  return items;
}

const POWERBI_BASE = 'https://api.powerbi.com/v1.0/myorg';
const POWERBI_TYPES = new Set(['SemanticModel', 'Report', 'Dashboard', 'PaginatedReport']);

async function getItemUsers(workspaceId, itemId, itemType) {
  if (POWERBI_TYPES.has(itemType)) {
    return getDatasetUsers(workspaceId, itemId, itemType);
  }

  const token = acquireFabricToken();
  const url = `${FABRIC_BASE}/workspaces/${encodeURIComponent(workspaceId)}/items/${encodeURIComponent(itemId)}/users`;
  const result = await jsonRequest(url, { token });
  if (!result.ok) {
    if (result.status === 404 || result.status === 403) {
      console.warn(`[Oversharing] getItemUsers(${itemId}, type=${itemType}) → ${result.status}`);
      return [];
    }
    console.warn(`[Oversharing] getItemUsers(${itemId}, type=${itemType}) failed (${result.status}):`, JSON.stringify(result.data).slice(0, 200));
    return [];
  }
  const users = result.data.value ?? [];
  if (users.length > 0) {
    console.log(`[Oversharing] getItemUsers(${itemId}, type=${itemType}) → ${users.length} user(s)`);
  }
  return users;
}

async function getDatasetUsers(workspaceId, itemId, itemType) {
  try {
    const token = acquirePowerBIToken();
    const url = `${POWERBI_BASE}/groups/${encodeURIComponent(workspaceId)}/datasets/${encodeURIComponent(itemId)}/users`;
    const result = await jsonRequest(url, { token });
    if (!result.ok) {
      console.warn(`[Oversharing] getDatasetUsers(${itemId}, type=${itemType}) → ${result.status}:`, JSON.stringify(result.data).slice(0, 200));
      return [];
    }
    const rawUsers = result.data.value ?? [];
    console.log(`[Oversharing] getDatasetUsers(${itemId}, type=${itemType}) → ${rawUsers.length} user(s)`);
    if (rawUsers.length > 0) {
      console.log(`[Oversharing] SemanticModel users raw:`, JSON.stringify(rawUsers, null, 2));
    }
    // Map Power BI response shape to the Fabric items user shape
    return rawUsers.map(u => ({
      identifier:        u.identifier ?? u.emailAddress,
      displayName:       u.displayName ?? u.identifier,
      principalType:     u.principalType,
      emailAddress:      u.emailAddress ?? u.identifier,
      itemAccessDetails: {
        accessDetails: [{ accessRight: u.datasetUserAccessRight ?? 'Read' }],
      },
    }));
  } catch (err) {
    console.warn(`[Oversharing] getDatasetUsers(${itemId}) error:`, err.message);
    return [];
  }
}

async function buildGrantorMap(workspaceId) {
  try {
    const purviewLogs = require('./purviewLogs');
    const report = await purviewLogs.queryGraphAllWorkspaceActivity(workspaceId, 90);
    const map = new Map();
    for (const record of report.entries ?? []) {
      if (!record.operationName || !record.operationName.toLowerCase().includes('share')) continue;
      const itemId = record.itemId;
      const userId = record.userId;
      if (!itemId || !userId) continue;
      if (!map.has(itemId)) map.set(itemId, new Map());
      const inner = map.get(itemId);
      if (!inner.has(userId)) {
        inner.set(userId, { grantedBy: record.userPrincipalName ?? null, grantedAt: record.createdDateTime ?? null });
      }
    }
    return map;
  } catch (err) {
    console.warn('[Oversharing] buildGrantorMap failed, grantor info will be null:', err.message);
    return new Map();
  }
}

function isExternalIdentifier(u) {
  if (u.principalType === 'ExternalMember' || u.principalType === 'Guest') return true;
  const id = u.identifier ?? '';
  if (id.includes('#EXT#')) return true;
  const email = u.emailAddress ?? '';
  if (email && email.includes('#EXT#')) return true;
  return false;
}

function isExternalDomain(u) {
  // True only for B2B guests from outside the tenant
  if (u.principalType === 'Guest') return true;
  const id = u.identifier ?? '';
  const email = u.emailAddress ?? '';
  if (id.includes('#EXT#') || email.includes('#EXT#')) return true;
  return false;
}

function computeFlags(users, item) {
  const hasDirectGrants = users.length > 0;
  const hasExternalUsers = users.some(isExternalIdentifier);
  const unlabeledWithGrants = hasDirectGrants && !item.sensitivity?.labelId;
  const highAccessCount = users.length > HIGH_ACCESS_THRESHOLD;
  return { hasDirectGrants, hasExternalUsers, unlabeledWithGrants, highAccessCount };
}

async function processItem(raw, workspaceId, grantorMap) {
  try {
    const users = await getItemUsers(workspaceId, raw.id, raw.type);
    const itemGrantors = grantorMap.get(raw.id) ?? new Map();
    const flags = computeFlags(users, raw);

    const mappedUsers = users.map(u => {
      const grantor = itemGrantors.get(u.identifier) ?? {};
      const isExternal = isExternalIdentifier(u);
      const rights = u.itemAccessDetails?.accessDetails?.map(a => a.accessRight) ?? [];
      return {
        identifier:       u.identifier,
        displayName:      u.displayName ?? u.identifier,
        email:            u.emailAddress ?? null,
        principalType:    u.principalType,
        accessRights:     rights,
        isExternal,
        isExternalDomain: isExternal && isExternalDomain(u),
        grantedBy:  grantor.grantedBy ?? null,
        grantedAt:  grantor.grantedAt ?? null,
      };
    });

    return {
      id: raw.id,
      displayName: raw.displayName,
      type: raw.type,
      labelId: raw.sensitivity?.labelId ?? null,
      labelName: raw.sensitivity?.labelName ?? null,
      users: mappedUsers,
      flags,
    };
  } catch (err) {
    console.warn(`[Oversharing] Failed to process item ${raw.id}:`, err.message);
    return {
      id: raw.id,
      displayName: raw.displayName,
      type: raw.type,
      labelId: null,
      labelName: null,
      users: [],
      flags: { hasDirectGrants: false, hasExternalUsers: false, unlabeledWithGrants: false, highAccessCount: false },
    };
  }
}

async function buildOversharingReport(workspaceId) {
  const grantorTimeout = new Promise(resolve =>
    setTimeout(() => resolve(new Map()), 8_000)
  );

  const [rawItems, grantorMap] = await Promise.all([
    getAllItems(workspaceId),
    Promise.race([buildGrantorMap(workspaceId), grantorTimeout]),
  ]);

  const items = await Promise.all(rawItems.map(raw => processItem(raw, workspaceId, grantorMap)));

  return { items, generatedAt: new Date().toISOString() };
}

async function revokeItemUser(workspaceId, itemId, userIdentifier) {
  const token = acquireFabricToken();
  const url = `${FABRIC_BASE}/workspaces/${encodeURIComponent(workspaceId)}/items/${encodeURIComponent(itemId)}/users/${encodeURIComponent(userIdentifier)}`;
  const result = await jsonRequest(url, { method: 'DELETE', token });
  if (!result.ok) {
    throw new Error(`revokeItemUser failed (${result.status}): ${JSON.stringify(result.data).slice(0, 300)}`);
  }
}

module.exports = { buildOversharingReport, revokeItemUser };
