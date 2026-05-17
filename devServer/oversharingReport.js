// devServer/oversharingReport.js
'use strict';

const https = require('https');
const { acquireFabricToken, acquirePowerBIToken, acquireGraphTokenViaClientCredentials } = require('./governlyProxy');

const FABRIC_BASE = 'https://api.fabric.microsoft.com/v1';
const GRAPH_BASE  = 'https://graph.microsoft.com/v1.0';
const HIGH_ACCESS_THRESHOLD = 10;

// Gate verbose diagnostic logs behind DEBUG_OVERSHARING=1.
// Errors/warnings still log unconditionally via console.warn/error.
const DEBUG = process.env.DEBUG_OVERSHARING === '1' || process.env.DEBUG_OVERSHARING === 'true';
const debug = (...args) => { if (DEBUG) debug(...args); };

// Bounded cache for group display names.
// Simple Map + insertion-order eviction at MAX entries to prevent unbounded growth
// in long-running dev servers / enterprise tenants with many groups.
const GROUP_CACHE_MAX = 1000;
const _groupNameCache = new Map();
function cacheGroupName(id, name) {
  if (_groupNameCache.size >= GROUP_CACHE_MAX) {
    const oldest = _groupNameCache.keys().next().value;
    if (oldest !== undefined) _groupNameCache.delete(oldest);
  }
  _groupNameCache.set(id, name);
}

async function resolveGroupDisplayName(groupId) {
  if (_groupNameCache.has(groupId)) return _groupNameCache.get(groupId);
  try {
    const token = await acquireGraphTokenViaClientCredentials();
    const result = await jsonRequest(`${GRAPH_BASE}/groups/${encodeURIComponent(groupId)}?$select=displayName`, { token });
    const name = result.ok ? (result.data.displayName ?? null) : null;
    cacheGroupName(groupId, name);
    return name;
  } catch {
    cacheGroupName(groupId, null);
    return null;
  }
}

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
    for (const item of result.data.value ?? []) {
      // Fabric items API returns sensitivityLabel.labelId (not sensitivityLabelId)
      item._labelId = (item.sensitivityLabel?.labelId ?? item.sensitivityLabel?.sensitivityLabelId)?.toLowerCase() ?? null;
      if (item.sensitivityLabel !== undefined || item._labelId) {
        debug(`[Oversharing] Item "${item.displayName}" sensitivityLabel:`, JSON.stringify(item.sensitivityLabel), '→ _labelId:', item._labelId);
      }
      items.push(item);
    }
    url = result.data['continuationToken']
      ? `${FABRIC_BASE}/workspaces/${encodeURIComponent(workspaceId)}/items?continuationToken=${encodeURIComponent(result.data.continuationToken)}`
      : null;
  }
  return items;
}

/**
 * Fetches the tenant's sensitivity label list from Graph and returns a Map
 * from labelId (lowercase) → displayName.
 */
async function fetchLabelNameMap() {
  try {
    const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';
    const token = await acquireGraphTokenViaClientCredentials();
    const result = await jsonRequest(`${GRAPH_BASE_URL}/security/informationProtection/sensitivityLabels`, { token });
    if (!result.ok) {
      console.warn('[Oversharing] fetchLabelNameMap: Graph returned', result.status, JSON.stringify(result.data).slice(0, 300));
      return new Map();
    }
    const map = new Map();
    for (const l of result.data.value ?? []) {
      if (l.id) map.set(l.id.toLowerCase(), l.name ?? l.displayName ?? null);
    }
    debug(`[Oversharing] fetchLabelNameMap: ${map.size} labels loaded`, [...map.entries()]);
    return map;
  } catch (err) {
    console.warn('[Oversharing] fetchLabelNameMap failed:', err.message);
    return new Map();
  }
}

const POWERBI_BASE = 'https://api.powerbi.com/v1.0/myorg';
const POWERBI_TYPES = new Set(['SemanticModel', 'Report', 'Dashboard', 'PaginatedReport']);

async function getFabricItemUsers(workspaceId, itemId, itemType) {
  const token = acquireFabricToken();
  const url = `${FABRIC_BASE}/workspaces/${encodeURIComponent(workspaceId)}/items/${encodeURIComponent(itemId)}/users`;
  const result = await jsonRequest(url, { token });
  if (!result.ok) {
    if (result.status !== 404 && result.status !== 403) {
      console.warn(`[Oversharing] getFabricItemUsers(${itemId}, type=${itemType}) failed (${result.status}):`, JSON.stringify(result.data).slice(0, 200));
    }
    return [];
  }
  const users = result.data.value ?? [];
  debug(`[Oversharing] getFabricItemUsers(${itemId}, type=${itemType}) → ${users.length} user(s)`);
  return users;
}

