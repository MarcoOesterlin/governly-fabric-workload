'use strict';

/**
 * Purview Audit Log backend
 *
 * Wraps the Microsoft Graph Security async Audit Log API
 * (POST query → poll until succeeded → paginate records).
 * Exports:
 *   queryFabricActivity(workspaceId, days?)    → { records, queryDays, partial }
 *   queryDataAgentActivity(workspaceId, days?) → { entries, queryDays, partial }
 * Both functions degrade gracefully — partial:true on any failure.
 */

const https = require('https');
const { acquireGraphTokenViaClientCredentials, acquireFabricToken } = require('./governlyProxy');

const GRAPH_BASE  = 'https://graph.microsoft.com/v1.0';
const FABRIC_BASE = 'https://api.fabric.microsoft.com/v1';

/**
 * Minimal JSON-over-HTTPS helper.
 * @param {string} url
 * @param {{ method?: string; token: string; body?: object }} opts
 * @returns {Promise<{ status: number; ok: boolean; data: any }>}
 */
async function jsonRequest(url, { method = 'GET', token, body } = {}) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    if (bodyStr) {
      headers['Content-Type']   = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
    }
    const reqOpts = {
      hostname : parsed.hostname,
      port     : parsed.port || 443,
      path     : parsed.pathname + (parsed.search || ''),
      method,
      headers,
    };
    const req = https.request(reqOpts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let data;
        try { data = JSON.parse(text); } catch { data = text; }
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data });
      });
    });
    req.setTimeout(30_000, () => req.destroy(new Error(`Request timed out: ${parsed.hostname}${parsed.pathname}`)));
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/**
 * Create an async Purview audit log query.
 * @returns {Promise<string>} queryId
 */
async function createAuditQuery(token, { displayName, startDate, endDate, recordTypeFilters, operationFilters }) {
  const body = {
    displayName,
    filterStartDateTime: startDate,
    filterEndDateTime:   endDate,
    ...(recordTypeFilters?.length ? { recordTypeFilters } : {}),
    ...(operationFilters?.length  ? { operationFilters  } : {}),
  };
  const result = await jsonRequest(`${GRAPH_BASE}/security/auditLog/queries`, {
    method: 'POST', token, body,
  });
  if (!result.ok) throw new Error(`createAuditQuery failed (${result.status}): ${JSON.stringify(result.data)}`);
  return result.data.id;
}

/**
 * Poll until the query status is 'succeeded', 'failed', or maxWaitMs is exceeded.
 * @returns {Promise<'succeeded'|'failed'|'timeout'>}
 */
async function pollAuditQuery(token, queryId, maxWaitMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 2_000));
    const result = await jsonRequest(`${GRAPH_BASE}/security/auditLog/queries/${encodeURIComponent(queryId)}`, { token });
    if (!result.ok) throw new Error(`pollAuditQuery failed (${result.status})`);
    const status = result.data.status;
    if (status === 'succeeded' || status === 'failed') return status;
  }
  return 'timeout';
}

/**
 * Paginate all audit records for a completed query.
 * @returns {Promise<any[]>}
 */
async function getAuditRecords(token, queryId) {
  let url = `${GRAPH_BASE}/security/auditLog/queries/${encodeURIComponent(queryId)}/records?$top=200`;
  const records = [];
  while (url) {
    const result = await jsonRequest(url, { token });
    if (!result.ok) throw new Error(`getAuditRecords failed (${result.status})`);
    records.push(...(result.data.value ?? []));
    url = result.data['@odata.nextLink'] ?? null;
  }
  return records;
}

/**
 * Fetch all data agents from the Fabric API for a workspace.
 * Returns [] on any error (graceful degradation).
 */
async function listDataAgents(workspaceId) {
  try {
    const token = acquireFabricToken(); // synchronous
    const result = await jsonRequest(
      `${FABRIC_BASE}/workspaces/${encodeURIComponent(workspaceId)}/dataAgents`,
      { token }
    );
    return result.ok ? (result.data.value ?? []) : [];
  } catch (e) {
    console.warn('[PurviewLogs] listDataAgents failed:', e.message);
    return [];
  }
}

/**
 * Flatten an audit log record into a consistent shape.
 * auditData keys vary by operation; we read the common Power BI/Fabric fields.
 */
function normaliseRecord(raw) {
  const ad = raw.auditData ?? {};
  return {
    id                : raw.id,
    createdDateTime   : raw.createdDateTime,
    userId            : raw.userId ?? ad.UserId ?? '',
    userPrincipalName : raw.userPrincipalName ?? ad.UserPrincipalName ?? ad.UserId ?? '',
    operationName     : raw.operation ?? '',
    service           : raw.service ?? '',
    objectId          : raw.objectId ?? '',
    workspaceId       : ad.WorkSpaceId ?? ad.WorkspaceId ?? '',
    itemName          : ad.ArtifactName ?? ad.ItemName ?? ad.ReportName ?? '',
    itemType          : ad.ArtifactKind ?? ad.ItemKind ?? ad.ObjectType ?? '',
    itemId            : ad.ArtifactId   ?? ad.ItemId   ?? '',
    clientIP          : raw.clientIp    ?? raw.clientIP ?? '',
    userAgent         : raw.userAgent   ?? '',
    result            : raw.resultStatus ?? raw.result ?? '',
    additionalDetails : raw.additionalDetails ?? [],
  };
}

