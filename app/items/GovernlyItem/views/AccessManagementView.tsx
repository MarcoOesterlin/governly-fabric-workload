import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
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
  Warning16Regular,
} from '@fluentui/react-icons';
import {
  GovernlyApiClient,
  WorkspaceAccessReport,
  AccessRoleAssignment,
  GroupMember,
} from '../../../clients/GovernlyApiClient';
import type { WorkspaceRole } from '../../../clients/FabricPlatformTypes';

interface AccessManagementViewProps {
  workspaceId: string;
  client: GovernlyApiClient;
}

const ROLE_COLORS: Record<WorkspaceRole, { bg: string; fg: string }> = {
  Admin:       { bg: '#fde8e8', fg: '#c50f1f' },
  Member:      { bg: '#dce6f8', fg: '#0f52ba' },
  Contributor: { bg: '#ede8f8', fg: '#5c2d91' },
  Viewer:      { bg: '#f0f0f0', fg: '#444444' },
};

const PRINCIPAL_TYPE_COLORS: Record<string, { bg: string; fg: string }> = {
  User:             { bg: '#e8f5e9', fg: '#1e6b33' },
  Group:            { bg: '#fff3e0', fg: '#c25600' },
  ServicePrincipal: { bg: '#f3e8ff', fg: '#6b21a8' },
};

const STALE_MS = 90 * 24 * 60 * 60 * 1000;

function isStale(addedAt: string | null): boolean {
  if (!addedAt) return false;
  return Date.now() - new Date(addedAt).getTime() > STALE_MS;
}

function formatDate(addedAt: string | null): string {
  if (!addedAt) return 'Unknown';
  return new Date(addedAt).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

const RoleBadge: React.FC<{ role: WorkspaceRole }> = ({ role }) => {
  const { bg, fg } = ROLE_COLORS[role] ?? { bg: '#f0f0f0', fg: '#444' };
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: 4,
      fontSize: 12,
      fontWeight: 600,
      backgroundColor: bg,
      color: fg,
      border: `1px solid ${fg}33`,
      flexShrink: 0,
    }}>
      {role}
    </span>
  );
};

const TypeChip: React.FC<{ type: string }> = ({ type }) => {
  const { bg, fg } = PRINCIPAL_TYPE_COLORS[type] ?? { bg: '#f0f0f0', fg: '#444' };
  const label = type === 'ServicePrincipal' ? 'Service Principal' : type;
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 7px',
      borderRadius: 4,
      fontSize: 11,
      fontWeight: 500,
      backgroundColor: bg,
      color: fg,
      border: `1px solid ${fg}33`,
      flexShrink: 0,
    }}>
      {label}
    </span>
  );
};

interface MembersTableProps {
  members: GroupMember[];
  revoking: Set<string>;
  onRevoke: (groupId: string, memberId: string) => void;
}