async function getItemUsers(workspaceId, itemId, itemType) {
  // Always fetch Fabric Items API users (captures shares done via Fabric share dialog)
  const fabricUsers = await getFabricItemUsers(workspaceId, itemId, itemType);

  if (!POWERBI_TYPES.has(itemType)) {
    return fabricUsers;
  }

  // For Power BI items also fetch from the Power BI API (captures Power BI-level explicit grants)
  // Merge the two, deduped by identifier
  const pbiUsers = await getPowerBIItemUsers(workspaceId, itemId, itemType);
  const seen = new Set(fabricUsers.map(u => (u.identifier ?? u.emailAddress ?? '').toLowerCase()));
  for (const u of pbiUsers) {
    const key = (u.identifier ?? u.emailAddress ?? '').toLowerCase();
    if (!seen.has(key)) {
      fabricUsers.push(u);
      seen.add(key);
    }
  }
  return fabricUsers;
}

const POWERBI_ENDPOINTS = {
  SemanticModel:   { segment: 'datasets',   accessField: 'datasetUserAccessRight' },
  Report:          { segment: 'reports',    accessField: 'reportUserAccessRight' },
  Dashboard:       { segment: 'dashboards', accessField: 'dashboardUserAccessRight' },
  PaginatedReport: { segment: 'reports',    accessField: 'reportUserAccessRight' },
};

async function getPowerBIItemUsers(workspaceId, itemId, itemType) {
  const { segment, accessField } = POWERBI_ENDPOINTS[itemType] ?? POWERBI_ENDPOINTS.SemanticModel;
  const token = acquirePowerBIToken();

  // Try regular workspace-scoped endpoint first
  const url = `${POWERBI_BASE}/groups/${encodeURIComponent(workspaceId)}/${segment}/${encodeURIComponent(itemId)}/users`;
  let result = await jsonRequest(url, { token }).catch(() => null);

  // Fall back to Power BI Admin API if regular endpoint fails (e.g. FeatureNotAvailableError)
  if (!result || !result.ok) {
    if (result) {
      console.warn(`[Oversharing] getPowerBIItemUsers regular(${itemId}, type=${itemType}) → ${result.status}, trying admin endpoint`);
    }
    const adminUrl = `${POWERBI_BASE}/admin/${segment}/${encodeURIComponent(itemId)}/users`;
    result = await jsonRequest(adminUrl, { token }).catch(() => null);
    if (!result || !result.ok) {
      console.warn(`[Oversharing] getPowerBIItemUsers admin(${itemId}, type=${itemType}) → ${result?.status}:`, JSON.stringify(result?.data).slice(0, 200));
      return [];
    }
    debug(`[Oversharing] getPowerBIItemUsers admin(${itemId}, type=${itemType}) → success`);
  }

  try {
    const rawUsers = result.data.value ?? [];
    // Filter out workspace members with inherited "None" access — they have no explicit grant
    const explicitUsers = rawUsers.filter(u => u[accessField] && u[accessField] !== 'None');
    debug(`[Oversharing] getPowerBIItemUsers(${itemId}, type=${itemType}) → ${rawUsers.length} total, ${explicitUsers.length} with explicit access`);
    return explicitUsers.map(u => ({
      identifier:        u.identifier ?? u.emailAddress,
      displayName:       u.displayName ?? u.identifier,
      principalType:     u.principalType,
      emailAddress:      u.emailAddress ?? null,   // don't fall back to identifier (breaks isGroup detection)
      itemAccessDetails: {
        accessDetails: [{ accessRight: u[accessField] ?? 'Read' }],
      },
    }));
  } catch (err) {
    console.warn(`[Oversharing] getPowerBIItemUsers(${itemId}) error:`, err.message);
    return [];
  }
}

