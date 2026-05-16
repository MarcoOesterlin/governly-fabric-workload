import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  MessageBar,
  MessageBarBody,
  Spinner,
  Text,
  Tooltip,
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
  OneLakeLakehouse,
  OneLakeRole,
  OneLakeEntraMember,
  DirectItemShare,
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
  if (!addedAt) return '—';
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
  auditRetentionDays: number | null;
  onRevoke: (groupId: string, memberId: string) => void;
}

const MembersTable: React.FC<MembersTableProps> = ({ members, revoking, auditRetentionDays, onRevoke }) => {
  const unknownTooltip = auditRetentionDays != null
    ? `Added more than ${auditRetentionDays} days ago (outside audit log retention window)`
    : 'Added before audit log retention window';
  return (
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
              {unknownDate ? (
                <Tooltip content={unknownTooltip} relationship="label">
                  <span style={{ color: '#aaa', cursor: 'default' }}>—</span>
                </Tooltip>
              ) : (
                <span style={{
                  color: stale ? tokens.colorPaletteRedForeground1 : undefined,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                }}>
                  {stale && <Warning16Regular aria-hidden="true" style={{ flexShrink: 0 }} />}
                  {formatDate(member.addedAt)}
                </span>
              )}
            </td>
            <td style={{ padding: '6px 10px' }}>
              {unknownDate ? (
                <Tooltip content={unknownTooltip} relationship="label">
                  <span style={{ color: '#aaa', cursor: 'default' }}>—</span>
                </Tooltip>
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
                appearance="outline"
                icon={revoking.has(`${member.groupId}:${member.id}`) ? <Spinner size="tiny" /> : undefined}
                disabled={revoking.has(`${member.groupId}:${member.id}`)}
                onClick={() => onRevoke(member.groupId, member.id)}
              >
                {revoking.has(`${member.groupId}:${member.id}`) ? 'Revoking…' : 'Revoke'}
              </Button>
            </td>
          </tr>
        );
      })}
    </tbody>
  </table>
  );
};

interface AssignmentCardProps {
  assignment: AccessRoleAssignment;
  expanded: boolean;
  revoking: Set<string>;
  auditRetentionDays: number | null;
  onToggle: (id: string) => void;
  onRevoke: (groupId: string, memberId: string) => void;
}

const AssignmentCard: React.FC<AssignmentCardProps> = ({
  assignment, expanded, revoking, auditRetentionDays, onToggle, onRevoke,
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
            <MembersTable members={members!} revoking={revoking} auditRetentionDays={auditRetentionDays} onRevoke={onRevoke} />
          )}
        </div>
      )}
    </div>
  );
};

const PERMISSION_COLORS: Record<string, { bg: string; fg: string }> = {
  Read:      { bg: '#e8f5e9', fg: '#1e6b33' },
  ReadWrite: { bg: '#fff3e0', fg: '#c25600' },
};

function isExternalMember(member: OneLakeEntraMember): boolean {
  return member.displayName.includes('#EXT#') || member.objectId.includes('#EXT#');
}

