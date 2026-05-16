'use strict';

/**
 * Purview Audit Log backend
 *
 * Wraps the Microsoft Graph Security async Audit Log API
 * (POST query → poll until succeeded → paginate records).
 * Exports:
 *   queryGraphAllWorkspaceActivity(workspaceId, days?) → { entries, queryDays, partial }
 *   queryDataAgentActivity(workspaceId, days?)         → { entries, queryDays, partial }
 *   queryWorkspaceActivity(workspaceId, days?)         → { entries, queryDays, partial }
 */

const https = require('https');
const { acquireGraphTokenViaClientCredentials, acquireFabricToken } = require('./governlyProxy');

const GRAPH_BASE      = 'https://graph.microsoft.com/v1.0';
const GRAPH_BASE_BETA = 'https://graph.microsoft.com/beta';
const FABRIC_BASE = 'https://api.fabric.microsoft.com/v1';

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

/**
 * Query Fabric Admin Activity Events for data agent usage events in a workspace.
 * Uses the Fabric REST API (/admin/activityEvents) — no Graph audit log required.
 * Fabric limits each request to a 24-hour window; we loop over the requested days.
 * @param {string} workspaceId
 * @param {number} days
 * @returns {Promise<{ entries: object[]; queryDays: number; partial: boolean }>}
 */
async function queryDataAgentActivity(workspaceId, days = 7) {
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
      let chunkOk = true;
      while (url) {
        const result = await jsonRequest(url, { token });
        if (!result.ok) {
          console.warn(`[DataAgentLogs] activityEvents ${startStr} unavailable (${result.status}) — falling back to Graph Audit Log`);
          chunkOk = false;
          // 403/404 = admin permissions not available; Graph Audit Log is the fallback
          break;
        }
        const chunk = result.data.activityEventEntities ?? [];
        allEvents.push(...chunk);
        url = result.data.continuationUri ?? null;
      }
      if (!chunkOk) break;
      cursor = chunkEnd;
    }

    // Debug: log all unique operations returned
    const ops = [...new Set(allEvents.map(e => e.Activity ?? e.Operation ?? '(none)'))].sort();
    console.log(`[DataAgentLogs] ${allEvents.length} total events from API. Operations:`, ops);

    const entries = allEvents
      .filter(e => {
        const wsId = (e.WorkspaceId ?? '').toLowerCase();
        const wsMatch = !workspaceId || !wsId || wsId === workspaceId.toLowerCase();
        if (!wsMatch) return false;
        const op = (e.Activity ?? e.Operation ?? '').toLowerCase();
        const isAgentKind        = (e.ArtifactKind ?? '').toLowerCase() === 'dataagent';
        const isKnownAgent       = e.ArtifactId && agentIds.has(e.ArtifactId.toLowerCase());
        const isCopilotInteraction = op === 'copilotinteraction';
        return isAgentKind || isKnownAgent || isCopilotInteraction;
      })
      .map(e => {
        const agentId = (e.ArtifactId ?? e.AgentId ?? '');
        // CopilotEventData may be a JSON string — parse it if so
        let copilotEventData = e.CopilotEventData ?? null;
        if (typeof copilotEventData === 'string') {
          try { copilotEventData = JSON.parse(copilotEventData); } catch {}
        }
        const raw = { ...e, auditData: { ...e, CopilotEventData: copilotEventData } };
        return {
          id               : e.Id ?? `${e.CreationTime}-${agentId}`,
          createdDateTime  : e.CreationTime ?? '',
          userId           : e.UserId ?? '',
          userPrincipalName: e.UserPrincipalName ?? e.UserId ?? '',
          workspaceId      : e.WorkspaceId ?? workspaceId,
          workspaceName    : e.WorkSpaceName ?? '',
          operationName    : e.Activity ?? e.Operation ?? '',
          itemId           : agentId,
          itemName         : e.ArtifactName ?? '',
          itemType         : e.ArtifactKind ?? '',
          clientIP         : e.ClientIP ?? '',
          result           : e.IsSuccess === true ? 'Succeeded' : e.IsSuccess === false ? 'Failed' : '',
          service          : e.Workload ?? '',
          agentId,
          agentName        : agentById[agentId.toLowerCase()] ?? e.AgentName ?? e.ArtifactName ?? '',
          prompt           : '',
          completion       : '',
          tokenCount       : undefined,
          duration         : undefined,
          raw,
        };
      });

    // Also pull ALL workspace events from the Microsoft Graph Security Audit Log API
    const graphResult = await queryGraphAllWorkspaceActivity(workspaceId, days);

    // Merge + deduplicate by id (Fabric entries take precedence)
    const seen = new Set(entries.map(e => e.id));
    const merged = [...entries, ...graphResult.entries.filter(e => !seen.has(e.id))];
    merged.sort((a, b) => b.createdDateTime.localeCompare(a.createdDateTime));

    return { entries: merged, queryDays: days, partial: graphResult.partial };
  } catch (err) {
    console.error('[PurviewLogs] queryDataAgentActivity error:', err.message);
    return { entries: [], queryDays: days, partial: true, error: err.message };
  }
}

