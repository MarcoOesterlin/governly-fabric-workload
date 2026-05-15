'use strict';

/**
 * Access Management backend
 *
 * Fetches workspace role assignments (Fabric API), expands AD group members
 * (Graph API), and correlates with audit logs to determine when each member
 * was added. Exposes buildAccessReport() and removeMemberFromGroup().
 */

const https = require('https');
const { acquireGraphTokenViaClientCredentials, acquireFabricToken } = require('./governlyProxy');

const GRAPH_BASE    = 'https://graph.microsoft.com/v1.0';
const FABRIC_BASE   = 'https://api.fabric.microsoft.com/v1';

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
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/**
 * Returns raw Fabric workspace role assignments.
 * @param {string} workspaceId
 * @returns {Promise<Array<{id,role,principal:{id,displayName,type,userPrincipalName}}>>}
 */
async function getWorkspaceRoles(workspaceId) {
  const token = acquireFabricToken();
  const url = `${FABRIC_BASE}/workspaces/${encodeURIComponent(workspaceId)}/roleAssignments`;
  const result = await jsonRequest(url, { token });
  if (!result.ok) {
    throw new Error(`Fabric roleAssignments failed (${result.status}): ${JSON.stringify(result.data).slice(0, 300)}`);
  }
  return result.data.value ?? [];
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
 * Builds the full access report for a workspace.
 * For each Group assignment, expands members and correlates with audit dates.
 *
 * @param {string} workspaceId
 * @returns {Promise<{ assignments: Array }>}
 */
async function buildAccessReport(workspaceId) {
  const rawAssignments = await getWorkspaceRoles(workspaceId);

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

  return { assignments };
}

/**
 * Removes a user from an AD group via Graph API.
 * @param {string} groupId
 * @param {string} memberId
 * @returns {Promise<void>}
 */
async function removeMemberFromGroup(groupId, memberId) {
  const token = await acquireGraphTokenViaClientCredentials();
  const url = `${GRAPH_BASE}/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(memberId)}/$ref`;
  const result = await jsonRequest(url, { method: 'DELETE', token });
  if (!result.ok) {
    throw new Error(`removeMemberFromGroup failed (${result.status}): ${JSON.stringify(result.data).slice(0, 300)}`);
  }
}

module.exports = { buildAccessReport, removeMemberFromGroup };