async function getWorkspaceMemberIds(workspaceId) {
  try {
    const token = acquireFabricToken();
    let url = `${FABRIC_BASE}/workspaces/${encodeURIComponent(workspaceId)}/roleAssignments`;
    const ids = new Set();
    const unresolvedUserIds = [];
    while (url) {
      const result = await jsonRequest(url, { token });
      if (!result.ok) break;
      for (const ra of result.data.value ?? []) {
        const principalId = ra.principal?.id;
        const upn = ra.principal?.userPrincipalName;
        if (principalId) ids.add(principalId.toLowerCase());
        if (upn) {
          ids.add(upn.toLowerCase());
        } else if (principalId && ra.principal?.type === 'User') {
          // UPN missing — resolve via Graph
          unresolvedUserIds.push(principalId);
        }
      }
      url = result.data['@odata.nextLink'] ?? null;
    }
    if (unresolvedUserIds.length > 0) {
      const resolved = await resolveEntraObjects(unresolvedUserIds);
      for (const info of resolved.values()) {
        if (info.upn) ids.add(info.upn.toLowerCase());
      }
    }
    return ids;
  } catch (err) {
    console.warn('[Oversharing] getWorkspaceMemberIds failed:', err.message);
    return new Set();
  }
}

/**
 * Fetches workspace role assignments, finds Group-type principals, and expands
 * each group to its individual members.
 * Returns array of { groupId, groupName, role, members: [{id, displayName, upn}] }
 */
async function getWorkspaceGroupsAndMembers(workspaceId) {
  try {
    const token = acquireFabricToken();
    let url = `${FABRIC_BASE}/workspaces/${encodeURIComponent(workspaceId)}/roleAssignments`;
    const groups = [];
    while (url) {
      const result = await jsonRequest(url, { token });
      if (!result.ok) break;
      for (const ra of result.data.value ?? []) {
        const p = ra.principal;
        if (!p) continue;
        const isGroup = p.type === 'Group' || p.type === 'SecurityGroup' || p.groupDetails != null;
        if (!isGroup) continue;
        groups.push({ groupId: p.id, groupName: p.displayName ?? p.id, role: ra.role });
      }
      url = result.data['@odata.nextLink'] ?? null;
    }
    const expanded = await Promise.all(groups.map(async g => {
      const members = await fetchGroupMembers(g.groupId);
      debug(`[Oversharing] Workspace group "${g.groupName}" (${g.role}): ${members.length} member(s)`);
      return { ...g, members };
    }));
    return expanded;
  } catch (err) {
    console.warn('[Oversharing] getWorkspaceGroupsAndMembers failed:', err.message);
    return [];
  }
}

/**
 * Resolves Entra user IDs to {displayName, upn} via Graph batch API.
 * Use this when you already know the objects are users.
 * Returns a Map from objectId (lowercase) → { displayName, upn }.
 */
async function resolveEntraObjects(objectIds) {
  const result = new Map();
  if (!objectIds.length) return result;
  try {
    const token = await acquireGraphTokenViaClientCredentials();
    for (let i = 0; i < objectIds.length; i += 20) {
      const batch = objectIds.slice(i, i + 20);
      const requests = batch.map((id, idx) => ({
        id: String(idx),
        method: 'GET',
        url: `/users/${encodeURIComponent(id)}?$select=id,displayName,userPrincipalName,mail`,
      }));
      const batchRes = await jsonRequest(`${GRAPH_BASE}/$batch`, { method: 'POST', token, body: { requests } });
      if (!batchRes.ok) continue;
      for (const resp of batchRes.data.responses ?? []) {
        if (resp.status !== 200) continue;
        const obj = resp.body;
        if (!obj.id) continue;
        result.set(obj.id.toLowerCase(), {
          displayName: obj.displayName ?? obj.id,
          upn:         obj.userPrincipalName ?? obj.mail ?? null,
          type:        'User',
        });
      }
    }
  } catch (err) {
    console.warn('[Oversharing] resolveEntraObjects failed:', err.message);
  }
  return result;
}

/**
 * Resolves Entra directory object IDs (users OR groups) via Graph batch API.
 * Returns a Map from objectId (lowercase) → { displayName, upn, type }.
 */
async function resolveDirectoryObjects(objectIds) {
  const result = new Map();
  if (!objectIds.length) return result;
  try {
    const token = await acquireGraphTokenViaClientCredentials();
    for (let i = 0; i < objectIds.length; i += 20) {
      const batch = objectIds.slice(i, i + 20);
      const requests = batch.map((id, idx) => ({
        id: String(idx),
        method: 'GET',
        url: `/directoryObjects/${encodeURIComponent(id)}?$select=id,displayName,userPrincipalName,mail`,
      }));
      const batchRes = await jsonRequest(`${GRAPH_BASE}/$batch`, { method: 'POST', token, body: { requests } });
      if (!batchRes.ok) continue;
      for (const resp of batchRes.data.responses ?? []) {
        if (resp.status !== 200) continue;
        const obj = resp.body;
        if (!obj.id) continue;
        const odataType = obj['@odata.type'] ?? '';
        const type = odataType.includes('group') ? 'Group'
          : odataType.includes('servicePrincipal') ? 'ServicePrincipal'
          : 'User';
        result.set(obj.id.toLowerCase(), {
          displayName: obj.displayName ?? obj.id,
          upn:         obj.userPrincipalName ?? obj.mail ?? null,
          type,
        });
      }
    }
  } catch (err) {
    console.warn('[Oversharing] resolveDirectoryObjects failed:', err.message);
  }
  return result;
}