const OneLakeRoleCard: React.FC<{ role: OneLakeRole; expanded: boolean; onToggle: () => void }> = ({
  role, expanded, onToggle,
}) => {
  const memberCount = role.entraMembers.length +
    role.fabricItemMembers.reduce((sum, m) => sum + m.expandedUsers.length, 0);
  const externalCount = role.entraMembers.filter(isExternalMember).length;

  return (
    <div style={{ border: '1px solid #e8e8e8', borderRadius: 6, marginBottom: 8, backgroundColor: '#fafafa' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', flexWrap: 'wrap' }}>
        <Text weight="semibold" style={{ flex: 1 }}>{role.name}</Text>
        {role.permissions.map(p => {
          const { bg, fg } = PERMISSION_COLORS[p] ?? { bg: '#f0f0f0', fg: '#444' };
          return (
            <span key={p} style={{
              padding: '2px 7px', borderRadius: 4, fontSize: 11, fontWeight: 500,
              backgroundColor: bg, color: fg, border: `1px solid ${fg}33`,
            }}>{p}</span>
          );
        })}
        {externalCount > 0 && (
          <span style={{
            padding: '2px 7px', borderRadius: 4, fontSize: 11, fontWeight: 600,
            backgroundColor: '#fde8e8', color: '#c50f1f', border: '1px solid #c50f1f33',
          }}>⚠ {externalCount} external</span>
        )}
        <Button
          appearance="subtle"
          size="small"
          icon={expanded ? <ChevronDown20Regular /> : <ChevronRight20Regular />}
          onClick={onToggle}
        >
          {expanded ? 'Collapse' : `${memberCount} member${memberCount !== 1 ? 's' : ''}`}
        </Button>
      </div>

      {expanded && (
        <div style={{ padding: '0 14px 12px', borderTop: '1px solid #f0f0f0' }}>
          {role.entraMembers.length === 0 && role.fabricItemMembers.length === 0 ? (
            <Text size={200} style={{ color: '#aaa', display: 'block', paddingTop: 8 }}>No members.</Text>
          ) : (
            <>
              {role.entraMembers.length > 0 && (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 8 }}>
                  <thead>
                    <tr style={{ backgroundColor: '#f5f5f5' }}>
                      {['Name', 'Email', 'Type', 'External'].map(h => (
                        <th key={h} style={{
                          textAlign: 'left', padding: '6px 10px', fontWeight: 600,
                          color: '#555', borderBottom: '1px solid #e0e0e0', whiteSpace: 'nowrap',
                        }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {role.entraMembers.map(m => {
                      const external = isExternalMember(m);
                      return (
                        <tr key={m.objectId} style={{ borderBottom: '1px solid #f0f0f0' }}>
                          <td style={{ padding: '6px 10px' }}>{m.displayName}</td>
                          <td style={{ padding: '6px 10px', color: '#555' }}>{m.email ?? '—'}</td>
                          <td style={{ padding: '6px 10px' }}><TypeChip type={m.type} /></td>
                          <td style={{ padding: '6px 10px' }}>
                            {external
                              ? <span style={{ color: '#c50f1f', fontSize: 12, fontWeight: 600 }}>⚠ External</span>
                              : <span style={{ color: '#1e6b33', fontSize: 12 }}>✓ Internal</span>
                            }
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              {role.fabricItemMembers.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  {role.fabricItemMembers.map((m, i) => {
                    const label = m.resolvedWorkspace
                      ? `${m.resolvedItem} (in ${m.resolvedWorkspace})`
                      : m.resolvedItem;
                    return (
                      <div key={i}>
                        <Text size={200} style={{ color: '#888', fontStyle: 'italic' }}>
                          Users with <strong>{m.itemAccess.join(', ')}</strong> on <strong>{label}</strong>:
                        </Text>
                        {m.expandedUsers.length > 0 ? (
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 6 }}>
                            <thead>
                              <tr style={{ backgroundColor: '#f5f5f5' }}>
                                {['Name', 'Email', 'Type'].map(h => (
                                  <th key={h} style={{
                                    textAlign: 'left', padding: '6px 10px', fontWeight: 600,
                                    color: '#555', borderBottom: '1px solid #e0e0e0', whiteSpace: 'nowrap',
                                  }}>{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {m.expandedUsers.map((u, j) => (
                                <tr key={j} style={{ borderBottom: '1px solid #f0f0f0' }}>
                                  <td style={{ padding: '6px 10px' }}>{u.displayName}</td>
                                  <td style={{ padding: '6px 10px', color: '#555' }}>{u.email ?? '—'}</td>
                                  <td style={{ padding: '6px 10px' }}><TypeChip type={u.principalType as any} /></td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        ) : (
                          <div style={{ fontSize: 12, color: '#aaa', paddingLeft: 8, paddingTop: 4 }}>
                            Access determined by Fabric item permissions (members not enumerable)
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};

const OneLakeLakehouseCard: React.FC<{ lakehouse: OneLakeLakehouse }> = ({ lakehouse }) => {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sectionOpen, setSectionOpen] = useState(true);

  const toggleRole = (name: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const totalExternal = lakehouse.roles.reduce(
    (acc, r) => acc + r.entraMembers.filter(isExternalMember).length, 0
  );

  return (
    <div style={{ border: '1px solid #d0d8e8', borderRadius: 8, marginBottom: 12, backgroundColor: '#fff' }}>
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px',
          cursor: 'pointer', flexWrap: 'wrap',
        }}
        onClick={() => setSectionOpen(v => !v)}
      >
        {sectionOpen ? <ChevronDown20Regular /> : <ChevronRight20Regular />}
        <Text weight="semibold" style={{ flex: 1 }}>{lakehouse.name}</Text>
        <Text size={200} style={{ color: '#888' }}>
          {lakehouse.roles.length} role{lakehouse.roles.length !== 1 ? 's' : ''}
        </Text>
        {totalExternal > 0 && (
          <span style={{
            padding: '2px 7px', borderRadius: 4, fontSize: 11, fontWeight: 600,
            backgroundColor: '#fde8e8', color: '#c50f1f', border: '1px solid #c50f1f33',
          }}>⚠ {totalExternal} external</span>
        )}
      </div>
      {sectionOpen && (
        <div style={{ padding: '0 16px 12px', borderTop: '1px solid #f0f0f0' }}>
          {lakehouse.roles.map(role => (
            <OneLakeRoleCard
              key={role.name}
              role={role}
              expanded={expanded.has(role.name)}
              onToggle={() => toggleRole(role.name)}
            />
          ))}
        </div>
      )}
    </div>
  );
};

const ITEM_TYPE_LABELS: Record<string, string> = {
  SemanticModel:   'Semantic Model',
  Report:          'Report',
  Dashboard:       'Dashboard',
  PaginatedReport: 'Paginated Report',
};

const DirectItemShareCard: React.FC<{ share: DirectItemShare }> = ({ share }) => {
  const [open, setOpen] = useState(true);
  const externalCount = share.users.filter(u => u.isExternal).length;
  return (
    <div style={{ border: '1px solid #d0d8e8', borderRadius: 8, marginBottom: 10, backgroundColor: '#fff' }}>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', cursor: 'pointer', flexWrap: 'wrap' }}
        onClick={() => setOpen(v => !v)}
      >
        {open ? <ChevronDown20Regular /> : <ChevronRight20Regular />}
        <Text weight="semibold" style={{ flex: 1 }}>{share.itemName}</Text>
        <span style={{ fontSize: 12, color: '#888' }}>{ITEM_TYPE_LABELS[share.itemType] ?? share.itemType}</span>
        <span style={{ fontSize: 12, color: '#666' }}>{share.users.length} user{share.users.length !== 1 ? 's' : ''}</span>
        {externalCount > 0 && (
          <span style={{
            padding: '2px 7px', borderRadius: 4, fontSize: 11, fontWeight: 600,
            backgroundColor: '#fde8e8', color: '#c50f1f', border: '1px solid #c50f1f33',
          }}>⚠ {externalCount} external</span>
        )}
      </div>
      {open && (
        <div style={{ borderTop: '1px solid #f0f0f0' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ backgroundColor: '#f5f5f5' }}>
                {['Name', 'Email', 'Type', 'Access', 'External'].map(h => (
                  <th key={h} style={{
                    textAlign: 'left', padding: '6px 10px', fontWeight: 600,
                    color: '#555', borderBottom: '1px solid #e0e0e0', whiteSpace: 'nowrap',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {share.users.map((u, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #f0f0f0' }}>
                  <td style={{ padding: '6px 10px' }}>{u.displayName}</td>
                  <td style={{ padding: '6px 10px', color: '#555' }}>{u.email ?? u.identifier ?? '—'}</td>
                  <td style={{ padding: '6px 10px' }}><TypeChip type={u.principalType as any} /></td>
                  <td style={{ padding: '6px 10px', fontSize: 12 }}>
                    <span style={{ padding: '2px 6px', borderRadius: 4, backgroundColor: '#f0f0f0', color: '#444' }}>
                      {u.accessRight}
                    </span>
                  </td>
                  <td style={{ padding: '6px 10px' }}>
                    {u.isExternal
                      ? <span style={{ color: '#c50f1f', fontSize: 12, fontWeight: 600 }}>⚠ External</span>
                      : <span style={{ color: '#1e6b33', fontSize: 12 }}>✓ Internal</span>
                    }
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
  const [auditRetentionDays, setAuditRetentionDays] = useState<number | null>(null);

  const loadReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [data, days] = await Promise.all([
        client.getWorkspaceAccess(workspaceId),
        client.getAuditLogRetentionDays(),
      ]);
      setReport(data);
      setAuditRetentionDays(days);
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
    setRevokeError(null);
    setRevoking(prev => new Set(prev).add(`${groupId}:${memberId}`));
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
        next.delete(`${groupId}:${memberId}`);
        return next;
      });
    }
  }, [client]);

  const handleRefresh = useCallback(() => {
    setRevokeError(null);
    loadReport();
  }, [loadReport]);

  const assignments = useMemo(() => report?.assignments ?? [], [report]);
  const oneLakeSecurity = useMemo(() => report?.oneLakeSecurity ?? [], [report]);
  const directItemShares = useMemo(() => report?.directItemShares ?? [], [report]);

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
        <>
          {auditRetentionDays != null && (
            <Text size={100} style={{ color: '#888', display: 'block', marginBottom: 12 }}>
              ℹ️ Audit log retention: <strong>{auditRetentionDays} days</strong>. Members added more than {auditRetentionDays} days ago show — for their added date.
            </Text>
          )}
          {assignments.map(assignment => (
            <AssignmentCard
              key={assignment.id}
              assignment={assignment}
              expanded={expanded.has(assignment.id)}
              revoking={revoking}
              auditRetentionDays={auditRetentionDays}
              onToggle={handleToggleExpand}
              onRevoke={handleRevoke}
            />
          ))}
        </>
      )}

      {oneLakeSecurity.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <Text size={400} weight="semibold" style={{ display: 'block', marginBottom: 12 }}>
            OneLake Security
          </Text>
          {oneLakeSecurity.map(lh => (
            <OneLakeLakehouseCard key={lh.id} lakehouse={lh} />
          ))}
        </div>
      )}

      {directItemShares.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <Text size={400} weight="semibold" style={{ display: 'block', marginBottom: 4 }}>
            Direct Item Shares
          </Text>
          <Text size={200} style={{ color: '#888', display: 'block', marginBottom: 12 }}>
            Users with access granted directly on individual items (not via workspace role).
          </Text>
          {directItemShares.map(share => (
            <DirectItemShareCard key={share.itemId} share={share} />
          ))}
        </div>
      )}
    </div>
  );
};
