import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  MessageBar,
  MessageBarBody,
  Spinner,
  Text,
  tokens,
} from '@fluentui/react-components';
import { ArrowClockwise24Regular } from '@fluentui/react-icons';
import { GovernlyApiClient, DataAgentLogEntry, DataAgentLogsReport } from '../../../clients/GovernlyApiClient';
import { formatDateTime, DAY_OPTIONS, thStyle, tdStyle } from './auditShared';

interface DataAgentLogsViewProps {
  workspaceId: string;
  client: GovernlyApiClient;
}

export const DataAgentLogsView: React.FC<DataAgentLogsViewProps> = ({ workspaceId, client }) => {
  const [report, setReport]           = useState<DataAgentLogsReport | null>(null);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState<string | null>(null);
  const [days, setDays]               = useState(7);
  const [filterAgent, setFilterAgent] = useState('');
  const [hoveredRowId, setHoveredRowId] = useState<string | null>(null);

  const loadReport = useCallback(async (d: number) => {
    setLoading(true);
    setError(null);
    setReport(null);
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
        <Text size={500} weight="semibold">Data Agent Logs</Text>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <label htmlFor="agent-logs-days-select" style={{ fontSize: 13, color: tokens.colorNeutralForeground3 }}>Last</label>
          <select
            id="agent-logs-days-select"
            value={days}
            onChange={e => { setDays(Number(e.target.value)); setFilterAgent(''); }}
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
              ? `Data agent log query failed: ${report.error}. Check that the Fabric CLI token has Fabric Admin permissions.`
              : 'Results may be incomplete — some daily chunks failed (Fabric Admin API may require tenant admin permissions).'}
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
          No data agent activity found for this workspace in the last {days} days.
          {' '}This may mean the Fabric Admin Activity Events API returned no data agent events, or the agent has not been used recently.
        </Text>
      )}

      {/* Filter + Table */}
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
                  <tr
                    key={entry.id}
                    style={{ transition: 'background 0.1s', background: hoveredRowId === entry.id ? tokens.colorNeutralBackground2 : '' }}
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
