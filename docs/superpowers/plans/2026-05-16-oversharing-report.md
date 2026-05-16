# Oversharing Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "Fabric Activity" tab with an "Oversharing Report" that shows, for every item in the current workspace, who has direct access, oversharing risk flags, who granted access, and a revoke button.

**Architecture:** A new backend module (`oversharingReport.js`) fetches all workspace items via Fabric REST API, then fetches item-level users per item, computes oversharing flags, and correlates with Purview audit logs for grantor info. Two new Express routes expose the data and revoke action. A new frontend view (`OversharingReportView.tsx`) renders expandable item cards with a summary filter bar, following the same pattern as `AccessManagementView.tsx`.

**Tech Stack:** Node.js (devServer), React + Fluent UI v9 (frontend), Fabric REST API v1, Microsoft Graph Security audit logs (already in purviewLogs.js)

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `devServer/oversharingReport.js` | Create | Fetch items + item users, compute flags, correlate audit log for grantor |
| `devServer/index.js` | Modify | Add GET `/api/oversharing/report` and DELETE `/api/oversharing/item-user` routes |
| `app/clients/GovernlyApiClient.ts` | Modify | Add interfaces + `getOversharingReport()` + `revokeItemUser()` methods |
| `app/items/GovernlyItem/views/OversharingReportView.tsx` | Create | Full UI: summary bar, item cards, user table, revoke |
| `app/items/GovernlyItem/GovernlyItemEditor.tsx` | Modify | Rename 'audit' nav item + render new view |

---

### Task 1: Backend module — `oversharingReport.js`

**Files:**
- Create: `devServer/oversharingReport.js`

- [ ] **Step 1: Create the file with helpers, item fetch, and item-users fetch**

```js
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

/**
 * Returns all items in a workspace (paginated).
 * @param {string} workspaceId
 * @returns {Promise<Array<{id, displayName, type, sensitivity}>>}
 */
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

/**
 * Returns direct-access users for a single item.
 * Degrades gracefully — returns [] on 404/403.
 * @param {string} workspaceId
 * @param {string} itemId
 * @returns {Promise<Array<{identifier, principalType, itemAccessDetails}>>}
 */
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

/**
 * Builds a map of itemId → Map<userId, { grantedBy, grantedAt }>
 * from Purview audit logs.
 * Degrades gracefully if audit logs unavailable.
 * @param {string} workspaceId
 * @returns {Promise<Map<string, Map<string, { grantedBy: string|null, grantedAt: string|null }>>>}
 */
async function buildGrantorMap(workspaceId) {
  try {
    const purviewLogs = require('./purviewLogs');
    const report = await purviewLogs.queryFabricActivity(workspaceId, 90);
    /** @type {Map<string, Map<string, { grantedBy: string|null, grantedAt: string|null }>>} */
    const map = new Map();
    for (const record of report.records ?? []) {
      if (!record.operation || !record.operation.toLowerCase().includes('share')) continue;
      const itemId = record.itemId ?? record.artifactId;
      const userId = record.userId ?? record.targetUserId;
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

/**
 * Determines oversharing flags for a set of item users.
 * @param {Array<{identifier, principalType}>} users
 * @param {{ labelId?: string }} item
 * @returns {{ hasDirectGrants: boolean, hasExternalUsers: boolean, unlabeledWithGrants: boolean, highAccessCount: boolean }}
 */
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

/**
 * Builds the full oversharing report for a workspace.
 * @param {string} workspaceId
 * @returns {Promise<{ items: Array, generatedAt: string }>}
 */
async function buildOversharingReport(workspaceId) {
  const [rawItems, grantorMap] = await Promise.all([
    getAllItems(workspaceId),
    buildGrantorMap(workspaceId),
  ]);

  const items = await Promise.all(rawItems.map(async (raw) => {
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
  }));

  return { items, generatedAt: new Date().toISOString() };
}

/**
 * Revokes a user's direct access to a Fabric item.
 * @param {string} workspaceId
 * @param {string} itemId
 * @param {string} userIdentifier  (UPN or object ID)
 */
async function revokeItemUser(workspaceId, itemId, userIdentifier) {
  const token = acquireFabricToken();
  const url = `${FABRIC_BASE}/workspaces/${encodeURIComponent(workspaceId)}/items/${encodeURIComponent(itemId)}/users/${encodeURIComponent(userIdentifier)}`;
  const result = await jsonRequest(url, { method: 'DELETE', token });
  if (!result.ok) {
    throw new Error(`revokeItemUser failed (${result.status}): ${JSON.stringify(result.data).slice(0, 300)}`);
  }
}

module.exports = { buildOversharingReport, revokeItemUser };
```