/**
 * Fetches direct members of an AD group via Graph API.
 * Returns an array of { id, displayName, upn } objects.
 */
async function fetchGroupMembers(groupId) {
  try {
    const token = await acquireGraphTokenViaClientCredentials();
    const result = await jsonRequest(
      `${GRAPH_BASE}/groups/${encodeURIComponent(groupId)}/members?$select=id,displayName,userPrincipalName,mail`,
      { token }
    );
    if (!result.ok) {
      console.warn(`[Oversharing] fetchGroupMembers(${groupId}) → ${result.status}`);
      return [];
    }
    return (result.data.value ?? []).map(m => ({
      id:          m.id,
      displayName: m.displayName ?? m.id,
      upn:         m.userPrincipalName ?? m.mail ?? null,
    }));
  } catch (err) {
    console.warn(`[Oversharing] fetchGroupMembers(${groupId}) failed:`, err.message);
    return [];
  }
}

/**
 * Fetches OneLake data access role members for all lakehouses in a workspace.
 * Returns a Map from lakehouseId → Array of members:
 *   { identifier, displayName, email, principalType, roleName, permissions }
 */
async function getOneLakeMembers(workspaceId) {
  const map = new Map();
  try {
    const token = acquireFabricToken();
    const lhResult = await jsonRequest(
      `${FABRIC_BASE}/workspaces/${encodeURIComponent(workspaceId)}/lakehouses`,
      { token }
    );
    if (!lhResult.ok) return map;

    // Collect all entra member objectIds across all lakehouses so we can batch-resolve them
    const allRolesByLakehouse = [];
    await Promise.all((lhResult.data.value ?? []).map(async lh => {
      const rolesResult = await jsonRequest(
        `${FABRIC_BASE}/workspaces/${encodeURIComponent(workspaceId)}/items/${encodeURIComponent(lh.id)}/dataAccessRoles`,
        { token }
      );
      if (!rolesResult.ok) return; // 400 = OneLake security not enabled, silently skip
      allRolesByLakehouse.push({ lh, roles: rolesResult.data.value ?? [] });
    }));

    // Collect all object IDs that need resolution (type detection)
    const allObjectIds = [];
    for (const { roles } of allRolesByLakehouse) {
      for (const role of roles) {
        for (const m of role.members?.microsoftEntraMembers ?? []) {
          if (m.objectId) allObjectIds.push(m.objectId);
        }
      }
    }
    // resolveDirectoryObjects detects User vs Group
    const identityMap = await resolveDirectoryObjects([...new Set(allObjectIds)]);

    // Expand group members in parallel
    const groupIds = [...identityMap.entries()]
      .filter(([, info]) => info.type === 'Group')
      .map(([id]) => id);
    const groupMembersMap = new Map(); // groupId → [{ id, displayName, upn }]
    await Promise.all(groupIds.map(async gid => {
      const members = await fetchGroupMembers(gid);
      groupMembersMap.set(gid, members);
    }));

    for (const { lh, roles } of allRolesByLakehouse) {
      const members = [];
      for (const role of roles) {
        const permissions = extractPermissions(role);
        for (const m of role.members?.microsoftEntraMembers ?? []) {
          const oidKey = (m.objectId ?? '').toLowerCase();
          const resolved = identityMap.get(oidKey);
          const principalType = m.type ?? resolved?.type ?? 'User';
          const displayName = m.displayName ?? resolved?.displayName ?? m.objectId;
          const email = m.email ?? m.userPrincipalName ?? resolved?.upn ?? null;

          // Add the principal itself (group or user)
          members.push({
            identifier:    m.objectId,
            displayName,
            email,
            principalType,
            roleName:      role.name,
            permissions,
            viaGroup:      null,
          });

          // For groups: also add each individual member
          if (principalType === 'Group') {
            const groupMembers = groupMembersMap.get(oidKey) ?? [];
            for (const gm of groupMembers) {
              members.push({
                identifier:    gm.id,
                displayName:   gm.displayName,
                email:         gm.upn,
                principalType: 'User',
                roleName:      role.name,
                permissions,
                viaGroup:      displayName, // name of the group they belong to
              });
            }
          }
        }
      }
      if (members.length > 0) {
        debug(`[Oversharing] OneLake members for ${lh.displayName}: ${members.length}`);
        map.set(lh.id, members);
      }
    }
  } catch (err) {
    console.warn('[Oversharing] getOneLakeMembers failed:', err.message);
  }
  return map;
}

