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
import { GovernlyApiClient, DataAgentLogEntry, DataAgentLogsReport } from '../../../clients/GovernlyApiClient';
import { formatDateTime, thStyle, tdStyle } from './auditShared';

interface DataAgentLogsViewProps {
  workspaceId: string;
  client: GovernlyApiClient;
}

export const DataAgentLogsView: React.FC<DataAgentLogsViewProps> = ({ workspaceId, client }) => {
  const [report, setReport]             = useState<DataAgentLogsReport | null>(null);
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState<string | null>(null);
  const [days, setDays]                 = useState(30);
  const [filterAgent, setFilterAgent]   = useState('');
  const [hoveredRowId, setHoveredRowId] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<DataAgentLogEntry | null>(null);

  const loadReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await client.getDataAgentLogs(workspaceId, days);
      setReport(prev => {
        if (!prev) return data;
        const seenIds = new Set(data.entries.map(e => e.id));
        const merged = [
          ...data.entries,
          ...prev.entries.filter(e => !seenIds.has(e.id)),
        ].sort((a, b) => b.createdDateTime.localeCompare(a.createdDateTime));
        return { ...data, entries: merged };
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [client, workspaceId, days]);

  useEffect(() => { loadReport(); }, [loadReport]);

  const handleRefresh = useCallback(() => loadReport(), [loadReport]);

  const { uniqueAgents, agentCounts, filtered } = useMemo(() => {
    const entries: DataAgentLogEntry[] = report?.entries ?? [];
    const counts: Record<string, number> = {};
    for (const e of entries) {
      const key = e.agentName || e.agentId || '';
      if (key) counts[key] = (counts[key] ?? 0) + 1;
    }
    return {
      uniqueAgents: Object.keys(counts).sort(),
      agentCounts : counts,
      filtered    : entries.filter(e => !filterAgent || (e.agentName || e.agentId || '') === filterAgent),
    };
  }, [report, filterAgent]);

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Text size={500} weight="semibold">Fabric Data Agent Logs</Text>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <select
            value={days}
            onChange={e => setDays(Number(e.target.value))}
            style={{ fontSize: 13, padding: '2px 6px', borderRadius: 4, border: `1px solid ${tokens.colorNeutralStroke1}` }}
          >
            {[7, 14, 30].map(d => <option key={d} value={d}>Last {d} days</option>)}
          </select>
          <Button icon={<ArrowClockwise24Regular />} onClick={handleRefresh} appearance="subtle" aria-label="Refresh" />
        </div>
      </div>

      {report?.partial && (
        <MessageBar intent="warning">
          <MessageBarBody>
            {report.error
              ? `Fabric Data Agent log query failed: ${report.error}`
              : 'Results may be incomplete — some daily chunks failed.'}
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
          No data agent activity found for this workspace in the past year.
        </Text>
      )}

      {/* Filter + Table + Detail panel */}
      {!loading && !error && report && report.entries.length > 0 && (
        <>
          {uniqueAgents.length > 1 && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <label htmlFor="agent-logs-agent-filter" style={{ fontSize: 13, color: tokens.colorNeutralForeground3 }}>Filter by agent:</label>
              <select
                id="agent-logs-agent-filter"
                value={filterAgent}
                onChange={e => setFilterAgent(e.target.value)}
                style={{ fontSize: 13, padding: '2px 6px', borderRadius: 4, border: `1px solid ${tokens.colorNeutralStroke1}` }}
              >
                <option value="">All agents ({report.entries.length})</option>
                {uniqueAgents.map(a => (
                  <option key={a} value={a}>{a} ({agentCounts[a]})</option>
                ))}
              </select>
            </div>
          )}

          <div style={{ display: 'flex', gap: 0, alignItems: 'flex-start', minHeight: 0 }}>
            {/* Table */}
            <div style={{ flex: selectedEntry ? '0 0 55%' : '1 1 auto', overflowX: 'auto', minWidth: 0 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr>
                    {['Time', 'User', 'Agent', 'Operation', 'Result'].map(h => (
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
                      <td style={tdStyle}>
                        <span style={{ fontWeight: 500 }}>{entry.agentName || '—'}</span>
                        {entry.agentId && (
                          <div style={{ fontSize: 11, color: tokens.colorNeutralForeground3 }}>{entry.agentId}</div>
                        )}
                      </td>
                      <td style={{ ...tdStyle, color: tokens.colorNeutralForeground3 }}>{entry.operationName || '—'}</td>
                      <td style={{ ...tdStyle, color: entry.result === 'Succeeded' ? tokens.colorPaletteGreenForeground1 : tokens.colorNeutralForeground3 }}>
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
                gap: 12,
                minWidth: 0,
                overflowY: 'auto',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Text weight="semibold" size={400}>{selectedEntry.operationName || 'Event Details'}</Text>
                  <Button
                    appearance="subtle"
                    icon={<Dismiss24Regular />}
                    onClick={() => setSelectedEntry(null)}
                    aria-label="Close"
                  />
                </div>

            {/* Summary fields — skip empty values */}
            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '5px 16px', fontSize: 13 }}>
              {((() => {
                const ad = (selectedEntry.raw?.['auditData'] ?? {}) as Record<string, unknown>;
                const ced = (ad['CopilotEventData'] ?? {}) as Record<string, unknown>;
                return [
                  ['Time',           selectedEntry.createdDateTime ? formatDateTime(selectedEntry.createdDateTime) : null],
                  ['Operation',      selectedEntry.operationName],
                  ['Result',         selectedEntry.result],
                  ['User',           selectedEntry.userPrincipalName || selectedEntry.userId],
                  ['Client IP',      selectedEntry.clientIP],
                  ['User Agent',     selectedEntry.userAgent],
                  ['Workspace',      selectedEntry.workspaceName || selectedEntry.workspaceId],
                  ['Workspace ID',   selectedEntry.workspaceId],
                  ['Agent',          (ad['AgentName'] || selectedEntry.agentName) as string | undefined],
                  ['Agent ID',       (ad['AgentId'] || selectedEntry.agentId) as string | undefined],
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
                  ['Record Type',    selectedEntry.raw?.['RecordType'] as string | undefined],
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
                      <div key={i} style={{
                        background: tokens.colorNeutralBackground2,
                        borderRadius: 4,
                        padding: '8px 12px',
                        fontSize: 12,
                        display: 'grid',
                        gridTemplateColumns: 'auto 1fr',
                        gap: '3px 12px',
                      }}>
                        {[
                          ['Name',   r['Name']],
                          ['Type',   r['Type'] || r['ArtifactKind']],
                          ['Action', r['Action']],
                          ['Status', r['Status']],
                          ['ID',     r['Id']],
                          ['URL',    r['SiteUrl']],
                        ].filter(([, v]) => v).map(([k, v]) => (
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
                      <div key={i} style={{
                        background: tokens.colorNeutralBackground2,
                        borderRadius: 4,
                        padding: '6px 12px',
                        fontSize: 12,
                        display: 'grid',
                        gridTemplateColumns: 'auto 1fr',
                        gap: '3px 12px',
                      }}>
                        {[
                          ['Name',    a['AgentName']],
                          ['ID',      a['AgentId']],
                          ['Version', a['AgentVersion']],
                        ].filter(([, v]) => v).map(([k, v]) => (
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

            {/* CopilotEventData — full formatted view */}
            {(() => {
              const ad = (selectedEntry.raw?.['auditData'] ?? {}) as Record<string, unknown>;
              const ced = ad['CopilotEventData'] as Record<string, unknown> | undefined;
              if (!ced) return null;

              // Fields to render inline (the rest are handled in dedicated sections)
              const SKIP = new Set(['AccessedResources', 'ParticipatingAgents', 'Messages']);
              const inlineFields = Object.entries(ced).filter(([k]) => !SKIP.has(k));
              const messages = ced['Messages'] as Array<Record<string, unknown>> | undefined;

              return (
                <div>
                  <Text size={200} weight="semibold" style={{ display: 'block', marginBottom: 8, color: tokens.colorNeutralForeground3 }}>
                    CopilotEventData
                  </Text>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {/* Inline scalar fields */}
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

                    {/* Messages */}
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

          <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
            Showing {filtered.length} of {report.entries.length} event{report.entries.length !== 1 ? 's' : ''} (up to 30 days via Fabric Activity Events API, accumulated across fetches) — click a row for details
          </Text>
        </>
      )}
    </div>
  );
};