- [ ] **Step 2: Verify the file exists and has no syntax errors**

```bash
node -e "require('./devServer/oversharingReport.js'); console.log('OK')"
```
Expected output: `OK`

- [ ] **Step 3: Commit**

```bash
git add devServer/oversharingReport.js
git commit -m "feat: add oversharingReport.js backend module

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Express routes in `index.js`

**Files:**
- Modify: `devServer/index.js`

- [ ] **Step 1: Add `require` and two routes after the existing access routes**

In `devServer/index.js`, add the require at the top alongside existing requires:
```js
const oversharingReport = require('./oversharingReport');
```

Then add these two routes after the existing `/api/access/group-member` DELETE route (around line 140):
```js
  app.get('/api/oversharing/report', async (req, res) => {
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'Query param "workspaceId" is required.' });
    try {
      const report = await oversharingReport.buildOversharingReport(workspaceId);
      res.json(report);
    } catch (err) {
      console.error('[Oversharing] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/oversharing/item-user', async (req, res) => {
    const { workspaceId, itemId, userIdentifier } = req.query;
    if (!workspaceId || !itemId || !userIdentifier) {
      return res.status(400).json({ error: 'Query params "workspaceId", "itemId", and "userIdentifier" are required.' });
    }
    try {
      await oversharingReport.revokeItemUser(workspaceId, itemId, userIdentifier);
      res.status(204).end();
    } catch (err) {
      console.error('[OversharingRevoke] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
```

- [ ] **Step 2: Restart devserver and verify routes are mounted**

```bash
npm run start:devServer
```
Expected in output: `Mounting Manifest API`, `Mounting Workload Backend API Stub` — no crash.

Verify route responds (in a separate terminal):
```bash
curl "http://localhost:60006/api/oversharing/report?workspaceId=test" 
```
Expected: either a report JSON or a Fabric API error (not a 404 "Cannot GET").

- [ ] **Step 3: Commit**

```bash
git add devServer/index.js
git commit -m "feat: add /api/oversharing routes to devServer

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Client types and API methods

**Files:**
- Modify: `app/clients/GovernlyApiClient.ts`

- [ ] **Step 1: Add interfaces after the existing `SpConsentUrls` interface**

Find the `SpConsentUrls` interface and add after it:

```ts
export interface OversharingFlags {
  hasDirectGrants: boolean;
  hasExternalUsers: boolean;
  unlabeledWithGrants: boolean;
  highAccessCount: boolean;
}

export interface ItemUser {
  identifier: string;
  displayName: string;
  principalType: string;
  accessRights: string[];
  isExternal: boolean;
  grantedBy: string | null;
  grantedAt: string | null;
}

export interface OversharingItem {
  id: string;
  displayName: string;
  type: string;
  labelId: string | null;
  labelName: string | null;
  users: ItemUser[];
  flags: OversharingFlags;
}

export interface OversharingReport {
  items: OversharingItem[];
  generatedAt: string;
}
```

- [ ] **Step 2: Add API methods to the `GovernlyApiClient` class**

Find the `revokeGroupMember` method (or at the end of the class) and add:

```ts
  async getOversharingReport(workspaceId: string): Promise<OversharingReport> {
    const resp = await fetch(`/api/oversharing/report?workspaceId=${encodeURIComponent(workspaceId)}`);
    if (!resp.ok) throw new Error(`getOversharingReport failed (${resp.status}): ${await resp.text()}`);
    return resp.json() as Promise<OversharingReport>;
  }

  async revokeItemUser(workspaceId: string, itemId: string, userIdentifier: string): Promise<void> {
    const params = new URLSearchParams({ workspaceId, itemId, userIdentifier });
    const resp = await fetch(`/api/oversharing/item-user?${params}`, { method: 'DELETE' });
    if (!resp.ok) throw new Error(`revokeItemUser failed (${resp.status}): ${await resp.text()}`);
  }
```

- [ ] **Step 3: Commit**

```bash
git add app/clients/GovernlyApiClient.ts
git commit -m "feat: add OversharingReport types and client methods

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: `OversharingReportView.tsx`

**Files:**
- Create: `app/items/GovernlyItem/views/OversharingReportView.tsx`

- [ ] **Step 1: Create the view file**

```tsx
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  MessageBar,
  MessageBarBody,
  Spinner,
  Text,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowClockwise24Regular,
  ChevronDown20Regular,
  ChevronRight20Regular,
  PersonProhibited24Regular,
} from '@fluentui/react-icons';
import {
  GovernlyApiClient,
  OversharingReport,
  OversharingItem,
  ItemUser,
} from '../../../clients/GovernlyApiClient';

interface OversharingReportViewProps {
  workspaceId: string;
  client: GovernlyApiClient;
}

// ── Small reusable chips ──────────────────────────────────────────────────────

const TypeChip: React.FC<{ type: string }> = ({ type }) => (
  <span style={{
    display: 'inline-block',
    padding: '2px 7px',
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 500,
    backgroundColor: '#f3f3f3',
    color: '#444',
    border: '1px solid #ddd',
    flexShrink: 0,
  }}>
    {type}
  </span>
);

const FlagChip: React.FC<{ label: string; color: string; bg: string }> = ({ label, color, bg }) => (
  <span style={{
    display: 'inline-block',
    padding: '2px 7px',
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 600,
    backgroundColor: bg,
    color,
    border: `1px solid ${color}33`,
    flexShrink: 0,
  }}>
    {label}
  </span>
);

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// ── Users table inside an expanded item card ──────────────────────────────────

interface UsersTableProps {
  users: ItemUser[];
  revoking: Set<string>;
  itemId: string;
  onRevoke: (itemId: string, identifier: string) => void;
}

const UsersTable: React.FC<UsersTableProps> = ({ users, revoking, itemId, onRevoke }) => (
  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 8 }}>
    <thead>
      <tr style={{ backgroundColor: '#f5f5f5' }}>
        {['Name', 'Access', 'External', 'Granted By', 'Granted At', 'Action'].map(h => (
          <th key={h} style={{
            textAlign: 'left',
            padding: '6px 10px',
            fontWeight: 600,
            color: '#555',
            borderBottom: '1px solid #e0e0e0',
            whiteSpace: 'nowrap',
          }}>{h}</th>
        ))}
      </tr>
    </thead>
    <tbody>
      {users.map(user => {
        const key = `${itemId}:${user.identifier}`;
        return (
          <tr key={user.identifier} style={{ borderBottom: '1px solid #f0f0f0' }}>
            <td style={{ padding: '6px 10px' }}>
              <div>{user.displayName}</div>
              <div style={{ fontSize: 11, color: '#888' }}>{user.identifier}</div>
            </td>
            <td style={{ padding: '6px 10px', color: '#555' }}>
              {user.accessRights.join(', ') || '—'}
            </td>
            <td style={{ padding: '6px 10px' }}>
              {user.isExternal
                ? <Badge color="danger" appearance="tint">External</Badge>
                : <span style={{ color: '#aaa', fontSize: 12 }}>Internal</span>}
            </td>
            <td style={{ padding: '6px 10px', color: user.grantedBy ? undefined : '#aaa' }}>
              {user.grantedBy ?? '—'}
            </td>
            <td style={{ padding: '6px 10px', color: user.grantedAt ? undefined : '#aaa' }}>
              {formatDate(user.grantedAt)}
            </td>
            <td style={{ padding: '6px 10px', textAlign: 'right' }}>
              <Button
                size="small"
                appearance="outline"
                icon={revoking.has(key) ? <Spinner size="tiny" /> : <PersonProhibited24Regular />}
                disabled={revoking.has(key)}
                onClick={() => onRevoke(itemId, user.identifier)}
              >
                {revoking.has(key) ? 'Revoking…' : 'Revoke'}
              </Button>
            </td>
          </tr>
        );
      })}
    </tbody>
  </table>
);

// ── Item card ─────────────────────────────────────────────────────────────────

interface ItemCardProps {
  item: OversharingItem;
  expanded: boolean;
  revoking: Set<string>;
  onToggle: (id: string) => void;
  onRevoke: (itemId: string, identifier: string) => void;
}

const ItemCard: React.FC<ItemCardProps> = ({ item, expanded, revoking, onToggle, onRevoke }) => {
  const { flags } = item;
  const hasUsers = item.users.length > 0;

  return (
    <div style={{
      border: '1px solid #e0e0e0',
      borderRadius: 8,
      marginBottom: 10,
      overflow: 'hidden',
      backgroundColor: '#fff',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '12px 16px',
        flexWrap: 'wrap',
      }}>
        <TypeChip type={item.type} />
        <Text weight="semibold" style={{ flex: 1, minWidth: 0 }}>{item.displayName}</Text>

        {/* Sensitivity label */}
        {item.labelName
          ? <span style={{ fontSize: 12, color: '#1e6b33' }}>🏷 {item.labelName}</span>
          : <span style={{ fontSize: 12, color: '#aaa', fontStyle: 'italic' }}>No label</span>}

        {/* Oversharing flags */}
        {flags.hasExternalUsers    && <FlagChip label="🔴 External"   color="#c50f1f" bg="#fde8e8" />}
        {flags.unlabeledWithGrants && <FlagChip label="🟡 Unlabeled"  color="#c25600" bg="#fff3e0" />}
        {flags.highAccessCount     && <FlagChip label="🟠 High count" color="#b45309" bg="#fef3c7" />}
        {flags.hasDirectGrants && !flags.hasExternalUsers && !flags.unlabeledWithGrants && !flags.highAccessCount
          && <FlagChip label="🔵 Shared" color="#0f52ba" bg="#dce6f8" />}

        {/* Expand / no-grants indicator */}
        {hasUsers ? (
          <Button
            appearance="subtle"
            size="small"
            icon={expanded ? <ChevronDown20Regular /> : <ChevronRight20Regular />}
            onClick={() => onToggle(item.id)}
          >
            {expanded ? 'Collapse' : `${item.users.length} user${item.users.length !== 1 ? 's' : ''}`}
          </Button>
        ) : (
          <span style={{ fontSize: 12, color: '#1e6b33' }}>✓ No direct grants</span>
        )}
      </div>

      {hasUsers && expanded && (
        <div style={{ padding: '0 16px 12px', borderTop: '1px solid #f0f0f0' }}>
          <UsersTable
            users={item.users}
            revoking={revoking}
            itemId={item.id}
            onRevoke={onRevoke}
          />
        </div>
      )}
    </div>
  );
};

// ── Summary filter bar ────────────────────────────────────────────────────────

type FilterKey = 'all' | 'external' | 'unlabeled' | 'high' | 'direct';

interface SummaryCardProps {
  label: string;
  count: number;
  filterKey: FilterKey;
  active: boolean;
  color: string;
  onClick: (k: FilterKey) => void;
}

const SummaryCard: React.FC<SummaryCardProps> = ({ label, count, filterKey, active, color, onClick }) => (
  <div
    onClick={() => onClick(filterKey)}
    style={{
      flex: '1 1 120px',
      minWidth: 120,
      padding: '10px 14px',
      borderRadius: 8,
      border: `2px solid ${active ? color : '#e0e0e0'}`,
      backgroundColor: active ? `${color}18` : '#fff',
      cursor: 'pointer',
      transition: 'border-color 0.15s',
    }}
  >
    <Text size={500} weight="semibold" style={{ color, display: 'block' }}>{count}</Text>
    <Text size={200} style={{ color: '#555' }}>{label}</Text>
  </div>
);

// ── Main view ─────────────────────────────────────────────────────────────────

export const OversharingReportView: React.FC<OversharingReportViewProps> = ({ workspaceId, client }) => {
  const [report, setReport] = useState<OversharingReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<Set<string>>(new Set());
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<FilterKey>('all');

  const loadReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await client.getOversharingReport(workspaceId);
      setReport(data);
      // Auto-expand items with external users
      const autoExpand = new Set(data.items.filter(i => i.flags.hasExternalUsers).map(i => i.id));
      setExpanded(autoExpand);
    } catch (err: any) {
      setError(err?.message ?? 'Failed to load oversharing report.');
    } finally {
      setLoading(false);
    }
  }, [client, workspaceId]);

  useEffect(() => { loadReport(); }, [loadReport]);

  const handleToggle = useCallback((id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const handleRevoke = useCallback(async (itemId: string, identifier: string) => {
    setRevokeError(null);
    const key = `${itemId}:${identifier}`;
    setRevoking(prev => new Set(prev).add(key));
    try {
      await client.revokeItemUser(workspaceId, itemId, identifier);
      // Optimistic removal
      setReport(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          items: prev.items.map(item => {
            if (item.id !== itemId) return item;
            const users = item.users.filter(u => u.identifier !== identifier);
            const flags = {
              hasDirectGrants: users.length > 0,
              hasExternalUsers: users.some(u => u.isExternal),
              unlabeledWithGrants: users.length > 0 && !item.labelId,
              highAccessCount: users.length > 10,
            };
            return { ...item, users, flags };
          }),
        };
      });
    } catch (err: any) {
      setRevokeError(err?.message ?? 'Failed to revoke access.');
    } finally {
      setRevoking(prev => { const next = new Set(prev); next.delete(key); return next; });
    }
  }, [client, workspaceId]);

  const items = useMemo(() => report?.items ?? [], [report]);

  const summary = useMemo(() => ({
    total:    items.length,
    external: items.filter(i => i.flags.hasExternalUsers).length,
    unlabeled:items.filter(i => i.flags.unlabeledWithGrants).length,
    high:     items.filter(i => i.flags.highAccessCount).length,
    direct:   items.filter(i => i.flags.hasDirectGrants).length,
  }), [items]);

  const filtered = useMemo(() => {
    // Sort: most flags first
    const sorted = [...items].sort((a, b) => {
      const score = (f: typeof a.flags) =>
        (f.hasExternalUsers ? 4 : 0) + (f.unlabeledWithGrants ? 2 : 0) + (f.highAccessCount ? 2 : 0) + (f.hasDirectGrants ? 1 : 0);
      return score(b.flags) - score(a.flags);
    });
    if (filter === 'all')      return sorted;
    if (filter === 'external') return sorted.filter(i => i.flags.hasExternalUsers);
    if (filter === 'unlabeled')return sorted.filter(i => i.flags.unlabeledWithGrants);
    if (filter === 'high')     return sorted.filter(i => i.flags.highAccessCount);
    if (filter === 'direct')   return sorted.filter(i => i.flags.hasDirectGrants);
    return sorted;
  }, [items, filter]);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 48, gap: 12 }}>
        <Spinner label="Loading oversharing report…" />
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 24 }}>
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
        <Text size={500} weight="semibold" style={{ flex: 1 }}>Oversharing Report</Text>
        <Button appearance="subtle" icon={<ArrowClockwise24Regular />} onClick={loadReport}>Refresh</Button>
      </div>

      {/* Summary filter bar */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <SummaryCard label="All Items"       count={summary.total}     filterKey="all"       active={filter === 'all'}       color="#555"    onClick={setFilter} />
        <SummaryCard label="External Users"  count={summary.external}  filterKey="external"  active={filter === 'external'}  color="#c50f1f" onClick={setFilter} />
        <SummaryCard label="Unlabeled+Shared"count={summary.unlabeled} filterKey="unlabeled" active={filter === 'unlabeled'} color="#c25600" onClick={setFilter} />
        <SummaryCard label=">10 Users"       count={summary.high}      filterKey="high"      active={filter === 'high'}      color="#b45309" onClick={setFilter} />
        <SummaryCard label="Any Direct Grant"count={summary.direct}    filterKey="direct"    active={filter === 'direct'}    color="#0f52ba" onClick={setFilter} />
      </div>

      {/* Revoke error */}
      {revokeError && (
        <MessageBar intent="error" style={{ marginBottom: 12 }}>
          <MessageBarBody>
            {revokeError}
            <Button appearance="transparent" size="small" style={{ marginLeft: 8 }} onClick={() => setRevokeError(null)}>Dismiss</Button>
          </MessageBarBody>
        </MessageBar>
      )}

      {/* Generated at */}
      {report?.generatedAt && (
        <Text size={100} style={{ color: '#aaa', display: 'block', marginBottom: 10 }}>
          Generated: {new Date(report.generatedAt).toLocaleString()}
        </Text>
      )}

      {/* Item cards */}
      {filtered.length === 0 ? (
        <Text style={{ color: '#666' }}>No items match this filter.</Text>
      ) : (
        filtered.map(item => (
          <ItemCard
            key={item.id}
            item={item}
            expanded={expanded.has(item.id)}
            revoking={revoking}
            onToggle={handleToggle}
            onRevoke={handleRevoke}
          />
        ))
      )}
    </div>
  );
};
```

- [ ] **Step 2: Commit**

```bash
git add app/items/GovernlyItem/views/OversharingReportView.tsx
git commit -m "feat: add OversharingReportView component

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Wire up in `GovernlyItemEditor.tsx`

