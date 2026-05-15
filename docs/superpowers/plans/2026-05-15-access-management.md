# Access Management — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Access Management" view to Governly that lists who has access to the workspace (including AD group expansion), shows when each person was added with 90-day staleness highlighting, and provides a one-click revoke button that removes a user from their AD group.

**Architecture:** A new backend module (`devServer/accessManagement.js`) fetches workspace role assignments from the Fabric API, expands AD groups via Graph, and correlates membership with Graph audit logs to get the "added at" date. A new frontend view (`AccessManagementView.tsx`) renders the report with expandable groups, date-based staleness colouring, and a revoke button that calls a DELETE endpoint. The new view is wired into the existing sidebar tab navigation.

**Tech Stack:** Node.js (devServer), Express, Microsoft Graph API v1.0 (`/auditLogs/directoryAudits`, `/groups/{id}/members`, `DELETE /groups/{id}/members/{id}/$ref`), Fabric API v1 (`/workspaces/{id}/roleAssignments`), React 18, TypeScript strict, Fluent UI v9.

---

## File Map

**New files:**
- `devServer/accessManagement.js` — backend module: Fabric + Graph calls, audit log correlation
- `app/items/GovernlyItem/views/AccessManagementView.tsx` — full access report view

**Modified files:**
- `devServer/index.js` — register GET `/api/access/roles` and DELETE `/api/access/group-member`
- `app/clients/GovernlyApiClient.ts` — add 4 interfaces + 2 client methods
- `app/items/GovernlyItem/GovernlyItemEditor.tsx` — add `'access'` tab to nav + render case

---

## Task 1: Backend module `devServer/accessManagement.js`

**Files:**
- Create: `devServer/accessManagement.js`

### Data contracts

`GET /api/access/roles?wsId={workspaceId}` response shape:
```json
{
  "assignments": [
    {
      "id": "role-assignment-id",
      "role": "Admin",
      "principal": {
        "id": "object-id",
        "displayName": "User Name",
        "type": "User",
        "email": "user@domain.com"
      },
      "members": [
        {
          "id": "member-object-id",
          "displayName": "Alice Smith",
          "email": "alice@domain.com",
          "addedAt": "2026-01-15T10:23:45Z",
          "groupId": "group-object-id"
        }
      ]
    }
  ]
}
```
`members` is present only when `principal.type === "Group"`. `addedAt` is `null` when no audit record found.

`DELETE /api/access/group-member` request body: `{ "groupId": "...", "memberId": "..." }` → 200 `{ "success": true }`.

- [ ] **Step 1: Create the file with imports and local HTTP helpers**

```js
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
```

- [ ] **Step 2: Add `getWorkspaceRoles(workspaceId)` using the Fabric API**

```js
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
```

The Fabric API returns each assignment as:
```json
{ "id": "...", "role": "Admin", "principal": { "id": "...", "displayName": "...", "type": "User", "userPrincipalName": "user@domain.com" } }
```

- [ ] **Step 3: Add `getGroupMembers(groupId)` using Graph v1.0**

```js
/**
 * Returns members of an AD group.
 * @param {string} groupId
 * @returns {Promise<Array<{id,displayName,userPrincipalName,mail}>>}
 */
async function getGroupMembers(groupId) {
  const token = await acquireGraphTokenViaClientCredentials();
  const params = new URLSearchParams({
    '$select': 'id,displayName,userPrincipalName,mail',
    '$top': '999',
  });
  const url = `${GRAPH_BASE}/groups/${encodeURIComponent(groupId)}/members?${params}`;
  const result = await jsonRequest(url, { token });
  if (!result.ok) {
    console.warn(`[AccessMgmt] getGroupMembers(${groupId}) failed (${result.status}) — returning empty`);
    return [];
  }
  return result.data.value ?? [];
}
```

- [ ] **Step 4: Add `getGroupAuditDates(groupId)` using Graph audit logs**

