import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  MessageBar,
  MessageBarBody,
  Spinner,
  Text,
  tokens,
} from '@fluentui/react-components';
import { ArrowClockwise24Regular, Dismiss24Regular } from '@fluentui/react-icons';
import { GovernlyApiClient, WorkspaceActivityEntry, WorkspaceActivityReport } from '../../../clients/GovernlyApiClient';
import { formatDateTime, thStyle, tdStyle } from './auditShared';

interface ActivityLogsViewProps {
  workspaceId: string;
  client: GovernlyApiClient;
}

const DAY_OPTIONS = [7, 14, 30, 60, 90];

const selectStyle: React.CSSProperties = {
  fontSize: 13,
  padding: '3px 8px',
  borderRadius: 4,
  border: `1px solid ${tokens.colorNeutralStroke1}`,
  background: tokens.colorNeutralBackground1,
  color: tokens.colorNeutralForeground1,
  height: 30,
};

export const ActivityLogsView: React.FC<ActivityLogsViewProps> = ({ workspaceId, client }) => {
  const [report, setReport]               = useState<WorkspaceActivityReport | null>(null);
  const [loading, setLoading]             = useState(true);
  const [refreshing, setRefreshing]       = useState(false);
  const [error, setError]                 = useState<string | null>(null);
  const [noCacheYet, setNoCacheYet]       = useState(false);
  const [days, setDays]                   = useState(30);
  const [filterUser, setFilterUser]       = useState('');
  const [filterOperation, setFilterOperation] = useState('');
  const [filterRecordType, setFilterRecordType] = useState('');
  const [filterText, setFilterText]       = useState('');
  const [hoveredRowId, setHoveredRowId]   = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<WorkspaceActivityEntry | null>(null);

  // On mount: load from cache (fast). If no cache yet, show prompt.
  const loadFromCache = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNoCacheYet(false);
    setReport(null);
    setSelectedEntry(null);
    try {
      const data = await client.getCachedActivityLogs(workspaceId);
      setReport(data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('404') || msg.includes('No cached')) {
        setNoCacheYet(true);
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }, [client, workspaceId]);

  useEffect(() => { loadFromCache(); }, [loadFromCache]);

  // Refresh: fire background job, poll until done, then load from cache
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      await client.startActivityLogsRefresh(workspaceId, days);
      // Poll until job completes
      while (true) {
        await new Promise(r => setTimeout(r, 4000));
        const status = await client.getActivityLogsRefreshStatus(workspaceId);
        if (status.status === 'done') break;
        if (status.status === 'error') throw new Error(status.error ?? 'Refresh failed');
      }
      // Load the newly written run
      const data = await client.getCachedActivityLogs(workspaceId);
      setReport(data);
      setNoCacheYet(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }, [client, workspaceId, days]);

  const { uniqueUsers, uniqueOperations, uniqueRecordTypes, filtered } = useMemo(() => {
    const entries: WorkspaceActivityEntry[] = report?.entries ?? [];

    const users      = new Set<string>();
    const operations = new Set<string>();
    const recordTypes = new Set<string>();

    for (const e of entries) {
      const u = e.userPrincipalName || e.userId;
      if (u) users.add(u);
      if (e.operationName) operations.add(e.operationName);
      if (e.recordType) recordTypes.add(e.recordType);
    }

    const textLower = filterText.toLowerCase();
    const filteredEntries = entries.filter(e => {
      if (filterUser && (e.userPrincipalName || e.userId) !== filterUser) return false;
      if (filterOperation && e.operationName !== filterOperation) return false;
      if (filterRecordType && e.recordType !== filterRecordType) return false;
      if (filterText) {
        const haystack = [
          e.userPrincipalName, e.userId, e.operationName, e.recordType,
          e.itemName, e.itemType, e.result, e.workspaceName,
        ].join(' ').toLowerCase();
        if (!haystack.includes(textLower)) return false;
      }
      return true;
    });

    return {
      uniqueUsers: [...users].sort(),
      uniqueOperations: [...operations].sort(),
      uniqueRecordTypes: [...recordTypes].sort(),
      filtered: filteredEntries,
    };
  }, [report, filterUser, filterOperation, filterRecordType, filterText]);

  const clearFilters = () => {
    setFilterUser('');
    setFilterOperation('');
    setFilterRecordType('');
    setFilterText('');
  };

  const hasFilters = filterUser || filterOperation || filterRecordType || filterText;

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16, height: '100%', boxSizing: 'border-box' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
        <Text size={500} weight="semibold">Workspace Activity Logs</Text>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          {report?.lastRefreshed && (
            <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
              Last refreshed: {formatDateTime(report.lastRefreshed)}
            </Text>
          )}
          {/* Days selector — used when refreshing */}
          <select style={{ ...selectStyle, width: 100 }} value={days} onChange={e => setDays(Number(e.target.value))}>
            {DAY_OPTIONS.map(d => <option key={d} value={d}>Last {d} days</option>)}
          </select>
          <Button
            icon={refreshing ? <Spinner size="tiny" /> : <ArrowClockwise24Regular />}
            onClick={handleRefresh}
            disabled={refreshing}
            appearance="primary"
          >
            {refreshing ? 'Refreshing…' : 'Refresh Logs'}
          </Button>
        </div>
      </div>

      {report?.partial && (
        <MessageBar intent="warning" style={{ flexShrink: 0 }}>
          <MessageBarBody>
            {report.error
              ? `Activity log query failed: ${report.error}`
              : 'Results may be incomplete — some chunks timed out.'}
          </MessageBarBody>
        </MessageBar>
      )}

      {loading && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
          <Spinner label="Loading cached logs…" />
        </div>
      )}

      {!loading && noCacheYet && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, padding: 64 }}>
          <Text size={400} style={{ color: tokens.colorNeutralForeground3 }}>No cached logs yet.</Text>
          <Text size={300} style={{ color: tokens.colorNeutralForeground3 }}>
            Click <strong>Refresh Logs</strong> to query Purview and store results in the Governly_Insights lakehouse.
          </Text>
          <Button
            icon={refreshing ? <Spinner size="tiny" /> : <ArrowClockwise24Regular />}
            onClick={handleRefresh}
            disabled={refreshing}
            appearance="primary"
          >
            {refreshing ? 'Refreshing…' : 'Refresh Logs'}
          </Button>
        </div>
      )}

      {!loading && error && (
        <MessageBar intent="error" style={{ flexShrink: 0 }}>
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      {!loading && !noCacheYet && !error && report && (
        <>
          {/* Filter bar */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', flexShrink: 0 }}>
            {/* User */}
            <select style={selectStyle} value={filterUser} onChange={e => setFilterUser(e.target.value)}>
              <option value="">All users</option>
              {uniqueUsers.map(u => <option key={u} value={u}>{u}</option>)}
            </select>

            {/* Operation */}
            <select style={selectStyle} value={filterOperation} onChange={e => setFilterOperation(e.target.value)}>
              <option value="">All operations</option>
              {uniqueOperations.map(o => <option key={o} value={o}>{o}</option>)}
            </select>

            {/* Record Type */}
            <select style={selectStyle} value={filterRecordType} onChange={e => setFilterRecordType(e.target.value)}>
              <option value="">All record types</option>
              {uniqueRecordTypes.map(r => <option key={r} value={r}>{r}</option>)}
            </select>

            {/* Text search */}
            <input
              type="search"
              placeholder="Search…"
              value={filterText}
              onChange={e => setFilterText(e.target.value)}
              style={{ ...selectStyle, width: 180, padding: '3px 10px' }}
            />

            {hasFilters && (
              <Button size="small" appearance="subtle" onClick={clearFilters}>Clear filters</Button>
            )}

            <Text size={200} style={{ marginLeft: 'auto', color: tokens.colorNeutralForeground3, whiteSpace: 'nowrap' }}>
              {filtered.length} / {report.entries.length} event{report.entries.length !== 1 ? 's' : ''}
              {report.queryDays ? ` · last ${report.queryDays} days` : ''}
            </Text>
          </div>

          {report.entries.length === 0 ? (
            <Text style={{ color: tokens.colorNeutralForeground3 }}>
              No activity found in the cached logs. Try refreshing with a longer date range.
            </Text>
          ) : (
            <div style={{ display: 'flex', gap: 0, alignItems: 'flex-start', flex: 1, minHeight: 0, overflow: 'hidden' }}>
              {/* Table */}
              <div style={{ flex: selectedEntry ? '0 0 55%' : '1 1 auto', overflowY: 'auto', overflowX: 'auto', minWidth: 0, height: '100%' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr>
                      {['Time', 'User', 'Operation', 'Record Type', 'Item', 'Result'].map(h => (
                        <th key={h} style={thStyle}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(entry => (
                      <tr
                        key={entry.id}
                        onClick={() => setSelectedEntry(prev => prev?.id === entry.id ? null : entry)}
                        style={{
                          cursor: 'pointer',
                          transition: 'background 0.1s',
                          background: selectedEntry?.id === entry.id
                            ? tokens.colorBrandBackground2
                            : hoveredRowId === entry.id ? tokens.colorNeutralBackground2 : '',
                        }}
                        onMouseEnter={() => setHoveredRowId(entry.id)}
                        onMouseLeave={() => setHoveredRowId(null)}
                      >
                        <td style={{ ...tdStyle, whiteSpace: 'nowrap', color: tokens.colorNeutralForeground3 }}>
                          {formatDateTime(entry.createdDateTime)}
                        </td>
                        <td style={tdStyle}>{entry.userPrincipalName || entry.userId}</td>
                        <td style={{ ...tdStyle, fontWeight: 500 }}>{entry.operationName || '—'}</td>
                        <td style={{ ...tdStyle, color: tokens.colorNeutralForeground3, fontSize: 12 }}>{entry.recordType || '—'}</td>
                        <td style={tdStyle}>
                          {entry.itemName && <span>{entry.itemName}</span>}
                          {entry.itemType && (
                            <div style={{ fontSize: 11, color: tokens.colorNeutralForeground3 }}>{entry.itemType}</div>
                          )}
                        </td>
                        <td style={{
                          ...tdStyle,
                          color: entry.result === 'Succeeded' ? tokens.colorPaletteGreenForeground1 : tokens.colorNeutralForeground3,
                        }}>
                          {entry.result || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Detail panel */}
              {selectedEntry && (
                <div style={{
                  flex: '0 0 45%',
                  borderLeft: `1px solid ${tokens.colorNeutralStroke2}`,
                  padding: '0 0 0 20px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 14,
                  minWidth: 0,
                  overflowY: 'auto',
                  height: '100%',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
                    <Text weight="semibold" size={400}>{selectedEntry.operationName || 'Event Details'}</Text>
                    <Button
                      appearance="subtle"
                      icon={<Dismiss24Regular />}
                      onClick={() => setSelectedEntry(null)}
                      aria-label="Close"
                    />
                  </div>

                  {/* Summary fields */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '5px 16px', fontSize: 13 }}>
                    {((() => {
                      const ad = (selectedEntry.raw?.['auditData'] ?? {}) as Record<string, unknown>;
                      const ced = (ad['CopilotEventData'] ?? {}) as Record<string, unknown>;
                      return [
                        ['Time',           selectedEntry.createdDateTime ? formatDateTime(selectedEntry.createdDateTime) : null],
                        ['Operation',      selectedEntry.operationName],
                        ['Record Type',    selectedEntry.recordType],
                        ['Result',         selectedEntry.result],
                        ['User',           selectedEntry.userPrincipalName || selectedEntry.userId],
                        ['Client IP',      selectedEntry.clientIP],
                        ['User Agent',     selectedEntry.userAgent],
                        ['Workspace',      selectedEntry.workspaceName || selectedEntry.workspaceId],
                        ['Workspace ID',   selectedEntry.workspaceId],
                        ['Agent',          (ad['AgentName']) as string | undefined],
                        ['Agent ID',       (ad['AgentId']) as string | undefined],
                        ['Agent Version',  ad['AgentVersion'] as string | undefined],
                        ['App Identity',   ad['AppIdentity'] as string | undefined],
                        ['App Host',       (ced['AppHost'] || ad['ApplicationName']) as string | undefined],
                        ['Thread ID',      (ced['ThreadId'] || ced['CorrelationId']) as string | undefined],
                        ['Workload',       ad['Workload'] as string | undefined],
                        ['Item Type',      selectedEntry.itemType],
                        ['Item Name',      selectedEntry.itemName],
                        ['Item ID',        selectedEntry.itemId],
                        ['Object ID',      selectedEntry.objectId !== selectedEntry.itemId ? selectedEntry.objectId : null],
                        ['Service',        selectedEntry.service],
                        ['Correlation ID', selectedEntry.raw?.['CorrelationId'] as string | undefined],
                      ] as [string, string | null | undefined][];
                    })())
                      .filter(([, v]) => v)
                      .map(([label, value]) => (
                        <React.Fragment key={label}>
                          <span style={{ color: tokens.colorNeutralForeground3, whiteSpace: 'nowrap', fontWeight: 500 }}>{label}</span>
                          <span style={{ wordBreak: 'break-all' }}>{value}</span>
                        </React.Fragment>
                      ))}
                  </div>

                  {/* Accessed Resources */}
                  {(() => {
                    const ad = (selectedEntry.raw?.['auditData'] ?? {}) as Record<string, unknown>;
                    const ced = (ad['CopilotEventData'] ?? {}) as Record<string, unknown>;
                    const resources = ced['AccessedResources'] as Array<Record<string, unknown>> | undefined;
                    if (!resources?.length) return null;
                    return (
                      <div>
                        <Text size={200} weight="semibold" style={{ display: 'block', marginBottom: 6, color: tokens.colorNeutralForeground3 }}>
                          Accessed Resources ({resources.length})
                        </Text>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {resources.map((r, i) => (
                            <div key={i} style={{ background: tokens.colorNeutralBackground2, borderRadius: 4, padding: '8px 12px', fontSize: 12, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '3px 12px' }}>
                              {[['Name', r['Name']], ['Type', r['Type'] || r['ArtifactKind']], ['Action', r['Action']], ['Status', r['Status']], ['ID', r['Id']], ['URL', r['SiteUrl']]]
                                .filter(([, v]) => v)
                                .map(([k, v]) => (
                                  <React.Fragment key={String(k)}>
                                    <span style={{ color: tokens.colorNeutralForeground3, fontWeight: 500 }}>{String(k)}</span>
                                    <span style={{ wordBreak: 'break-all' }}>{String(v)}</span>
                                  </React.Fragment>
                                ))}
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Participating Agents */}
                  {(() => {
                    const ad = (selectedEntry.raw?.['auditData'] ?? {}) as Record<string, unknown>;
                    const ced = (ad['CopilotEventData'] ?? {}) as Record<string, unknown>;
                    const agents = ced['ParticipatingAgents'] as Array<Record<string, unknown>> | undefined;
                    if (!agents?.length) return null;
                    return (
                      <div>
                        <Text size={200} weight="semibold" style={{ display: 'block', marginBottom: 6, color: tokens.colorNeutralForeground3 }}>
                          Participating Agents ({agents.length})
                        </Text>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {agents.map((a, i) => (
                            <div key={i} style={{ background: tokens.colorNeutralBackground2, borderRadius: 4, padding: '6px 12px', fontSize: 12, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '3px 12px' }}>
                              {[['Name', a['AgentName']], ['ID', a['AgentId']], ['Version', a['AgentVersion']]]
                                .filter(([, v]) => v)
                                .map(([k, v]) => (
                                  <React.Fragment key={String(k)}>
                                    <span style={{ color: tokens.colorNeutralForeground3, fontWeight: 500 }}>{String(k)}</span>
                                    <span>{String(v)}</span>
                                  </React.Fragment>
                                ))}
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })()}

                  {/* CopilotEventData */}
                  {(() => {
                    const ad = (selectedEntry.raw?.['auditData'] ?? {}) as Record<string, unknown>;
                    const ced = ad['CopilotEventData'] as Record<string, unknown> | undefined;
                    if (!ced) return null;
                    const SKIP = new Set(['AccessedResources', 'ParticipatingAgents', 'Messages']);
                    const inlineFields = Object.entries(ced).filter(([k]) => !SKIP.has(k));
                    const messages = ced['Messages'] as Array<Record<string, unknown>> | undefined;
                    return (
                      <div>
                        <Text size={200} weight="semibold" style={{ display: 'block', marginBottom: 8, color: tokens.colorNeutralForeground3 }}>
                          CopilotEventData
                        </Text>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {inlineFields.length > 0 && (
                            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 16px', fontSize: 12, background: tokens.colorNeutralBackground2, borderRadius: 4, padding: '8px 12px' }}>
                              {inlineFields.map(([k, v]) => (
                                <React.Fragment key={k}>
                                  <span style={{ color: tokens.colorNeutralForeground3, fontWeight: 500 }}>{k}</span>
                                  <span style={{ wordBreak: 'break-all' }}>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
                                </React.Fragment>
                              ))}
                            </div>
                          )}
                          {messages && messages.length > 0 && (
                            <div>
                              <Text size={100} weight="semibold" style={{ display: 'block', marginBottom: 4, color: tokens.colorNeutralForeground3 }}>
                                Messages ({messages.length})
                              </Text>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                                {messages.map((m, i) => (
                                  <div key={i} style={{ background: tokens.colorNeutralBackground2, borderRadius: 4, padding: '5px 12px', fontSize: 12, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '3px 12px' }}>
                                    {Object.entries(m).map(([k, v]) => (
                                      <React.Fragment key={k}>
                                        <span style={{ color: tokens.colorNeutralForeground3, fontWeight: 500 }}>{k}</span>
                                        <span>{String(v)}</span>
                                      </React.Fragment>
                                    ))}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Raw event */}
                  <div>
                    <Text size={200} weight="semibold" style={{ display: 'block', marginBottom: 4, color: tokens.colorNeutralForeground3 }}>
                      Raw event
                    </Text>
                    <pre style={{
                      background: tokens.colorNeutralBackground2,
                      borderRadius: 4,
                      padding: '10px 14px',
                      fontSize: 12,
                      overflowX: 'auto',
                      overflowY: 'auto',
                      maxHeight: 400,
                      margin: 0,
                      whiteSpace: 'pre',
                      fontFamily: 'monospace',
                    }}>
                      {JSON.stringify(selectedEntry.raw ?? selectedEntry, null, 2)}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
};
