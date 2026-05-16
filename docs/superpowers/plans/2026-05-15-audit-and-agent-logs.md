# Audit & Data Agent Logs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two read-only log pages to Governly — a Purview Audit Logs page showing all Fabric sharing/export events in the workspace, and a Data Agent Logs page showing AI agent usage events.

**Architecture:** A shared backend module (`devServer/purviewLogs.js`) wraps the Microsoft Graph Security Audit Log API (async query → poll → paginate records). Both views reuse this module with different operation filters. Graceful degradation when `AuditLog.Read.All` is not consented — views show a warning rather than crashing.

**Tech Stack:** Node.js `https` module (backend), Microsoft Graph `/v1.0/security/auditLog/queries` (Purview), Fabric REST API `/v1/workspaces/{id}/dataAgents` (agent list), React + Fluent UI v9, TypeScript.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `devServer/purviewLogs.js` | **Create** | All Graph Security Audit Log API logic; exports `queryFabricActivity`, `queryDataAgentActivity` |
| `devServer/index.js` | **Modify** | Register `GET /api/audit/fabric-activity` and `GET /api/audit/data-agent-logs` |
| `app/clients/GovernlyApiClient.ts` | **Modify** | `AuditRecord`, `FabricAuditReport`, `DataAgentLogEntry`, `DataAgentLogsReport` interfaces; `getFabricAuditLogs`, `getDataAgentLogs` methods |
| `app/items/GovernlyItem/views/PurviewAuditView.tsx` | **Create** | Fabric activity audit log page (sharing/export events) |
| `app/items/GovernlyItem/views/DataAgentLogsView.tsx` | **Create** | Data agent usage log page |
| `app/items/GovernlyItem/GovernlyItemEditor.tsx` | **Modify** | Add `'audit'` and `'agent-logs'` ViewKeys, nav tabs, render cases |

---

## Task 1: `devServer/purviewLogs.js` — Purview Audit Log Backend

**Files:**
- Create: `devServer/purviewLogs.js`

### Background: Graph Security Audit Log API

The API is **async**:
1. `POST /v1.0/security/auditLog/queries` — create query (returns immediately with a query object)
2. `GET /v1.0/security/auditLog/queries/{id}` — poll until `status === 'succeeded'` (or `'failed'`)
3. `GET /v1.0/security/auditLog/queries/{id}/records` — paginate records with `@odata.nextLink`

Permission required: `AuditLog.Read.All` (already acquired by `acquireGraphTokenViaClientCredentials` for directoryAudits in `accessManagement.js`).

For Power BI / Fabric operations, the relevant record type filter is `powerBIAudit`. The audit records include an `auditData` object that contains workspace and artifact metadata.

**auditData field names (Power BI / Fabric):**
- `WorkSpaceId` — workspace GUID (use this for client-side workspace filtering)
- `ArtifactName` — item name
- `ArtifactKind` — item type (Report, Dashboard, Dataset, DataAgent, etc.)
- `ArtifactId` — item GUID

Sharing/export operations to query for the Fabric Activity page:
`ExportArtifact`, `ExportDataflow`, `ShareReport`, `ShareDashboard`, `DownloadReport`, `PublishToWebReport`, `ExportReport`, `SendEmailToConsumer`, `CreateOrgApp`, `GetItem`, `ExportItem`, `ShareItem`

Data agent operations to query (broad — filter client-side):
`CreateDataAgent`, `RunDataAgent`, `QueryDataAgent`, `DataAgentQuery`, `AIQueryDataAgent`, `SubmitDataAgentQuery`, `CreateDataAgentConversation`

Since data agent operation names are not guaranteed stable, `queryDataAgentActivity` also accepts all `powerBIAudit` records and client-side filters for agent-related activity by matching `ArtifactKind` containing "Agent" or "AI", OR objectId matching known agent IDs.

- [ ] **Step 1: Create the file with dependencies and `jsonRequest` helper**