```js
/**
 * Fetches "Add member to group" audit events for the given group.
 * Returns a Map from memberId → ISO 8601 addedAt string (most recent entry wins).
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
  });
  const url = `${GRAPH_BASE}/auditLogs/directoryAudits?${params}`;
  const result = await jsonRequest(url, { token });

  if (!result.ok) {
    // AuditLog.Read.All may not yet be consented — degrade gracefully
    console.warn(`[AccessMgmt] Audit log fetch failed (${result.status}) — addedAt will be null for all members`);
    return new Map();
  }

  /** @type {Map<string, string>} */
  const map = new Map();
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
  return map;
}
```

- [ ] **Step 5: Add `buildAccessReport(workspaceId)` orchestrator**

```js
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
```

- [ ] **Step 6: Add `removeMemberFromGroup(groupId, memberId)`**

```js
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
```

- [ ] **Step 7: Add module.exports and smoke-test**

```js
module.exports = { buildAccessReport, removeMemberFromGroup };
```

Run smoke test:
```
node -e "const m = require('./devServer/accessManagement'); console.log(Object.keys(m))"
```
Expected output: `[ 'buildAccessReport', 'removeMemberFromGroup' ]`

- [ ] **Step 8: Commit**

```bash
git add devServer/accessManagement.js
git commit -m "feat(access): add access management backend module"
```

---

## Task 2: Register endpoints in `devServer/index.js`

**Files:**
- Modify: `devServer/index.js`

- [ ] **Step 1: Add require at the top (after spProvisioning require, line ~9)**

```js
const { buildAccessReport, removeMemberFromGroup } = require('./accessManagement');
```

- [ ] **Step 2: Register `GET /api/access/roles` before the DQ routes mount**

Insert after the POST `/api/sp-setup` handler (around line 113), before `registerDqRoutes(app)`:

```js
  app.get('/api/access/roles', async (req, res) => {
    const wsId = req.query.wsId;
    if (!wsId) {
      return res.status(400).json({ error: 'Query param "wsId" is required.' });
    }
    try {
      const report = await buildAccessReport(wsId);
      res.json(report);
    } catch (err) {
      console.error('[AccessRoles] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
```

- [ ] **Step 3: Register `DELETE /api/access/group-member`**

Insert immediately after the GET `/api/access/roles` handler:

```js
  app.delete('/api/access/group-member', async (req, res) => {
    const { groupId, memberId } = req.body ?? {};
    if (!groupId || !memberId) {
      return res.status(400).json({ error: 'Request body must include "groupId" and "memberId".' });
    }
    try {
      await removeMemberFromGroup(groupId, memberId);
      res.json({ success: true });
    } catch (err) {
      console.error('[RevokeAccess] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
```

- [ ] **Step 4: Smoke-test that index.js loads**

```
node -e "require('./devServer/index')" 2>&1 | head -5
```
Expected: exits 0, no error output (or just startup logs).

- [ ] **Step 5: Commit**

```bash
git add devServer/index.js
git commit -m "feat(access): register GET /api/access/roles and DELETE /api/access/group-member"
```

---

## Task 3: Types and client methods in `GovernlyApiClient.ts`

**Files:**
- Modify: `app/clients/GovernlyApiClient.ts`

- [ ] **Step 1: Add interfaces after `SpConsentUrls` (around line 105)**

```typescript
export interface AccessPrincipal {
  id: string;
  displayName: string;
  type: 'User' | 'Group' | 'ServicePrincipal';
  email?: string;
}

export interface GroupMember {
  id: string;
  displayName: string;
  email: string;
  addedAt: string | null;   // ISO 8601, null if audit log has no record
  groupId: string;
}

export interface WorkspaceRoleAssignment {
  id: string;
  role: string;             // 'Admin' | 'Member' | 'Contributor' | 'Viewer'
  principal: AccessPrincipal;
  members?: GroupMember[];  // present only when principal.type === 'Group'
}

export interface WorkspaceAccessReport {
  assignments: WorkspaceRoleAssignment[];
}
```

- [ ] **Step 2: Add client methods — insert a new `// ── Access Management ──` section after the `// ── Service Principal ──` section (after `getSpConsentUrl`, around line 460)**