const MembersTable: React.FC<MembersTableProps> = ({ members, revoking, onRevoke }) => (
  <table style={{
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 13,
    marginTop: 8,
  }}>
    <thead>
      <tr style={{ backgroundColor: '#f5f5f5' }}>
        {['Name', 'Email', 'Added', 'Status', 'Action'].map(h => (
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
      {members.map(member => {
        const stale = isStale(member.addedAt);
        const unknownDate = !member.addedAt;
        return (
          <tr key={member.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
            <td style={{ padding: '6px 10px' }}>{member.displayName}</td>
            <td style={{ padding: '6px 10px', color: member.email ? undefined : '#aaa' }}>
              {member.email ?? '—'}
            </td>
            <td style={{ padding: '6px 10px' }}>
              <span style={{
                color: unknownDate
                  ? '#aaa'
                  : stale
                  ? tokens.colorPaletteRedForeground1
                  : undefined,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
              }}>
                {stale && <Warning16Regular aria-hidden="true" style={{ flexShrink: 0 }} />}
                {formatDate(member.addedAt)}
              </span>
            </td>
            <td style={{ padding: '6px 10px' }}>
              {unknownDate ? (
                <Text size={100} style={{ color: '#aaa' }}>Unknown</Text>
              ) : stale ? (
                <span style={{ color: tokens.colorPaletteRedForeground1, fontSize: 12, fontWeight: 500 }}>
                  ⚠ &gt;90 days
                </span>
              ) : (
                <span style={{ color: '#1e6b33', fontSize: 12 }}>✓ OK</span>
              )}
            </td>
            <td style={{ padding: '6px 10px', textAlign: 'right' }}>
              <Button
                size="small"
                appearance="subtle"
                icon={revoking.has(member.id) ? <Spinner size="tiny" /> : undefined}
                disabled={revoking.has(member.id)}
                onClick={() => onRevoke(member.groupId, member.id)}
              >
                {revoking.has(member.id) ? 'Revoking…' : 'Revoke'}
              </Button>
            </td>
          </tr>
        );
      })}
    </tbody>
  </table>
);

interface AssignmentCardProps {
  assignment: AccessRoleAssignment;
  expanded: boolean;
  revoking: Set<string>;
  onToggle: (id: string) => void;
  onRevoke: (groupId: string, memberId: string) => void;
}

const AssignmentCard: React.FC<AssignmentCardProps> = ({
  assignment, expanded, revoking, onToggle, onRevoke,
}) => {
  const { principal, role, members } = assignment;
  const isGroup = principal.type === 'Group';
  const hasMembers = isGroup && Array.isArray(members);

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
        <RoleBadge role={role} />
        <Text weight="semibold" style={{ flex: 1, minWidth: 0 }}>{principal.displayName}</Text>
        <TypeChip type={principal.type} />
        {principal.email && (
          <Text size={200} style={{ color: '#666' }}>{principal.email}</Text>
        )}
        {hasMembers && (
          <Button
            appearance="subtle"
            size="small"
            icon={expanded ? <ChevronDown20Regular /> : <ChevronRight20Regular />}
            onClick={() => onToggle(assignment.id)}
            aria-label={expanded
              ? `Collapse ${principal.displayName}`
              : `Expand ${principal.displayName}, ${members!.length} member${members!.length === 1 ? '' : 's'}`
            }
          >
            {expanded ? 'Collapse' : `${members!.length} member${members!.length !== 1 ? 's' : ''}`}
          </Button>
        )}
      </div>

      {hasMembers && expanded && (
        <div style={{ padding: '0 16px 12px', borderTop: '1px solid #f0f0f0' }}>
          {members!.length === 0 ? (
            <Text size={200} style={{ color: '#aaa', padding: '8px 0', display: 'block' }}>
              No members in this group.
            </Text>
          ) : (
            <MembersTable members={members!} revoking={revoking} onRevoke={onRevoke} />
          )}
        </div>
      )}
    </div>
  );
};

export const AccessManagementView: React.FC<AccessManagementViewProps> = ({ workspaceId, client }) => {
  const [report, setReport] = useState<WorkspaceAccessReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<Set<string>>(new Set());
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const loadReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await client.getWorkspaceAccess(workspaceId);
      setReport(data);
      // Auto-expand groups with fewer than 20 members
      const autoExpand = new Set<string>();
      for (const a of data.assignments) {
        if (a.principal.type === 'Group' && Array.isArray(a.members) && a.members.length < 20) {
          autoExpand.add(a.id);
        }
      }
      setExpanded(autoExpand);
    } catch (err: any) {
      setError(err?.message ?? 'Failed to load access report.');
    } finally {
      setLoading(false);
    }
  }, [client, workspaceId]);

  useEffect(() => {
    loadReport();
  }, [loadReport]);

  const handleToggleExpand = useCallback((id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleRevoke = useCallback(async (groupId: string, memberId: string) => {
    setRevoking(prev => new Set(prev).add(memberId));
    try {
      await client.revokeGroupMember(groupId, memberId);
      // Optimistic removal
      setReport(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          assignments: prev.assignments.map(a => {
            if (!a.members || a.principal.id !== groupId) return a;
            return { ...a, members: a.members.filter(m => m.id !== memberId) };
          }),
        };
      });
    } catch (err: any) {
      setRevokeError(err?.message ?? 'Failed to revoke member.');
    } finally {
      setRevoking(prev => {
        const next = new Set(prev);
        next.delete(memberId);
        return next;
      });
    }
  }, [client]);

  const handleRefresh = useCallback(() => {
    setRevokeError(null);
    loadReport();
  }, [loadReport]);

  const assignments = useMemo(() => report?.assignments ?? [], [report]);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 48, gap: 12 }}>
        <Spinner label="Loading access report..." />
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
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
        <Text size={500} weight="semibold" style={{ flex: 1 }}>Access Management</Text>
        <Button
          appearance="subtle"
          icon={<ArrowClockwise24Regular />}
          onClick={handleRefresh}
        >
          Refresh
        </Button>
      </div>

      {revokeError && (
        <MessageBar intent="error" style={{ marginBottom: 12 }}>
          <MessageBarBody>
            {revokeError}
            <Button
              appearance="transparent"
              size="small"
              style={{ marginLeft: 8 }}
              onClick={() => setRevokeError(null)}
            >
              Dismiss
            </Button>
          </MessageBarBody>
        </MessageBar>
      )}

      {assignments.length === 0 ? (
        <Text>No role assignments found for this workspace.</Text>
      ) : (
        assignments.map(assignment => (
          <AssignmentCard
            key={assignment.id}
            assignment={assignment}
            expanded={expanded.has(assignment.id)}
            revoking={revoking}
            onToggle={handleToggleExpand}
            onRevoke={handleRevoke}
          />
        ))
      )}
    </div>
  );
};