/**
 * Query Fabric Admin Activity Events for all workspace activity.
 * Uses the Fabric REST API (/admin/activityEvents) — no Graph audit log required.
 * @param {string} workspaceId
 * @param {number} days  Look-back window (max 30 for Fabric Activity Events API)
 * @returns {Promise<{ entries: object[]; queryDays: number; partial: boolean }>}
 */
async function queryWorkspaceActivity(workspaceId, days = 30) {
  try {
    const token     = acquireFabricToken();
    const endDate   = new Date();
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const allEvents = [];
    let partial     = false;

    let cursor = new Date(startDate);
    while (cursor < endDate) {
      const chunkEnd = new Date(Math.min(cursor.getTime() + 24 * 60 * 60 * 1000, endDate.getTime()));
      const startStr = cursor.toISOString();
      const endStr   = chunkEnd.toISOString();

      let url = `${FABRIC_BASE}/admin/activityEvents?startDateTime='${startStr}'&endDateTime='${endStr}'`;
      let chunkOk = true;
      while (url) {
        const result = await jsonRequest(url, { token });
        if (!result.ok) {
          console.warn(`[WorkspaceActivity] activityEvents ${startStr} failed (${result.status}):`, JSON.stringify(result.data).slice(0, 200));
          partial = true;
          chunkOk = false;
          if (result.status === 403) {
            return { entries: [], queryDays: days, partial: true, error: 'Fabric tenant admin permissions required for the Activity Events API' };
          }
          break;
        }
        const chunk = result.data.activityEventEntities ?? [];
        // Filter to the requested workspace
        const wsChunk = workspaceId
          ? chunk.filter(e => (e.WorkspaceId ?? '').toLowerCase() === workspaceId.toLowerCase())
          : chunk;
        allEvents.push(...wsChunk);
        url = result.data.continuationUri ?? null;
      }
      if (!chunkOk) break;
      cursor = chunkEnd;
    }

    console.log(`[WorkspaceActivity] ${allEvents.length} events for workspace ${workspaceId} over ${days} days`);

    const entries = allEvents.map(e => ({
      id               : e.Id ?? `${e.CreationTime}-${e.Operation ?? e.Activity ?? ''}`,
      createdDateTime  : e.CreationTime ?? '',
      userId           : e.UserId ?? '',
      userPrincipalName: e.UserPrincipalName ?? e.UserId ?? '',
      workspaceId      : e.WorkspaceId ?? workspaceId,
      workspaceName    : e.WorkSpaceName ?? '',
      operationName    : e.Activity ?? e.Operation ?? '',
      itemId           : e.ArtifactId ?? e.ItemId ?? '',
      itemName         : e.ArtifactName ?? e.ItemName ?? '',
      itemType         : e.ArtifactKind ?? e.ItemKind ?? '',
      clientIP         : e.ClientIP ?? '',
      result           : e.IsSuccess === true ? 'Succeeded' : e.IsSuccess === false ? 'Failed' : '',
      service          : e.Workload ?? '',
      raw              : e,
    }));

    return { entries, queryDays: days, partial };
  } catch (err) {
    console.error('[PurviewLogs] queryWorkspaceActivity error:', err.message);
    return { entries: [], queryDays: days, partial: true, error: err.message };
  }
}

module.exports = { queryGraphAllWorkspaceActivity, queryDataAgentActivity, queryWorkspaceActivity };