```typescript
  // ── Access Management ────────────────────────────────────────────────────

  async getWorkspaceAccess(workspaceId: string): Promise<WorkspaceAccessReport> {
    const resp = await fetch(`/api/access/roles?wsId=${encodeURIComponent(workspaceId)}`);
    if (!resp.ok) throw new Error(`getWorkspaceAccess failed (${resp.status}): ${await resp.text()}`);
    return resp.json() as Promise<WorkspaceAccessReport>;
  }

  async revokeGroupMember(groupId: string, memberId: string): Promise<void> {
    const resp = await fetch('/api/access/group-member', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId, memberId }),
    });
    if (!resp.ok) throw new Error(`revokeGroupMember failed (${resp.status}): ${await resp.text()}`);
  }
```

- [ ] **Step 3: TypeScript check**

```
npx tsc --noEmit
```
Expected: exit 0, no errors.

- [ ] **Step 4: Commit**

```bash
git add app/clients/GovernlyApiClient.ts
git commit -m "feat(access): add WorkspaceAccessReport types and client methods"
```

---

## Task 4: `AccessManagementView.tsx`

**Files:**
- Create: `app/items/GovernlyItem/views/AccessManagementView.tsx`

### UI spec

- Page header: "Access Management" title + Refresh button (right-aligned)
- Below: a flat list of role assignment rows, each showing: role badge, principal name, principal type
- When `principal.type === 'Group'`: a chevron toggle. Expanded shows indented member rows
- Member row columns: avatar initial | name | email | "Added" date | revoke button
- If `addedAt` is null → show "Unknown" in gray
- If `addedAt` is >90 days ago → date shown in `#c4314b` red with a warning indicator
- If `addedAt` is ≤90 days ago → date shown normally
- Revoke button: appears for Group members only; triggers DELETE and removes the member from the local state immediately (optimistic), with error toast on failure
- Empty state: "No role assignments found for this workspace."
- Error state: MessageBar showing the error message + Retry button
- Loading state: centered Spinner

### 90-day staleness helper (file-level, before the component)

```typescript
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

function isStale(addedAt: string | null): boolean {
  if (!addedAt) return false;
  return Date.now() - new Date(addedAt).getTime() > NINETY_DAYS_MS;
}

function formatDate(addedAt: string | null): string {
  if (!addedAt) return 'Unknown';
  return new Date(addedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
```

- [ ] **Step 1: Write the full component**

