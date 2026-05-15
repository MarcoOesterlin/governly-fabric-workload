// devServer/oversharingReport.js
'use strict';

const https = require('https');
const { acquireFabricToken } = require('./governlyProxy');

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

async function getItemUsers(workspaceId, itemId) {
  const token = acquireFabricToken();
  const url = `${FABRIC_BASE}/workspaces/${encodeURIComponent(workspaceId)}/items/${encodeURIComponent(itemId)}/users`;
  const result = await jsonRequest(url, { token });
  if (!result.ok) {
    if (result.status === 404 || result.status === 403) return [];
    console.warn(`[Oversharing] getItemUsers(${itemId}) failed (${result.status})`);
    return [];
  }
  return result.data.value ?? [];
}

async function buildGrantorMap(workspaceId) {
  try {
    const purviewLogs = require('./purviewLogs');
    const report = await purviewLogs.queryFabricActivity(workspaceId, 90);
    const map = new Map();
    for (const record of report.records ?? []) {
      if (!record.operationName || !record.operationName.toLowerCase().includes('share')) continue;
      const itemId = record.itemId;
      const userId = record.userId;
      if (!itemId || !userId) continue;
      if (!map.has(itemId)) map.set(itemId, new Map());
      const inner = map.get(itemId);
      if (!inner.has(userId)) {
        inner.set(userId, { grantedBy: record.userKey ?? record.userPrincipalName ?? null, grantedAt: record.creationTime ?? null });
      }
    }
    return map;
  } catch (err) {
    console.warn('[Oversharing] buildGrantorMap failed, grantor info will be null:', err.message);
    return new Map();
  }
}

function computeFlags(users, item) {
  const hasDirectGrants = users.length > 0;
  const hasExternalUsers = users.some(u =>
    u.principalType === 'ExternalMember' ||
    u.principalType === 'Guest' ||
    (typeof u.identifier === 'string' && u.identifier.includes('#EXT#'))
  );
  const unlabeledWithGrants = hasDirectGrants && !item.sensitivity?.labelId;
  const highAccessCount = users.length > HIGH_ACCESS_THRESHOLD;
  return { hasDirectGrants, hasExternalUsers, unlabeledWithGrants, highAccessCount };
}

async function processItem(raw, workspaceId, grantorMap) {
  try {
    const users = await getItemUsers(workspaceId, raw.id);
    const itemGrantors = grantorMap.get(raw.id) ?? new Map();
    const flags = computeFlags(users, raw);

    const mappedUsers = users.map(u => {
      const grantor = itemGrantors.get(u.identifier) ?? {};
      const isExternal =
        u.principalType === 'ExternalMember' ||
        u.principalType === 'Guest' ||
        (typeof u.identifier === 'string' && u.identifier.includes('#EXT#'));
      const rights = u.itemAccessDetails?.accessDetails?.map(a => a.accessRight) ?? [];
      return {
        identifier: u.identifier,
        displayName: u.displayName ?? u.identifier,
        principalType: u.principalType,
        accessRights: rights,
        isExternal,
        grantedBy: grantor.grantedBy ?? null,
        grantedAt: grantor.grantedAt ?? null,
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
  const [rawItems, grantorMap] = await Promise.all([
    getAllItems(workspaceId),
    buildGrantorMap(workspaceId),
  ]);

  const BATCH_SIZE = 20;
  const items = [];
  for (let i = 0; i < rawItems.length; i += BATCH_SIZE) {
    const batch = rawItems.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(raw => processItem(raw, workspaceId, grantorMap)));
    items.push(...results);
  }

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
