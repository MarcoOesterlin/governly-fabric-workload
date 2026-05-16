'use strict';

/**
 * Access Management backend
 *
 * Fetches workspace role assignments (Fabric API), expands AD group members
 * (Graph API), and correlates with audit logs to determine when each member
 * was added. Exposes buildAccessReport() and removeMemberFromGroup().
 */

const https = require('https');
const { acquireGraphTokenViaClientCredentials, acquireFabricToken, acquireAzToken, acquirePowerBIToken } = require('./governlyProxy');

const GRAPH_BASE    = 'https://graph.microsoft.com/v1.0';
const FABRIC_BASE   = 'https://api.fabric.microsoft.com/v1';
const POWERBI_BASE  = 'https://api.powerbi.com/v1.0/myorg';

/**
 * Minimal JSON-over-HTTPS helper.
 * @param {string} url
 * @param {{ method?: string; token: string; body?: object }} opts
 * @returns {Promise<{ status: number; ok: boolean; data: any }>}
 */
async function jsonRequest(url, { method = 'GET', token, body } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };
    if (bodyStr) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
    }
    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + (parsed.search || ''),
      method,
      headers,
    };
    const req = https.request(reqOpts, (res) => {
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
    req.setTimeout(30_000, () => {
      req.destroy(new Error(`Request timed out after 30s: ${reqOpts.hostname}${reqOpts.path}`));
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/**
 * Returns raw Fabric workspace role assignments.
 * Paginates through all results via @odata.nextLink.
 * @param {string} workspaceId
 * @returns {Promise<Array<{id,role,principal:{id,displayName,type,userPrincipalName}}>>}
 */
async function getWorkspaceRoles(workspaceId) {
  const token = acquireFabricToken();
  let url = `${FABRIC_BASE}/workspaces/${encodeURIComponent(workspaceId)}/roleAssignments`;
  const allAssignments = [];
  while (url) {
    const result = await jsonRequest(url, { method: 'GET', token });
    if (!result.ok) {
      throw new Error(`Fabric roleAssignments failed (${result.status}) for workspace ${workspaceId}`);
    }
    allAssignments.push(...(result.data.value ?? []));
    url = result.data['@odata.nextLink'] ?? null;
  }
  return allAssignments;
}

/**
 * Returns members of an AD group.
 * Paginates through all results via @odata.nextLink.
 * @param {string} groupId
 * @returns {Promise<Array<{id,displayName,userPrincipalName,mail}>>}
 */
async function getGroupMembers(groupId) {
  const token = await acquireGraphTokenViaClientCredentials();
  const params = new URLSearchParams({
    '$select': 'id,displayName,userPrincipalName,mail',
    '$top': '999',
  });
  let url = `${GRAPH_BASE}/groups/${encodeURIComponent(groupId)}/members?${params}`;
  const rawMembers = [];
  while (url) {
    const result = await jsonRequest(url, { token });
    if (!result.ok) {
      console.warn(`[AccessMgmt] getGroupMembers(${groupId}) failed (${result.status}) — returning ${rawMembers.length} collected so far`);
      return rawMembers.length ? rawMembers : [];
    }
    rawMembers.push(...(result.data.value ?? []));
    url = result.data['@odata.nextLink'] ?? null;
  }
  return rawMembers;
}

/**
 * Fetches "Add member to group" audit events for the given group.
 * Returns a Map from memberId → ISO 8601 addedAt string (most recent entry wins).
 * Paginates through all results via @odata.nextLink.
 *
 * Graph auditLogs/directoryAudits:
 *   Each entry has targetResources: one Group entry (the group itself) and
 *   one or more non-Group entries (the members added in that event).
 *
 * @param {string} groupId
 * @returns {Promise<Map<string, string>>}   memberId → addedAt
 */
async function getGroupAuditDates(groupId) {
  if (!/^[0-9a-f-]{36}$/i.test(groupId)) {
    console.warn(`getGroupAuditDates: invalid groupId format: ${groupId}`);
    return new Map();
  }
  const token = await acquireGraphTokenViaClientCredentials();
  const filter =
    `activityDisplayName eq 'Add member to group'` +
    ` and targetResources/any(t: t/id eq '${groupId}' and t/type eq 'Group')`;
  const params = new URLSearchParams({
    '$filter': filter,
    '$select': 'activityDateTime,targetResources',
    '$top': '200',
    '$orderby': 'activityDateTime desc',
  });
  let url = `${GRAPH_BASE}/auditLogs/directoryAudits?${params}`;

  /** @type {Map<string, string>} */
  const map = new Map();
  while (url) {
    const result = await jsonRequest(url, { token });
    if (!result.ok) {
      // AuditLog.Read.All may not yet be consented — degrade gracefully
      console.warn(`[AccessMgmt] Audit log fetch failed (${result.status}) — addedAt will be null for remaining members`);
      return map;
    }

    for (const entry of result.data.value ?? []) {
      const addedAt = entry.activityDateTime;
      for (const target of entry.targetResources ?? []) {
        if (target.type !== 'Group' && target.id) {
          // Only update if not already present (results are newest-first from Graph)
          if (!map.has(target.id)) {
            map.set(target.id, addedAt);
          }
        }
      }
    }
    url = result.data['@odata.nextLink'] ?? null;
  }
  return map;
}

/**
 * Maps a set of OneLake itemAccess values (e.g. ["ReadAll"]) to the minimum
 * Fabric workspace roles whose members implicitly satisfy that access level.
 */
const ITEM_ACCESS_TO_WS_ROLES = {
  ReadAll:           ['Admin', 'Member', 'Contributor'],
  ReadWriteAll:      ['Admin', 'Member'],
  ReadWriteAllExplore: ['Admin', 'Member'],
  Write:             ['Admin', 'Member', 'Contributor'],
  Execute:           ['Admin', 'Member', 'Contributor'],
};

/**
 * Given a set of itemAccess strings and raw workspace role assignments, returns
 * the subset of direct-user assignments that satisfy all requested access levels.
 */
function expandViaWorkspaceRoles(itemAccess, wsRoleAssignments) {
  // Determine which workspace roles satisfy ALL required access levels
  const candidateRoles = itemAccess.length === 0
    ? ['Admin', 'Member', 'Contributor', 'Viewer']
    : itemAccess.reduce((acc, a) => {
        const roles = ITEM_ACCESS_TO_WS_ROLES[a] ?? ['Admin', 'Member', 'Contributor'];
        return acc === null ? roles : acc.filter(r => roles.includes(r));
      }, null) ?? ['Admin', 'Member', 'Contributor'];

  return wsRoleAssignments
    .filter(ra => candidateRoles.includes(ra.role) && ra.principal.type === 'User')
    .map(ra => ({
      id:            ra.principal.id,
      displayName:   ra.principal.displayName,
      email:         ra.principal.userPrincipalName ?? ra.principal.mail ?? null,
      principalType: 'User',
    }));
}

/**
 * Fetches OneLake data access roles for all lakehouses in a workspace.
 * Returns [] if no lakehouses exist or if OneLake security is not enabled.
 *
 * @param {string} workspaceId
 * @param {Array}  wsRoleAssignments  Raw workspace role assignments (fallback for expansion)
 * @returns {Promise<Array<{id, name, roles}>>}
 */
async function getLakehouseDataAccessRoles(workspaceId, wsRoleAssignments = []) {
  const token = acquireFabricToken();

  // 1. List all lakehouses in the workspace
  const lhResult = await jsonRequest(
    `${FABRIC_BASE}/workspaces/${encodeURIComponent(workspaceId)}/lakehouses`,
    { token }
  );
  if (!lhResult.ok) {
    console.warn(`[AccessMgmt] list lakehouses failed (${lhResult.status}) — skipping OneLake security`);
    return [];
  }

  // Pre-fetch all items in this workspace so we can resolve sourcePath IDs to names
  const itemsResult = await jsonRequest(
    `${FABRIC_BASE}/workspaces/${encodeURIComponent(workspaceId)}/items`,
    { token }
  );
  /** @type {Map<string, string>}  itemId → displayName */
  const itemNameMap = new Map();
  for (const item of itemsResult.data?.value ?? []) {
    itemNameMap.set(item.id, item.displayName);
  }

  /**
   * Resolves a fabricItemMember sourcePath to a readable name AND expands the
   * virtual membership to actual users by fetching /items/{id}/users.
   */
  async function resolveSourcePath(sourcePath, itemAccess) {
    const parts = sourcePath.split('/');
    let resolvedItem = null;
    let resolvedWorkspace = null;
    let expandedUsers = [];

    if (parts.length === 2) {
      const [wsId, itemId] = parts;
      resolvedItem = itemNameMap.get(itemId) ?? null;

      if (wsId !== workspaceId) {
        // Cross-workspace reference — try to fetch the workspace name
        const wsResult = await jsonRequest(
          `${FABRIC_BASE}/workspaces/${encodeURIComponent(wsId)}`,
          { token }
        ).catch(() => null);
        resolvedWorkspace = wsResult?.data?.displayName ?? wsId;

        // Try to fetch the item name if it's in a different workspace
        if (!resolvedItem) {
          const extItemResult = await jsonRequest(
            `${FABRIC_BASE}/workspaces/${encodeURIComponent(wsId)}/items/${encodeURIComponent(itemId)}`,
            { token }
          ).catch(() => null);
          resolvedItem = extItemResult?.data?.displayName ?? itemId;
        }
      } else {
        resolvedItem = resolvedItem ?? itemId;
      }

      // Expand virtual membership: fetch all users of that item
      const usersResult = await jsonRequest(
        `${FABRIC_BASE}/workspaces/${encodeURIComponent(wsId)}/items/${encodeURIComponent(itemId)}/users`,
        { token }
      ).catch(() => null);

      if (usersResult?.ok) {
        const allUsers = usersResult.data?.value ?? [];
        expandedUsers = allUsers
          .filter(u => {
            const access = u.itemAccessDetails?.type ?? u.itemAccess;
            return itemAccess.length === 0 ||
              itemAccess.some(a =>
                access === a || (Array.isArray(access) && access.includes(a))
              );
          })
          .map(u => ({
            id:            u.id ?? u.objectId,
            displayName:   u.displayName,
            email:         u.emailAddress ?? u.email ?? null,
            principalType: u.principalType ?? 'User',
          }));
      } else if (wsId === workspaceId && wsRoleAssignments.length > 0) {
        // /items/{id}/users is not supported for this item type — fall back to
        // workspace role assignments. Users with matching workspace roles implicitly
        // satisfy the itemAccess requirement.
        expandedUsers = expandViaWorkspaceRoles(itemAccess, wsRoleAssignments);
      }
    } else {
      // Single-segment path — just an itemId
      resolvedItem = itemNameMap.get(sourcePath) ?? sourcePath;
    }

    return { sourcePath, itemAccess, resolvedItem, resolvedWorkspace, expandedUsers };
  }

  const lakehouses = lhResult.data.value ?? [];
  const results = [];

  // 2. For each lakehouse, fetch data access roles (parallel)
  await Promise.all(lakehouses.map(async (lh) => {
    const rolesResult = await jsonRequest(
      `${FABRIC_BASE}/workspaces/${encodeURIComponent(workspaceId)}/items/${encodeURIComponent(lh.id)}/dataAccessRoles`,
      { token }
    );

    if (rolesResult.status === 400) {
      // OneLake security not enabled for this lakehouse — silently skip
      return;
    }
    if (!rolesResult.ok) {
      console.warn(`[AccessMgmt] dataAccessRoles for ${lh.displayName} (${lh.id}): ${rolesResult.status}`);
      return;
    }

    const rawRoles = rolesResult.data.value ?? [];
    console.log(`[AccessMgmt] OneLake security for ${lh.displayName}: ${rawRoles.length} role(s)`);

    const roles = await Promise.all(rawRoles.map(async role => {
      // Extract permissions — try top-level array first, fall back to decisionRules
      let permissions = [];
      if (Array.isArray(role.permissions) && role.permissions.length > 0) {
        permissions = role.permissions;
      } else {
        for (const rule of role.decisionRules ?? []) {
          if (rule.effect === 'Permit') {
            for (const perm of rule.permission ?? []) {
              for (const val of perm.attributeValueIncludedIn ?? []) {
                if (!permissions.includes(val)) permissions.push(val);
              }
            }
          }
        }
      }

      // Explicit Entra members (named users / groups / service principals)
      const entraMembers = (role.members?.microsoftEntraMembers ?? []).map(m => ({
        objectId:    m.objectId,
        displayName: m.displayName ?? m.objectId,
        email:       m.email ?? m.userPrincipalName ?? null,
        type:        m.type ?? 'User',
      }));

      // Virtual members — resolve sourcePath UUIDs to human-readable names
      const fabricItemMembers = await Promise.all(
        (role.members?.fabricItemMembers ?? []).map(m =>
          resolveSourcePath(m.sourcePath, m.itemAccess ?? [])
        )
      );

      return { name: role.name, permissions, entraMembers, fabricItemMembers };
    }));

    results.push({ id: lh.id, name: lh.displayName, roles });
  }));

  return results;
}

/** Power BI item types and their API segment + access right field */
const POWERBI_ITEM_ENDPOINTS = {
  SemanticModel:   { segment: 'datasets',    accessField: 'datasetUserAccessRight' },
  Report:          { segment: 'reports',     accessField: 'reportUserAccessRight' },
  Dashboard:       { segment: 'dashboards',  accessField: 'dashboardUserAccessRight' },
  PaginatedReport: { segment: 'reports',     accessField: 'reportUserAccessRight' },
};

/**
 * Fetches users who have been granted direct item-level access on Power BI items
 * (SemanticModel, Report, Dashboard) using the Power BI REST API.
 * Only returns users with an explicit access right (not "None" — workspace members
 * who inherited access are typically returned with "None" and are excluded).
 *
 * @param {string} workspaceId
 * @returns {Promise<Array<{itemId, itemName, itemType, users}>>}
 */
async function getDirectItemShares(workspaceId) {
  const fabricToken = acquireFabricToken();
  const itemsResult = await jsonRequest(
    `${FABRIC_BASE}/workspaces/${encodeURIComponent(workspaceId)}/items`,
    { token: fabricToken }
  ).catch(() => null);
  if (!itemsResult?.ok) return [];

  const powerBIToken = acquirePowerBIToken();
  const items = (itemsResult.data?.value ?? [])
    .filter(i => POWERBI_ITEM_ENDPOINTS[i.type]);

  const results = [];
  await Promise.all(items.map(async (item) => {
    const { segment, accessField } = POWERBI_ITEM_ENDPOINTS[item.type];
    const url = `${POWERBI_BASE}/groups/${encodeURIComponent(workspaceId)}/${segment}/${encodeURIComponent(item.id)}/users`;
    const usersResult = await jsonRequest(url, { token: powerBIToken }).catch(() => null);
    if (!usersResult?.ok) return;

    const users = (usersResult.data?.value ?? [])
      .filter(u => u[accessField] && u[accessField] !== 'None')
      .map(u => ({
        id:            u.graphId ?? u.identifier,
        displayName:   u.displayName ?? u.identifier,
        email:         u.emailAddress ?? null,
        identifier:    u.identifier ?? null,
        principalType: u.principalType ?? 'User',
        accessRight:   u[accessField],
        isExternal:    (u.identifier ?? '').includes('#EXT#') ||
                       (u.emailAddress ?? '').includes('#EXT#'),
      }));

    if (users.length > 0) {
      results.push({ itemId: item.id, itemName: item.displayName, itemType: item.type, users });
    }
  }));

  return results;
}

/**
 * Builds the full access report for a workspace.
 * For each Group assignment, expands members and correlates with audit dates.
 *
 * @param {string} workspaceId
 * @returns {Promise<{ assignments: Array, oneLakeSecurity: Array, directItemShares: Array }>}
 */
async function buildAccessReport(workspaceId) {
  // Fetch workspace roles first so they can be used as fallback for OneLake expansion
  const rawAssignments = await getWorkspaceRoles(workspaceId);
  const [oneLakeSecurity, directItemShares] = await Promise.all([
    getLakehouseDataAccessRoles(workspaceId, rawAssignments),
    getDirectItemShares(workspaceId),
  ]);

  const assignments = await Promise.all(rawAssignments.map(async (ra) => {
    const principal = {
      id:          ra.principal.id,
      displayName: ra.principal.displayName,
      type:        ra.principal.type,    // 'User' | 'Group' | 'ServicePrincipal'
      email:       ra.principal.userPrincipalName ?? ra.principal.mail ?? undefined,
    };

    let members;
    if (ra.principal.type === 'Group') {
      const [rawMembers, auditMap] = await Promise.all([
        getGroupMembers(ra.principal.id),
        getGroupAuditDates(ra.principal.id),
      ]);

      members = rawMembers.map(m => ({
        id:          m.id,
        displayName: m.displayName,
        email:       m.userPrincipalName ?? m.mail ?? '',
        addedAt:     auditMap.get(m.id) ?? null,
        groupId:     ra.principal.id,
      }));
    }

    return { id: ra.id, role: ra.role, principal, members };
  }));

  return { assignments, oneLakeSecurity, directItemShares };
}

/**
 * Removes a user from an AD group via Graph API.
 * @param {string} groupId
 * @param {string} memberId
 * @returns {Promise<void>}
 */
async function removeMemberFromGroup(groupId, memberId) {
  const token = acquireAzToken('https://graph.microsoft.com');
  const url = `${GRAPH_BASE}/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(memberId)}/$ref`;
  const result = await jsonRequest(url, { method: 'DELETE', token });
  if (!result.ok) {
    throw new Error(`removeMemberFromGroup failed (${result.status}): ${JSON.stringify(result.data).slice(0, 300)}`);
  }
}

/**
 * Probes the Entra ID directoryAudit log to determine the effective retention
 * window by fetching the oldest available entry. Returns the number of days
 * back the logs go, or null if the audit log is inaccessible.
 *
 * @returns {Promise<number|null>}
 */
async function getAuditLogRetentionDays() {
  const token = await acquireGraphTokenViaClientCredentials();
  const params = new URLSearchParams({
    '$orderby': 'activityDateTime asc',
    '$top': '1',
    '$select': 'activityDateTime',
  });
  const url = `${GRAPH_BASE}/auditLogs/directoryAudits?${params}`;
  const result = await jsonRequest(url, { token });
  if (!result.ok) {
    console.warn(`[AccessMgmt] getAuditLogRetentionDays failed (${result.status}) — cannot determine retention`);
    return null;
  }
  const entries = result.data.value ?? [];
  if (entries.length === 0) return null;
  const oldest = new Date(entries[0].activityDateTime);
  const days = Math.floor((Date.now() - oldest.getTime()) / (1000 * 60 * 60 * 24));
  return days;
}

module.exports = { buildAccessReport, removeMemberFromGroup, getAuditLogRetentionDays };