```js
'use strict';

const https = require('https');
const { acquireGraphTokenViaClientCredentials, acquireFabricToken } = require('./governlyProxy');

const GRAPH_BASE  = 'https://graph.microsoft.com/v1.0';
const FABRIC_BASE = 'https://api.fabric.microsoft.com/v1';

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
      req.setTimeout(30_000, () => req.destroy(new Error(`Request timed out: ${parsed.hostname}${parsed.pathname}`)));
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('error', reject);
      res.on('end', () => {
        let data;
        try { data = JSON.parse(raw); } catch { data = raw; }
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data });
      });
    });
    req.setTimeout(30_000, () => req.destroy(new Error(`Request timed out: ${parsed.hostname}${parsed.pathname}`)));
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}
```

- [ ] **Step 2: Add `createAuditQuery`, `pollAuditQuery`, `getAuditRecords` helpers**

```js
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
```

- [ ] **Step 3: Add `listDataAgents` helper and `normaliseRecord` helper**

```js
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
    id              : raw.id,
    createdDateTime : raw.createdDateTime,
    userId          : raw.userId ?? ad.UserId ?? '',
    operation       : raw.operation ?? '',
    service         : raw.service ?? '',
    objectId        : raw.objectId ?? '',
    workspaceId     : ad.WorkSpaceId ?? ad.WorkspaceId ?? '',
    itemName        : ad.ArtifactName ?? ad.ItemName ?? ad.ReportName ?? '',
    itemType        : ad.ArtifactKind ?? ad.ItemKind ?? ad.ObjectType ?? '',
    itemId          : ad.ArtifactId   ?? ad.ItemId   ?? '',
  };
}
```

- [ ] **Step 4: Add `queryFabricActivity` (exported)**

```js
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
```

- [ ] **Step 5: Add `queryDataAgentActivity` (exported)**

```js
/**
 * Query Purview audit logs for data agent usage events in a workspace.
 * Also uses listDataAgents() to filter records whose objectId matches a known agent ID.
 * @param {string} workspaceId
 * @param {number} days
 * @returns {Promise<{ entries: object[]; queryDays: number; partial: boolean }>}
 */
async function queryDataAgentActivity(workspaceId, days = 30) {
  try {
    const token     = await acquireGraphTokenViaClientCredentials();
    const endDate   = new Date().toISOString();
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    // Fetch agent list in parallel with query creation (both are independent)
    const [queryId, agents] = await Promise.all([
      createAuditQuery(token, {
        displayName      : `Governly-DataAgentLogs-${Date.now()}`,
        startDate, endDate,
        recordTypeFilters: ['powerBIAudit'],
        // Broad — we filter client-side since operation names may vary
      }),
      listDataAgents(workspaceId),
    ]);

    const agentIds  = new Set(agents.map(a => (a.id ?? '').toLowerCase()));
    const agentById = Object.fromEntries(agents.map(a => [a.id?.toLowerCase(), a.displayName]));

    const status = await pollAuditQuery(token, queryId, 60_000);
    if (status === 'failed') {
      return { entries: [], queryDays: days, partial: true };
    }

    const raw = await getAuditRecords(token, queryId);
    const entries = raw
      .map(normaliseRecord)
      .filter(r => {
        // Keep if workspace matches (or no workspace filter in auditData)
        const wsMatch = !workspaceId || !r.workspaceId || r.workspaceId.toLowerCase() === workspaceId.toLowerCase();
        if (!wsMatch) return false;
        // Keep if matches a known agent ID, or operation/type looks agent-related
        const agentMatch  = r.itemId  && agentIds.has(r.itemId.toLowerCase());
        const objMatch    = r.objectId && agentIds.has(r.objectId.toLowerCase());
        const nameMatch   = /agent|ai/i.test(r.itemType) || /agent|ai/i.test(r.operation);
        return agentMatch || objMatch || nameMatch;
      })
      .map(r => ({
        ...r,
        agentId  : r.itemId   || r.objectId || '',
        agentName: agentById[(r.itemId  || r.objectId || '').toLowerCase()] ?? r.itemName ?? '',
      }));

    return { entries, queryDays: days, partial: status === 'timeout' };
  } catch (err) {
    console.error('[PurviewLogs] queryDataAgentActivity error:', err.message);
    return { entries: [], queryDays: days, partial: true, error: err.message };
  }
}
```

- [ ] **Step 6: Add exports and smoke test**