function extractPermissions(role) {
  if (Array.isArray(role.permissions) && role.permissions.length > 0) return role.permissions;
  const perms = [];
  for (const rule of role.decisionRules ?? []) {
    if (rule.effect !== 'Permit') continue;
    for (const perm of rule.permission ?? []) {
      for (const val of perm.attributeValueIncludedIn ?? []) {
        if (!perms.includes(val)) perms.push(val);
      }
    }
  }
  return perms;
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

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isGroup(u) {
  if (u.principalType === 'Group' || u.principalType === 'SecurityGroup') return true;
  const id = u.identifier ?? '';
  const email = u.emailAddress ?? '';
  return GUID_RE.test(id) && !email;
}

function isExternalIdentifier(u, workspaceMemberIds) {
  if (u.principalType === 'ExternalMember' || u.principalType === 'Guest') return true;
  const id = u.identifier ?? '';
  if (id.includes('#EXT#')) return true;
  const email = u.emailAddress ?? '';
  if (email && email.includes('#EXT#')) return true;
  // Groups are workspace-level principals — don't flag them as external here
  if (isGroup(u)) return false;
  // Not a B2B guest; check workspace membership by id or UPN
  if (workspaceMemberIds && workspaceMemberIds.size > 0) {
    const idLower = id.toLowerCase();
    const emailLower = email.toLowerCase();
    const knownById    = idLower    && workspaceMemberIds.has(idLower);
    const knownByEmail = emailLower && workspaceMemberIds.has(emailLower);
    if (!knownById && !knownByEmail) return true;
  }
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

function computeFlags(users, labelId, workspaceMemberIds) {
  const hasDirectGrants = users.length > 0;
  // Use pre-computed isExternal when available (mapped users), fall back to re-computation
  // Org-wide shares also count as "external" since the whole org has access
  const hasExternalUsers = users.some(u =>
    u.isOrgWide || (('isExternal' in u) ? u.isExternal : isExternalIdentifier(u, workspaceMemberIds))
  );
  const unlabeledWithGrants = hasDirectGrants && !labelId;
  const highAccessCount = users.length > HIGH_ACCESS_THRESHOLD;
  return { hasDirectGrants, hasExternalUsers, unlabeledWithGrants, highAccessCount };
}

async function processItem(raw, workspaceId, grantorMap, workspaceMemberIds, labelNameMap, oneLakeMap, workspaceGroups) {
  try {
    const users = await getItemUsers(workspaceId, raw.id, raw.type);
    const itemGrantors = grantorMap.get(raw.id) ?? new Map();
    const labelId = raw._labelId ?? null;
    const labelName = labelId ? (labelNameMap.get(labelId) ?? null) : null;

    const mappedUsers = await Promise.all(users.map(async u => {
      const grantor = itemGrantors.get(u.identifier) ?? {};
      const orgWide = (u.displayName ?? '').toLowerCase().includes('whole organization') ||
                      (u.displayName ?? '').toLowerCase().includes('all users');
      const group = orgWide || isGroup(u);
      const isExternal = !orgWide && isExternalIdentifier(u, workspaceMemberIds);
      const rights = u.itemAccessDetails?.accessDetails?.map(a => a.accessRight) ?? [];
      let displayName = u.displayName ?? null;
      if (group && (!displayName || displayName === u.identifier)) {
        displayName = await resolveGroupDisplayName(u.identifier) ?? u.identifier;
      } else {
        displayName = displayName ?? u.identifier;
      }
      return {
        identifier:       u.identifier,
        displayName,
        email:            u.emailAddress ?? null,
        principalType:    u.principalType,
        accessRights:     rights,
        isExternal,
        isExternalDomain: isExternal && isExternalDomain(u),
        isGroup:          group,
        isOrgWide:        orgWide,
        grantedBy:  grantor.grantedBy ?? null,
        grantedAt:  grantor.grantedAt ?? null,
      };
    }));

    // Merge OneLake data access role members (for Lakehouse items)
    const oneLakeMembers = oneLakeMap.get(raw.id) ?? [];
    const existingIds = new Set(mappedUsers.map(u => u.identifier?.toLowerCase()));
    for (const m of oneLakeMembers) {
      const idKey = m.identifier?.toLowerCase();
      if (idKey && existingIds.has(idKey)) continue; // already present via item users
      existingIds.add(idKey); // prevent duplicates (e.g. a user appears via two groups)
      const isExternal = m.isExternal !== undefined
        ? m.isExternal
        : isExternalIdentifier(
            { identifier: m.identifier, emailAddress: m.email, principalType: m.principalType },
            workspaceMemberIds
          );
      mappedUsers.push({
        identifier:       m.identifier,
        displayName:      m.displayName,
        email:            m.email,
        principalType:    m.principalType,
        accessRights:     m.permissions.length > 0 ? m.permissions.map(p => `OneLake: ${p}`) : [`OneLake: ${m.roleName}`],
        isExternal,
        isExternalDomain: isExternalDomain({ identifier: m.identifier, emailAddress: m.email, principalType: m.principalType }),
        isGroup:          m.principalType === 'Group' || m.principalType === 'SecurityGroup',
        viaGroup:         m.viaGroup ?? null,
        grantedBy:        null,
        grantedAt:        null,
      });
    }

    // Merge workspace AD group members (all items are accessible via workspace roles)
    for (const group of (workspaceGroups ?? [])) {
      // Add the group itself
      const groupKey = group.groupId.toLowerCase();
      if (!existingIds.has(groupKey)) {
        existingIds.add(groupKey);
        mappedUsers.push({
          identifier:       group.groupId,
          displayName:      group.groupName,
          email:            null,
          principalType:    'Group',
          accessRights:     [`Workspace: ${group.role}`],
          isExternal:       false,
          isExternalDomain: false,
          isGroup:          true,
          viaGroup:         null,
          grantedBy:        null,
          grantedAt:        null,
        });
      }
      // Add individual group members — show all, including direct workspace members,
      // so the report reflects the full truth of who has access and via which path.
      for (const gm of group.members) {
        const gmKey = (gm.id ?? '').toLowerCase();
        if (!gmKey || existingIds.has(gmKey)) continue;
        existingIds.add(gmKey);
        const isExt = isExternalIdentifier(
          { identifier: gm.id, emailAddress: gm.upn, principalType: 'User' },
          workspaceMemberIds
        );
        mappedUsers.push({
          identifier:       gm.id,
          displayName:      gm.displayName,
          email:            gm.upn,
          principalType:    'User',
          accessRights:     [`Workspace: ${group.role}`],
          isExternal:       isExt,
          isExternalDomain: isExternalDomain({ identifier: gm.id, emailAddress: gm.upn, principalType: 'User' }),
          isGroup:          false,
          viaGroup:         group.groupName,
          grantedBy:        null,
          grantedAt:        null,
        });
      }
    }

    const flags = computeFlags(mappedUsers, labelId, workspaceMemberIds);

    return {
      id: raw.id,
      displayName: raw.displayName,
      type: raw.type,
      labelId,
      labelName,
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

/**
 * Run an async mapper over items with bounded concurrency.
 * Prevents unbounded fan-out (e.g. 500-item workspaces hitting Graph API limits).
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} mapper
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await mapper(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function buildOversharingReport(workspaceId) {
  const grantorTimeout = new Promise(resolve =>
    setTimeout(() => resolve(new Map()), 8_000)
  );

  const [rawItems, grantorMap, workspaceMemberIds, labelNameMap, oneLakeMap, workspaceGroups] = await Promise.all([
    getAllItems(workspaceId),
    Promise.race([buildGrantorMap(workspaceId), grantorTimeout]),
    getWorkspaceMemberIds(workspaceId),
    fetchLabelNameMap(),
    getOneLakeMembers(workspaceId),
    getWorkspaceGroupsAndMembers(workspaceId),
  ]);

  // Cap concurrency at 5 to avoid overwhelming Fabric/PowerBI/Graph APIs
  // when scanning large enterprise workspaces (hundreds of items).
  const items = await mapWithConcurrency(rawItems, 5, raw =>
    processItem(raw, workspaceId, grantorMap, workspaceMemberIds, labelNameMap, oneLakeMap, workspaceGroups)
  );

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