```tsx
import React, { useCallback, useEffect, useState } from 'react';
import {
  Button, Spinner, MessageBar, MessageBarBody, Badge,
} from '@fluentui/react-components';
import {
  ChevronDown20Regular, ChevronRight20Regular,
  ArrowClockwise20Regular, Delete20Regular,
  Person20Regular, PeopleTeam20Regular, AppGeneric20Regular,
} from '@fluentui/react-icons';
import {
  GovernlyApiClient,
  WorkspaceRoleAssignment, GroupMember, WorkspaceAccessReport,
} from '../../../clients/GovernlyApiClient';

interface AccessManagementViewProps {
  apiClient: GovernlyApiClient;
  workspaceId: string | undefined;
}

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

function isStale(addedAt: string | null): boolean {
  if (!addedAt) return false;
  return Date.now() - new Date(addedAt).getTime() > NINETY_DAYS_MS;
}

function formatDate(addedAt: string | null): string {
  if (!addedAt) return 'Unknown';
  return new Date(addedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

const ROLE_COLORS: Record<string, string> = {
  Admin:       '#c4314b',
  Member:      '#0078d4',
  Contributor: '#ca5010',
  Viewer:      '#107c10',
};

function PrincipalIcon({ type }: { type: string }) {
  if (type === 'Group')            return <PeopleTeam20Regular style={{ color: '#0078d4' }} />;
  if (type === 'ServicePrincipal') return <AppGeneric20Regular style={{ color: '#605e5c' }} />;
  return <Person20Regular style={{ color: '#605e5c' }} />;
}

export const AccessManagementView: React.FC<AccessManagementViewProps> = ({ apiClient, workspaceId }) => {
  const [report, setReport]       = useState<WorkspaceAccessReport | null>(null);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | undefined>();
  const [expanded, setExpanded]   = useState<Set<string>>(new Set());
  const [revoking, setRevoking]   = useState<Set<string>>(new Set());
  const [revokeError, setRevokeError] = useState<string | undefined>();

  const loadReport = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError(undefined);
    try {
      const data = await apiClient.getWorkspaceAccess(workspaceId);
      setReport(data);
      // Auto-expand groups with <20 members for convenience
      const autoExpand = new Set<string>();
      for (const a of data.assignments) {
        if (a.principal.type === 'Group' && (a.members?.length ?? 0) < 20) {
          autoExpand.add(a.id);
        }
      }
      setExpanded(autoExpand);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [apiClient, workspaceId]);

  useEffect(() => { loadReport(); }, [loadReport]);

  const toggleExpand = useCallback((id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const handleRevoke = useCallback(async (member: GroupMember) => {
    const key = `${member.groupId}:${member.id}`;
    setRevoking(prev => new Set(prev).add(key));
    setRevokeError(undefined);
    try {
      await apiClient.revokeGroupMember(member.groupId, member.id);
      // Optimistic: remove member from local state
      setReport(prev => {
        if (!prev) return prev;
        return {
          assignments: prev.assignments.map(a => {
            if (a.principal.id !== member.groupId) return a;
            return { ...a, members: a.members?.filter(m => m.id !== member.id) };
          }),
        };
      });
    } catch (e: unknown) {
      setRevokeError(e instanceof Error ? e.message : String(e));
    } finally {
      setRevoking(prev => { const next = new Set(prev); next.delete(key); return next; });
    }
  }, [apiClient]);

  if (!workspaceId) {
    return (
      <div style={{ padding: 24 }}>
        <MessageBar intent="warning">
          <MessageBarBody>No workspace selected. Open Governly from a Fabric workspace.</MessageBarBody>
        </MessageBar>
      </div>
    );
  }

  return (
    <div style={{ padding: 24, maxWidth: 960 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 20, gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: '#1a1a2e' }}>Access Management</h2>
        <Button
          appearance="subtle"
          icon={<ArrowClockwise20Regular />}
          onClick={loadReport}
          disabled={loading}
          title="Refresh"
        >
          Refresh
        </Button>
      </div>

      {/* Revoke error */}
      {revokeError && (
        <MessageBar intent="error" style={{ marginBottom: 16 }}>
          <MessageBarBody>Revoke failed: {revokeError}</MessageBarBody>
        </MessageBar>
      )}

      {/* Loading */}
      {loading && (
        <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 60 }}>
          <Spinner label="Loading access report…" />
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <MessageBar intent="error">
          <MessageBarBody>
            {error}
            <Button appearance="subtle" size="small" onClick={loadReport} style={{ marginLeft: 8 }}>Retry</Button>
          </MessageBarBody>
        </MessageBar>
      )}

      {/* Empty */}
      {!loading && !error && report && report.assignments.length === 0 && (
        <p style={{ color: '#605e5c' }}>No role assignments found for this workspace.</p>
      )}

      {/* Report */}
      {!loading && !error && report && report.assignments.length > 0 && (
        <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden' }}>
          {/* Table header */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '120px 1fr 160px 160px 100px',
            background: '#f8f9fa',
            borderBottom: '1px solid #e2e8f0',
            padding: '8px 16px',
            fontSize: 12,
            fontWeight: 600,
            color: '#605e5c',
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
          }}>
            <span>Role</span>
            <span>Principal</span>
            <span>Type</span>
            <span>Added</span>
            <span></span>
          </div>

          {report.assignments.map((assignment) => (
            <React.Fragment key={assignment.id}>
              {/* Assignment row */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '120px 1fr 160px 160px 100px',
                  padding: '10px 16px',
                  borderBottom: '1px solid #f0f0f0',
                  alignItems: 'center',
                  background: '#fff',
                  cursor: assignment.principal.type === 'Group' ? 'pointer' : 'default',
                }}
                onClick={() => assignment.principal.type === 'Group' && toggleExpand(assignment.id)}
              >
                <span>
                  <Badge
                    appearance="tint"
                    style={{
                      background: `${ROLE_COLORS[assignment.role] ?? '#605e5c'}18`,
                      color: ROLE_COLORS[assignment.role] ?? '#605e5c',
                      border: `1px solid ${ROLE_COLORS[assignment.role] ?? '#605e5c'}44`,
                      fontWeight: 600,
                      fontSize: 11,
                    }}
                  >
                    {assignment.role}
                  </Badge>
                </span>

                <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 500 }}>
                  {assignment.principal.type === 'Group' && (
                    expanded.has(assignment.id)
                      ? <ChevronDown20Regular style={{ color: '#605e5c', flexShrink: 0 }} />
                      : <ChevronRight20Regular style={{ color: '#605e5c', flexShrink: 0 }} />
                  )}
                  <PrincipalIcon type={assignment.principal.type} />
                  <span>{assignment.principal.displayName}</span>
                  {assignment.principal.email && (
                    <span style={{ fontSize: 12, color: '#888' }}>({assignment.principal.email})</span>
                  )}
                </span>

                <span style={{ fontSize: 13, color: '#605e5c', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <PrincipalIcon type={assignment.principal.type} />
                  {assignment.principal.type}
                  {assignment.principal.type === 'Group' && assignment.members !== undefined && (
                    <span style={{ color: '#888', fontSize: 12 }}>({assignment.members.length})</span>
                  )}
                </span>

                <span style={{ fontSize: 13, color: '#999' }}>—</span>
                <span />
              </div>

              {/* Expanded group members */}
              {assignment.principal.type === 'Group' &&
                expanded.has(assignment.id) &&
                (assignment.members ?? []).map((member) => {
                  const stale = isStale(member.addedAt);
                  const revokeKey = `${member.groupId}:${member.id}`;
                  const isRevoking = revoking.has(revokeKey);
                  return (
                    <div
                      key={member.id}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '120px 1fr 160px 160px 100px',
                        padding: '8px 16px 8px 48px',
                        borderBottom: '1px solid #f8f8f8',
                        alignItems: 'center',
                        background: stale ? '#fff8f8' : '#fafafa',
                      }}
                    >
                      <span />

                      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{
                          width: 28, height: 28, borderRadius: '50%',
                          background: '#0078d422',
                          color: '#0078d4',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 12, fontWeight: 700, flexShrink: 0,
                        }}>
                          {member.displayName.charAt(0).toUpperCase()}
                        </span>
                        <span>
                          <div style={{ fontSize: 13, fontWeight: 500 }}>{member.displayName}</div>
                          <div style={{ fontSize: 12, color: '#888' }}>{member.email}</div>
                        </span>
                      </span>

                      <span style={{ fontSize: 13, color: '#605e5c' }}>Member</span>

                      <span style={{ fontSize: 13 }}>
                        {member.addedAt === null ? (
                          <span style={{ color: '#999' }}>Unknown</span>
                        ) : stale ? (
                          <span style={{ color: '#c4314b', fontWeight: 600 }} title="Access granted over 90 days ago">
                            ⚠ {formatDate(member.addedAt)}
                          </span>
                        ) : (
                          <span>{formatDate(member.addedAt)}</span>
                        )}
                      </span>

                      <span>
                        <Button
                          appearance="subtle"
                          size="small"
                          icon={<Delete20Regular />}
                          disabled={isRevoking}
                          onClick={(e) => { e.stopPropagation(); handleRevoke(member); }}
                          title={`Remove ${member.displayName} from this AD group`}
                          style={{ color: '#c4314b' }}
                        >
                          {isRevoking ? 'Revoking…' : 'Revoke'}
                        </Button>
                      </span>
                    </div>
                  );
                })
              }
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
};
```