At the end of the file:
```js
module.exports = { queryFabricActivity, queryDataAgentActivity };
```

Run from repo root:
```bash
node -e "const m = require('./devServer/purviewLogs'); console.log(typeof m.queryFabricActivity, typeof m.queryDataAgentActivity)"
```
Expected output: `function function`

- [ ] **Step 7: Commit**

```bash
git add devServer/purviewLogs.js
git commit -m "feat(audit-logs): add purviewLogs backend module

- createAuditQuery / pollAuditQuery / getAuditRecords helpers (Graph Security API)
- queryFabricActivity: Fabric sharing/export events, workspace-filtered
- queryDataAgentActivity: agent usage events, cross-matched with Fabric dataAgents list
- All errors degrade gracefully (partial: true) instead of throwing

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: Register Routes in `devServer/index.js`

**Files:**
- Modify: `devServer/index.js`

The routes follow the same pattern as the existing access management routes (lines 116–138). Add `require` at line ~14 and two new routes before `registerDqRoutes(app)` at line ~141.

- [ ] **Step 1: Add `require` at top**

After the existing requires (around line 13), add:
```js
const purviewLogs = require('./purviewLogs');
```

- [ ] **Step 2: Add `GET /api/audit/fabric-activity` route**

Insert before `console.log('*** Mounting Governly DQ Routes ***')`:
```js
app.get('/api/audit/fabric-activity', async (req, res) => {
  const { workspaceId, days } = req.query;
  if (!workspaceId) return res.status(400).json({ error: 'Query param "workspaceId" is required.' });
  try {
    const report = await purviewLogs.queryFabricActivity(workspaceId, days ? Number(days) : 30);
    res.json(report);
  } catch (err) {
    console.error('[FabricAudit] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 3: Add `GET /api/audit/data-agent-logs` route**

```js
app.get('/api/audit/data-agent-logs', async (req, res) => {
  const { workspaceId, days } = req.query;
  if (!workspaceId) return res.status(400).json({ error: 'Query param "workspaceId" is required.' });
  try {
    const report = await purviewLogs.queryDataAgentActivity(workspaceId, days ? Number(days) : 30);
    res.json(report);
  } catch (err) {
    console.error('[DataAgentLogs] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 4: Smoke test module loads**

```bash
node -e "require('./devServer/index')" 2>&1 | Select-Object -First 5
```
Expected: no require errors (env var warnings are fine).

- [ ] **Step 5: Commit**

```bash
git add devServer/index.js
git commit -m "feat(audit-logs): register /api/audit/fabric-activity and /api/audit/data-agent-logs routes

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: TypeScript Types + Client Methods

**Files:**
- Modify: `app/clients/GovernlyApiClient.ts`

Add interfaces after the `WorkspaceAccessReport` block (around line 134) and two methods in a new `// ── Audit Logs` section after `revokeGroupMember` (around line 502).

- [ ] **Step 1: Add interfaces after `WorkspaceAccessReport`**

```typescript
export interface AuditRecord {
  id: string;
  createdDateTime: string;   // ISO-8601
  userId: string;            // user email/UPN
  operation: string;
  service: string;
  objectId: string;
  workspaceId: string;
  itemName: string;
  itemType: string;
  itemId: string;
}

export interface FabricAuditReport {
  records: AuditRecord[];
  queryDays: number;
  partial: boolean;          // true if AuditLog.Read.All not consented or timed out
  error?: string;
}

export interface DataAgentLogEntry extends AuditRecord {
  agentId: string;
  agentName: string;
}

export interface DataAgentLogsReport {
  entries: DataAgentLogEntry[];
  queryDays: number;
  partial: boolean;
  error?: string;
}
```

- [ ] **Step 2: Add client methods after `revokeGroupMember`**

```typescript
// ── Audit Logs ───────────────────────────────────────────────────────────────

async getFabricAuditLogs(workspaceId: string, days = 30): Promise<FabricAuditReport> {
  const qs = new URLSearchParams({ workspaceId, days: String(days) });
  const resp = await fetch(`/api/audit/fabric-activity?${qs}`);
  if (!resp.ok) throw new Error(`getFabricAuditLogs failed (${resp.status}): ${await resp.text()}`);
  return resp.json() as Promise<FabricAuditReport>;
}

async getDataAgentLogs(workspaceId: string, days = 30): Promise<DataAgentLogsReport> {
  const qs = new URLSearchParams({ workspaceId, days: String(days) });
  const resp = await fetch(`/api/audit/data-agent-logs?${qs}`);
  if (!resp.ok) throw new Error(`getDataAgentLogs failed (${resp.status}): ${await resp.text()}`);
  return resp.json() as Promise<DataAgentLogsReport>;
}
```

- [ ] **Step 3: TypeScript check**

```bash
npx tsc --noEmit
```
Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add app/clients/GovernlyApiClient.ts
git commit -m "feat(audit-logs): add audit log TypeScript interfaces and client methods

- AuditRecord, FabricAuditReport, DataAgentLogEntry, DataAgentLogsReport interfaces
- GovernlyApiClient.getFabricAuditLogs() and getDataAgentLogs() methods

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 4: `PurviewAuditView.tsx` — Fabric Activity Page

**Files:**
- Create: `app/items/GovernlyItem/views/PurviewAuditView.tsx`

Reference patterns from `AccessManagementView.tsx` (same repo) for layout, loading/error/empty states, and inline styling.

- [ ] **Step 1: Create the file**

```typescript
import React, { useCallback, useEffect, useState } from 'react';
import {
  Button,
  MessageBar,
  MessageBarBody,
  Spinner,
  Text,
  tokens,
} from '@fluentui/react-components';
import { ArrowClockwise24Regular } from '@fluentui/react-icons';
import { GovernlyApiClient, FabricAuditReport, AuditRecord } from '../../../clients/GovernlyApiClient';

interface PurviewAuditViewProps {
  workspaceId: string;
  client: GovernlyApiClient;
}

const OPERATION_COLORS: Record<string, { bg: string; fg: string }> = {
  ExportArtifact    : { bg: '#fff3e0', fg: '#c25600' },
  ExportReport      : { bg: '#fff3e0', fg: '#c25600' },
  ExportDataflow    : { bg: '#fff3e0', fg: '#c25600' },
  DownloadReport    : { bg: '#fff3e0', fg: '#c25600' },
  ShareReport       : { bg: '#dce6f8', fg: '#0f52ba' },
  ShareDashboard    : { bg: '#dce6f8', fg: '#0f52ba' },
  ShareItem         : { bg: '#dce6f8', fg: '#0f52ba' },
  PublishToWebReport: { bg: '#fde8e8', fg: '#c50f1f' },
  SendEmailToConsumer: { bg: '#fde8e8', fg: '#c50f1f' },
};

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

const OperationBadge: React.FC<{ operation: string }> = ({ operation }) => {
  const { bg, fg } = OPERATION_COLORS[operation] ?? { bg: '#f0f0f0', fg: '#444' };
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 4,
      backgroundColor: bg, color: fg, fontSize: 11, fontWeight: 600,
      whiteSpace: 'nowrap',
    }}>
      {operation}
    </span>
  );
};

const DAY_OPTIONS = [7, 14, 30, 60, 90];

export const PurviewAuditView: React.FC<PurviewAuditViewProps> = ({ workspaceId, client }) => {
  const [report, setReport]   = useState<FabricAuditReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [days, setDays]       = useState(30);
  const [filterOp, setFilterOp] = useState('');

  const loadReport = useCallback(async (d: number) => {
    setLoading(true);
    setError(null);
    try {
      const data = await client.getFabricAuditLogs(workspaceId, d);
      setReport(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [client, workspaceId]);

  useEffect(() => { loadReport(days); }, [loadReport, days]);

  const handleRefresh = useCallback(() => loadReport(days), [loadReport, days]);

  const uniqueOps = Array.from(new Set((report?.records ?? []).map(r => r.operation))).sort();
  const filtered  = (report?.records ?? []).filter(r => !filterOp || r.operation === filterOp);

  const thStyle: React.CSSProperties = {
    textAlign: 'left', padding: '6px 10px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    fontSize: 12, fontWeight: 600, color: tokens.colorNeutralForeground3,
    whiteSpace: 'nowrap',
  };
  const tdStyle: React.CSSProperties = {
    padding: '8px 10px', fontSize: 13,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    verticalAlign: 'middle',
  };

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Text size={500} weight="semibold">Fabric Activity Log</Text>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>Last</Text>
          <select
            value={days}
            onChange={e => setDays(Number(e.target.value))}
            style={{ fontSize: 13, padding: '2px 6px', borderRadius: 4, border: `1px solid ${tokens.colorNeutralStroke1}` }}
          >
            {DAY_OPTIONS.map(d => <option key={d} value={d}>{d} days</option>)}
          </select>
          <Button icon={<ArrowClockwise24Regular />} onClick={handleRefresh} appearance="subtle" aria-label="Refresh" />
        </div>
      </div>

      {/* Partial / consent warning */}
      {report?.partial && (
        <MessageBar intent="warning">
          <MessageBarBody>
            {report.error
              ? `Audit log query failed: ${report.error}. Ensure AuditLog.Read.All is consented.`
              : 'Results may be incomplete — the audit query timed out or AuditLog.Read.All is not yet consented.'}
          </MessageBarBody>
        </MessageBar>
      )}

      {/* Loading */}
      {loading && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
          <Spinner label="Querying Purview audit logs…" />
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      {/* Empty */}
      {!loading && !error && report && report.records.length === 0 && (
        <Text style={{ color: tokens.colorNeutralForeground3 }}>
          No sharing or export events found for this workspace in the last {days} days.
        </Text>
      )}

      {/* Filter + Table */}
      {!loading && !error && report && report.records.length > 0 && (
        <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>Filter by operation:</Text>
            <select
              value={filterOp}
              onChange={e => setFilterOp(e.target.value)}
              style={{ fontSize: 13, padding: '2px 6px', borderRadius: 4, border: `1px solid ${tokens.colorNeutralStroke1}` }}
            >
              <option value="">All ({report.records.length})</option>
              {uniqueOps.map(op => (
                <option key={op} value={op}>{op} ({report.records.filter(r => r.operation === op).length})</option>
              ))}
            </select>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  {['Time', 'User', 'Operation', 'Item', 'Type'].map(h => (
                    <th key={h} style={thStyle}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(record => (
                  <tr key={record.id} style={{ transition: 'background 0.1s' }}
                    onMouseEnter={e => (e.currentTarget.style.background = tokens.colorNeutralBackground2)}
                    onMouseLeave={e => (e.currentTarget.style.background = '')}>
                    <td style={{ ...tdStyle, whiteSpace: 'nowrap', color: tokens.colorNeutralForeground3 }}>
                      {formatDateTime(record.createdDateTime)}
                    </td>
                    <td style={tdStyle}>{record.userId}</td>
                    <td style={tdStyle}><OperationBadge operation={record.operation} /></td>
                    <td style={tdStyle}>{record.itemName || record.objectId || '—'}</td>
                    <td style={{ ...tdStyle, color: tokens.colorNeutralForeground3 }}>{record.itemType || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
            Showing {filtered.length} of {report.records.length} event{report.records.length !== 1 ? 's' : ''}
          </Text>
        </>
      )}
    </div>
  );
};
```

- [ ] **Step 2: TypeScript check**

```bash
npx tsc --noEmit
```
Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add app/items/GovernlyItem/views/PurviewAuditView.tsx
git commit -m "feat(audit-logs): implement PurviewAuditView component

- Fabric sharing/export event table with operation color badges
- Day-range selector (7/14/30/60/90 days) with refresh button
- Operation filter dropdown
- Partial-results warning when AuditLog.Read.All not consented or query timed out
- Loading/error/empty states

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 5: `DataAgentLogsView.tsx` — Data Agent Logs Page

**Files:**
- Create: `app/items/GovernlyItem/views/DataAgentLogsView.tsx`

Same structural pattern as `PurviewAuditView.tsx` — loading/error/empty states, day selector, table. Uses `DataAgentLogsReport` and `DataAgentLogEntry` from `GovernlyApiClient.ts`.

- [ ] **Step 1: Create the file**

```typescript
import React, { useCallback, useEffect, useState } from 'react';
import {
  Button,
  MessageBar,
  MessageBarBody,
  Spinner,
  Text,
  tokens,
} from '@fluentui/react-components';
import { ArrowClockwise24Regular } from '@fluentui/react-icons';
import { GovernlyApiClient, DataAgentLogsReport, DataAgentLogEntry } from '../../../clients/GovernlyApiClient';

interface DataAgentLogsViewProps {
  workspaceId: string;
  client: GovernlyApiClient;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

const DAY_OPTIONS = [7, 14, 30, 60, 90];

export const DataAgentLogsView: React.FC<DataAgentLogsViewProps> = ({ workspaceId, client }) => {
  const [report, setReport]   = useState<DataAgentLogsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [days, setDays]       = useState(30);
  const [filterAgent, setFilterAgent] = useState('');

  const loadReport = useCallback(async (d: number) => {
    setLoading(true);
    setError(null);
    try {
      const data = await client.getDataAgentLogs(workspaceId, d);
      setReport(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [client, workspaceId]);

  useEffect(() => { loadReport(days); }, [loadReport, days]);

  const handleRefresh = useCallback(() => loadReport(days), [loadReport, days]);

  const uniqueAgents = Array.from(new Set((report?.entries ?? []).map(e => e.agentName || e.agentId).filter(Boolean))).sort();
  const filtered     = (report?.entries ?? []).filter(e =>
    !filterAgent || e.agentName === filterAgent || e.agentId === filterAgent
  );

  const thStyle: React.CSSProperties = {
    textAlign: 'left', padding: '6px 10px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    fontSize: 12, fontWeight: 600, color: tokens.colorNeutralForeground3,
    whiteSpace: 'nowrap',
  };
  const tdStyle: React.CSSProperties = {
    padding: '8px 10px', fontSize: 13,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    verticalAlign: 'middle',
  };

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Text size={500} weight="semibold">Data Agent Logs</Text>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>Last</Text>
          <select
            value={days}
            onChange={e => setDays(Number(e.target.value))}
            style={{ fontSize: 13, padding: '2px 6px', borderRadius: 4, border: `1px solid ${tokens.colorNeutralStroke1}` }}
          >
            {DAY_OPTIONS.map(d => <option key={d} value={d}>{d} days</option>)}
          </select>
          <Button icon={<ArrowClockwise24Regular />} onClick={handleRefresh} appearance="subtle" aria-label="Refresh" />
        </div>
      </div>

      {/* Partial / consent warning */}
      {report?.partial && (
        <MessageBar intent="warning">
          <MessageBarBody>
            {report.error
              ? `Data agent log query failed: ${report.error}. Ensure AuditLog.Read.All is consented.`
              : 'Results may be incomplete — the audit query timed out or AuditLog.Read.All is not yet consented.'}
          </MessageBarBody>
        </MessageBar>
      )}

      {/* Loading */}
      {loading && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
          <Spinner label="Querying data agent activity…" />
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      {/* Empty */}
      {!loading && !error && report && report.entries.length === 0 && (
        <Text style={{ color: tokens.colorNeutralForeground3 }}>
          No data agent activity found in audit logs for this workspace in the last {days} days.
          {' '}This may mean AuditLog.Read.All is not yet consented, or the agent has not been used recently.
        </Text>
      )}

      {/* Filter + Table */}
      {!loading && !error && report && report.entries.length > 0 && (
        <>
          {uniqueAgents.length > 1 && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>Filter by agent:</Text>
              <select
                value={filterAgent}
                onChange={e => setFilterAgent(e.target.value)}
                style={{ fontSize: 13, padding: '2px 6px', borderRadius: 4, border: `1px solid ${tokens.colorNeutralStroke1}` }}
              >
                <option value="">All agents ({report.entries.length})</option>
                {uniqueAgents.map(a => (
                  <option key={a} value={a}>
                    {a} ({report.entries.filter(e => e.agentName === a || e.agentId === a).length})
                  </option>
                ))}
              </select>
            </div>
          )}
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  {['Time', 'User', 'Agent', 'Operation'].map(h => (
                    <th key={h} style={thStyle}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(entry => (
                  <tr key={entry.id}
                    onMouseEnter={e => (e.currentTarget.style.background = tokens.colorNeutralBackground2)}
                    onMouseLeave={e => (e.currentTarget.style.background = '')}>
                    <td style={{ ...tdStyle, whiteSpace: 'nowrap', color: tokens.colorNeutralForeground3 }}>
                      {formatDateTime(entry.createdDateTime)}
                    </td>
                    <td style={tdStyle}>{entry.userId}</td>
                    <td style={tdStyle}>
                      <span style={{ fontWeight: 500 }}>{entry.agentName || '—'}</span>
                      {entry.agentId && (
                        <div style={{ fontSize: 11, color: tokens.colorNeutralForeground3 }}>{entry.agentId}</div>
                      )}
                    </td>
                    <td style={{ ...tdStyle, color: tokens.colorNeutralForeground3 }}>{entry.operation || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
            Showing {filtered.length} of {report.entries.length} event{report.entries.length !== 1 ? 's' : ''}
          </Text>
        </>
      )}
    </div>
  );
};
```

- [ ] **Step 2: TypeScript check**

```bash
npx tsc --noEmit
```
Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add app/items/GovernlyItem/views/DataAgentLogsView.tsx
git commit -m "feat(audit-logs): implement DataAgentLogsView component

- Data agent usage log table from Purview audit logs
- Agent filter dropdown when multiple agents present
- Day-range selector with refresh
- Partial-results warning with helpful message for empty/unconsented state
- Loading/error/empty states

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 6: Wire Both Views into `GovernlyItemEditor.tsx`

**Files:**
- Modify: `app/items/GovernlyItem/GovernlyItemEditor.tsx`

Current state (after Access Management):
- Line 5–14: icon imports from `@fluentui/react-icons`
- Line 27: `GovernlyApiClient` import
- Line 32: `AccessManagementView` import (last view import)
- Line 38: `type ViewKey = 'items' | 'data-quality' | 'access'`
- Lines 47–51: `NAV_ITEMS` (3 entries)
- Lines 244–265: `renderContent` switch (3 cases)

- [ ] **Step 1: Add icon imports**

Add `DocumentSearch24Regular` and `ChatBubblesQuestion24Regular` to the existing `@fluentui/react-icons` import block (lines 5–14).

- [ ] **Step 2: Add view imports**

After `import { AccessManagementView } from './views/AccessManagementView';`, add:
```typescript
import { PurviewAuditView }    from './views/PurviewAuditView';
import { DataAgentLogsView }   from './views/DataAgentLogsView';
```

- [ ] **Step 3: Extend `ViewKey`**

```typescript
type ViewKey = 'items' | 'data-quality' | 'access' | 'audit' | 'agent-logs';
```

- [ ] **Step 4: Add entries to `NAV_ITEMS`**

After the `'access'` entry:
```typescript
{ key: 'audit',      labelKey: 'Nav_Audit',      defaultLabel: 'Fabric Activity',  icon: <DocumentSearch24Regular /> },
{ key: 'agent-logs', labelKey: 'Nav_AgentLogs',  defaultLabel: 'Agent Logs',       icon: <ChatBubblesQuestion24Regular /> },
```

- [ ] **Step 5: Add cases to `renderContent`**

After the `case 'access'` block and before `default`:
```typescript
case 'audit':
  return <PurviewAuditView workspaceId={workspaceId ?? ''} client={apiClient} />;
case 'agent-logs':
  return <DataAgentLogsView workspaceId={workspaceId ?? ''} client={apiClient} />;
```

- [ ] **Step 6: TypeScript check**

```bash
npx tsc --noEmit
```
Expected: zero errors.

- [ ] **Step 7: Commit**

```bash
git add app/items/GovernlyItem/GovernlyItemEditor.tsx
git commit -m "feat(audit-logs): add Fabric Activity and Agent Logs tabs to GovernlyItemEditor

- DocumentSearch24Regular and ChatBubblesQuestion24Regular icon imports
- PurviewAuditView and DataAgentLogsView view imports
- 'audit' and 'agent-logs' added to ViewKey union
- Two new nav tab entries
- Two new renderContent cases

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```