// 'GetItem' intentionally omitted — fires on every read, not just sharing/export events
const FABRIC_OPERATIONS = [
  'ExportArtifact', 'ExportDataflow', 'ShareReport', 'ShareDashboard',
  'DownloadReport', 'PublishToWebReport', 'ExportReport', 'SendEmailToConsumer',
  'CreateOrgApp', 'ExportItem', 'ShareItem',
];

/**
 * Query Purview audit logs for Fabric sharing/export events in a workspace.
 * @param {string} workspaceId
 * @param {number} days  Look-back window (default 30)
 * @returns {Promise<{ records: object[]; queryDays: number; partial: boolean }>}
 */
async function queryFabricActivity(workspaceId, days = 30) {
  try {
    const token     = await acquireGraphTokenViaClientCredentials();
    const endDate   = new Date().toISOString();
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const queryId = await createAuditQuery(token, {
      displayName      : `Governly-FabricActivity-${Date.now()}`,
      startDate, endDate,
      recordTypeFilters: ['powerBIAudit'],
      operationFilters : FABRIC_OPERATIONS,
    });

    const status = await pollAuditQuery(token, queryId, 60_000);
    if (status === 'failed') {
      console.warn('[PurviewLogs] Audit query failed (status=failed)');
      return { records: [], queryDays: days, partial: true };
    }

    const raw     = await getAuditRecords(token, queryId);
    const records = raw
      .map(normaliseRecord)
      .filter(r => !workspaceId || !r.workspaceId || r.workspaceId.toLowerCase() === workspaceId.toLowerCase());

    return { records, queryDays: days, partial: status === 'timeout' };
  } catch (err) {
    // Surface as partial=true so the UI can show a warning instead of crashing
    console.error('[PurviewLogs] queryFabricActivity error:', err.message);
    return { records: [], queryDays: days, partial: true, error: err.message };
  }
}

/**
 * Query Fabric Admin Activity Events for data agent usage events in a workspace.
 * Uses the Fabric REST API (/admin/activityEvents) — no Graph audit log required.
 * Fabric limits each request to a 24-hour window; we loop over the requested days.
 * @param {string} workspaceId
 * @param {number} days
 * @returns {Promise<{ entries: object[]; queryDays: number; partial: boolean }>}
 */
async function queryDataAgentActivity(workspaceId, days = 30) {
  try {
    const token = acquireFabricToken();

    const [agents] = await Promise.all([listDataAgents(workspaceId)]);
    const agentIds  = new Set(agents.filter(a => a.id).map(a => a.id.toLowerCase()));
    const agentById = Object.fromEntries(
      agents.filter(a => a.id).map(a => [a.id.toLowerCase(), a.displayName])
    );

    // Fabric activity events API supports max 1-day window per request
    const endDate   = new Date();
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const allEvents = [];
    let partial     = false;

    let cursor = new Date(startDate);
    while (cursor < endDate) {
      const chunkEnd = new Date(Math.min(cursor.getTime() + 24 * 60 * 60 * 1000, endDate.getTime()));
      // Fabric requires single-quoted ISO strings in the query string
      const startStr = cursor.toISOString();
      const endStr   = chunkEnd.toISOString();

      let url = `${FABRIC_BASE}/admin/activityEvents?startDateTime='${startStr}'&endDateTime='${endStr}'`;
      while (url) {
        const result = await jsonRequest(url, { token });
        if (!result.ok) {
          console.warn(`[DataAgentLogs] activityEvents ${startStr} failed (${result.status}):`, JSON.stringify(result.data).slice(0, 200));
          partial = true;
          break;
        }
        allEvents.push(...(result.data.activityEventEntities ?? []));
        url = result.data.continuationUri ?? null;
      }
      cursor = chunkEnd;
    }

    const entries = allEvents
      .filter(e => {
        const wsId = (e.WorkspaceId ?? '').toLowerCase();
        const wsMatch = !workspaceId || !wsId || wsId === workspaceId.toLowerCase();
        if (!wsMatch) return false;
        const isAgentKind  = (e.ArtifactKind ?? '').toLowerCase() === 'dataagent';
        const isKnownAgent = e.ArtifactId && agentIds.has(e.ArtifactId.toLowerCase());
        return isAgentKind || isKnownAgent;
      })
      .map(e => {
        const agentId = (e.ArtifactId ?? '');
        return {
          id               : e.Id ?? `${e.CreationTime}-${agentId}`,
          createdDateTime  : e.CreationTime,
          userId           : e.UserId ?? '',
          userPrincipalName: e.UserPrincipalName ?? e.UserId ?? '',
          workspaceId      : e.WorkspaceId ?? workspaceId,
          operationName    : e.Activity ?? e.Operation ?? '',
          itemId           : agentId,
          itemName         : e.ArtifactName ?? '',
          agentId,
          agentName        : agentById[agentId.toLowerCase()] ?? e.ArtifactName ?? '',
          prompt           : '',
          completion       : '',
          tokenCount       : undefined,
          duration         : undefined,
        };
      });

    return { entries, queryDays: days, partial };
  } catch (err) {
    console.error('[PurviewLogs] queryDataAgentActivity error:', err.message);
    return { entries: [], queryDays: days, partial: true, error: err.message };
  }
}

module.exports = { queryFabricActivity, queryDataAgentActivity };