**Files:**
- Modify: `app/items/GovernlyItem/GovernlyItemEditor.tsx`

- [ ] **Step 1: Add import**

Add this import alongside the existing view imports:
```ts
import { OversharingReportView } from './views/OversharingReportView';
```

- [ ] **Step 2: Rename the nav item**

Find:
```ts
  { key: 'audit',      labelKey: 'Nav_Audit',      defaultLabel: 'Fabric Activity',  icon: <DocumentSearch24Regular /> },
```

Replace with:
```ts
  { key: 'audit',      labelKey: 'Nav_Audit',      defaultLabel: 'Oversharing Report', icon: <DocumentSearch24Regular /> },
```

- [ ] **Step 3: Render the new view**

Find the section in the render that checks `activeView === 'audit'` and renders `<PurviewAuditView .../>`. Replace it with:
```tsx
{activeView === 'audit' && workspaceId && (
  <OversharingReportView workspaceId={workspaceId} client={apiClient} />
)}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add app/items/GovernlyItem/GovernlyItemEditor.tsx
git commit -m "feat: wire OversharingReportView into nav, rename Fabric Activity tab

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Testing Checklist

After all tasks:
- [ ] Navigate to "Oversharing Report" tab — items list loads
- [ ] Summary filter cards filter the list correctly
- [ ] Items with external users auto-expand
- [ ] Expanding an item card shows the users table with grantor/date columns
- [ ] Revoke button removes a user optimistically and calls the backend
- [ ] Items with no direct grants show "✓ No direct grants" with no expand button
- [ ] Refresh button reloads the report