- [ ] **Step 2: TypeScript check**

```
npx tsc --noEmit
```
Expected: exit 0, no errors.

- [ ] **Step 3: Commit**

```bash
git add app/items/GovernlyItem/views/AccessManagementView.tsx
git commit -m "feat(access): add AccessManagementView component"
```

---

## Task 5: Wire into `GovernlyItemEditor.tsx`

**Files:**
- Modify: `app/items/GovernlyItem/GovernlyItemEditor.tsx`

- [ ] **Step 1: Add `PeopleTeam24Regular` to the icons import**

Current import (line 7–13):
```typescript
import {
  ArrowClockwise24Regular,
  ShieldTask24Regular,
  AppsList24Regular,
  CheckmarkStarburst24Regular,
  Open24Regular,
  Bot24Regular,
  Dismiss24Regular,
} from '@fluentui/react-icons';
```

Add `PeopleTeam24Regular`:
```typescript
import {
  ArrowClockwise24Regular,
  ShieldTask24Regular,
  AppsList24Regular,
  CheckmarkStarburst24Regular,
  Open24Regular,
  Bot24Regular,
  Dismiss24Regular,
  PeopleTeam24Regular,
} from '@fluentui/react-icons';
```

- [ ] **Step 2: Add `AccessManagementView` import after the `DataQualityView` import (line 31)**

