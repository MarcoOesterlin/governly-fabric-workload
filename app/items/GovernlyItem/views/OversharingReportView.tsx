import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  MessageBar,
  MessageBarBody,
  Spinner,
  Text,
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
