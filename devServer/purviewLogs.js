'use strict';

/**
 * Purview Audit Log backend
 *
 * Wraps the Microsoft Graph Security async Audit Log API
 * (POST query → poll until succeeded → paginate records).
 * Exports:
 *   queryGraphAllWorkspaceActivity(workspaceId, days?) → { entries, queryDays, partial }
 */

const https = require('https');
const { acquireGraphTokenViaClientCredentials } = require('./governlyProxy');

const GRAPH_BASE_BETA = 'https://graph.microsoft.com/beta';

/**
 * Minimal JSON-over-HTTPS helper.
 * @param {string} url
 * @param {{ method?: string; token: string; body?: object }} opts
 * @returns {Promise<{ status: number; ok: boolean; data: any; headers: object }>}
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
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data, headers: res.headers });
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
  const result = await jsonRequest(`${GRAPH_BASE_BETA}/security/auditLog/queries`, {
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
    const result = await jsonRequest(`${GRAPH_BASE_BETA}/security/auditLog/queries/${encodeURIComponent(queryId)}`, { token });
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
  let url = `${GRAPH_BASE_BETA}/security/auditLog/queries/${encodeURIComponent(queryId)}/records?$top=200`;
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
 * Normalise any Graph Security Audit Log record into a consistent entry shape.
 * Handles Power BI/Fabric events, CopilotInteraction (record type 261), and others.
 * Returns null if the record doesn't match the requested workspaceId.
 */
function normaliseToEntry(raw, workspaceId) {
  const ad = raw.auditData ?? {};

  let copilotEventData = ad.CopilotEventData ?? null;
  if (typeof copilotEventData === 'string') {
    try { copilotEventData = JSON.parse(copilotEventData); } catch {}
  }

  // Workspace ID appears in different fields depending on record type
  const wsFromAd       = (ad.WorkSpaceId ?? ad.WorkspaceId ?? '').toLowerCase();
  const resources      = copilotEventData?.AccessedResources ?? [];
  const wsFromResources = resources.map(r => (r.Id ?? '').toLowerCase());
  const wsFromObj      = (raw.objectId ?? '').toLowerCase();

  if (workspaceId) {
    const ws = workspaceId.toLowerCase();
    const matches = (wsFromAd && wsFromAd === ws)
      || wsFromResources.includes(ws)
      || (wsFromObj && wsFromObj === ws);
    if (!matches) return null;
  }

  const agents    = copilotEventData?.ParticipatingAgents ?? [];
  const agentId   = agents[0]?.AgentId   ?? ad.AgentId   ?? '';
  const agentName = agents[0]?.AgentName ?? ad.AgentName ?? '';
  const isCopilot = copilotEventData != null;

  return {
    id               : raw.id ?? `${raw.createdDateTime}-${raw.userId}-${raw.operation}`,
    createdDateTime  : raw.createdDateTime ?? '',
    userId           : raw.userId           ?? ad.UserId ?? '',
    userPrincipalName: raw.userPrincipalName ?? ad.UserId ?? '',
    workspaceId      : wsFromAd || wsFromResources[0] || workspaceId || '',
    workspaceName    : ad.WorkSpaceName ?? '',
    operationName    : raw.operation ?? ad.Activity ?? '',
    itemId           : isCopilot ? agentId : (ad.ArtifactId ?? ad.ItemId ?? ''),
    itemName         : isCopilot ? agentName : (ad.ArtifactName ?? ad.ItemName ?? ad.ReportName ?? ''),
    itemType         : isCopilot ? 'DataAgent' : (ad.ArtifactKind ?? ad.ItemKind ?? ad.ObjectType ?? ''),
    clientIP         : raw.clientIp ?? raw.clientIP ?? ad.ClientIP ?? '',
    result           : raw.resultStatus ?? raw.result ?? (ad.IsSuccess === true ? 'Succeeded' : ad.IsSuccess === false ? 'Failed' : ''),
    service          : raw.service ?? ad.Workload ?? '',
    agentId          : isCopilot ? agentId   : '',
    agentName        : isCopilot ? agentName : '',
    recordType       : raw.auditRecordType ?? ad.RecordType ?? '',
    raw              : { ...raw, auditData: { ...ad, CopilotEventData: copilotEventData } },
  };
}

/**
 * Query the Graph Security Audit Log for ALL events related to a workspace.
 * No record type filter — returns everything (CopilotInteraction/261, powerBIAudit, etc.)
 * then filters post-fetch by workspace ID across all possible field locations.
 * @param {string} workspaceId
 * @param {number} days
 * @returns {Promise<{ entries: object[]; queryDays: number; partial: boolean }>}
 */
async function queryGraphAllWorkspaceActivity(workspaceId, days = 30) {
  try {
    const token     = await acquireGraphTokenViaClientCredentials();
    const endDate   = new Date().toISOString();
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const queryId = await createAuditQuery(token, {
      displayName: `Governly-AllActivity-${Date.now()}`,
      startDate, endDate,
      // No recordTypeFilters — fetch all event types, filter by workspace below
    });

    const status = await pollAuditQuery(token, queryId, 360_000);
    if (status === 'failed') {
      console.warn('[GraphAudit] Audit query returned status=failed');
      return { entries: [], queryDays: days, partial: true };
    }

    const raw = await getAuditRecords(token, queryId);
    const recordTypes = [...new Set(raw.map(r => r.auditRecordType ?? r.service ?? 'unknown'))].sort();
    console.log(`[GraphAudit] ${raw.length} raw record(s) over ${days} days. Record types:`, recordTypes);

    const entries = raw.map(r => normaliseToEntry(r, workspaceId)).filter(Boolean);
    console.log(`[GraphAudit] ${entries.length} entries match workspace ${workspaceId}`);

    // Only mark partial if query timed out AND no records were fetched
    const partial = status === 'timeout' && raw.length === 0;
    return { entries, queryDays: days, partial };
  } catch (err) {
    console.error('[GraphAudit] queryGraphAllWorkspaceActivity error:', err.message);
    return { entries: [], queryDays: days, partial: true, error: err.message };
  }
}
module.exports = { queryGraphAllWorkspaceActivity };