```typescript
import { AccessManagementView } from './views/AccessManagementView';
```

- [ ] **Step 3: Add `'access'` to the `ViewKey` type**

Current (line 36):
```typescript
type ViewKey = 'items' | 'data-quality';
```

New:
```typescript
type ViewKey = 'items' | 'data-quality' | 'access';
```

- [ ] **Step 4: Add the nav entry to `NAV_ITEMS`**

Current `NAV_ITEMS` (lines 45–48):
```typescript
const NAV_ITEMS: NavItem[] = [
  { key: 'items',        labelKey: 'Nav_Items',       defaultLabel: 'Workspace Items', icon: <AppsList24Regular /> },
  { key: 'data-quality', labelKey: 'Nav_DataQuality', defaultLabel: 'Data Quality',   icon: <CheckmarkStarburst24Regular /> },
];
```

New:
```typescript
const NAV_ITEMS: NavItem[] = [
  { key: 'items',        labelKey: 'Nav_Items',       defaultLabel: 'Workspace Items',    icon: <AppsList24Regular /> },
  { key: 'data-quality', labelKey: 'Nav_DataQuality', defaultLabel: 'Data Quality',       icon: <CheckmarkStarburst24Regular /> },
  { key: 'access',       labelKey: 'Nav_Access',      defaultLabel: 'Access Management',  icon: <PeopleTeam24Regular /> },
];
```

- [ ] **Step 5: Add `case 'access':` to `renderContent()`**

Current `renderContent()` (lines 244–265):
```typescript
  const renderContent = () => {
    switch (activeView) {
      case 'items':
        return (
          <ItemsView ... />
        );
      case 'data-quality':
        return <DataQualityView apiClient={apiClient} workspaceId={workspaceId ?? ''} workloadClient={workloadClient} refreshTrigger={refreshTrigger} />;
      default:
        return null;
    }
  };
```

Add the new case before `default`:
```typescript
      case 'access':
        return <AccessManagementView apiClient={apiClient} workspaceId={workspaceId} />;
```

- [ ] **Step 6: TypeScript check**

```
npx tsc --noEmit
```
Expected: exit 0, no errors.

- [ ] **Step 7: Commit**

```bash
git add app/items/GovernlyItem/GovernlyItemEditor.tsx
git commit -m "feat(access): add Access Management tab to sidebar navigation"
```

---

## Self-Review

### Spec coverage

| User requirement | Covered by |
|---|---|
| See who has access to the workspace | Task 1 `getWorkspaceRoles` + Task 4 assignment rows |
| Expand AD groups to see members | Task 4 expandable group rows |
| See when people were added | Task 1 `getGroupAuditDates` + Task 4 date column |
| Over 90 days in red | Task 4 `isStale()` + red styling |
| Easy revoke button → removes from AD group | Task 1 `removeMemberFromGroup` + Task 4 Revoke button + optimistic removal |

### Placeholder check
None — all steps contain complete code.

### Type consistency
- `GroupMember.groupId` defined in Task 3, used in Task 4 `handleRevoke(member.groupId, member.id)` ✓
- `WorkspaceRoleAssignment.members?: GroupMember[]` — optional, checked with `?.` and `?? []` in Task 4 ✓
- `AccessManagementView` props `apiClient: GovernlyApiClient; workspaceId: string | undefined` — Task 5 passes `workspaceId` (which is `string | undefined`) ✓
- `revokeGroupMember(groupId: string, memberId: string)` in Task 3 — called in Task 4 as `apiClient.revokeGroupMember(member.groupId, member.id)` ✓
