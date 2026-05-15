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
import { GovernlyApiClient, AuditRecord, FabricAuditReport } from '../../../clients/GovernlyApiClient';

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

export const PurviewAuditView: React.FC<PurviewAuditViewProps> = ({ workspaceId, client }) => {
  const [report, setReport]   = useState<FabricAuditReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [days, setDays]       = useState(30);
  const [filterOp, setFilterOp] = useState('');
  const [hoveredRowId, setHoveredRowId] = useState<string | null>(null);

  const loadReport = useCallback(async (d: number) => {
    setLoading(true);
    setError(null);
    setReport(null);
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

  const { uniqueOps, opCounts, filtered } = useMemo(() => {
    const records: AuditRecord[] = report?.records ?? [];
    const counts: Record<string, number> = {};
    for (const r of records) counts[r.operationName] = (counts[r.operationName] ?? 0) + 1;
    return {
      uniqueOps: Object.keys(counts).sort(),
      opCounts : counts,
      filtered : records.filter(r => !filterOp || r.operationName === filterOp),
    };
  }, [report, filterOp]);

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Text size={500} weight="semibold">Fabric Activity Log</Text>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <label htmlFor="purview-days-select" style={{ fontSize: 13, color: tokens.colorNeutralForeground3 }}>Last</label>
          <select
            id="purview-days-select"
            value={days}
            onChange={e => { setDays(Number(e.target.value)); setFilterOp(''); }}
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
            <label htmlFor="purview-op-filter" style={{ fontSize: 13, color: tokens.colorNeutralForeground3 }}>Filter by operation:</label>
            <select
              id="purview-op-filter"
              value={filterOp}
              onChange={e => setFilterOp(e.target.value)}
              style={{ fontSize: 13, padding: '2px 6px', borderRadius: 4, border: `1px solid ${tokens.colorNeutralStroke1}` }}
            >
              <option value="">All ({report.records.length})</option>
              {uniqueOps.map(op => (
                <option key={op} value={op}>{op} ({opCounts[op]})</option>
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
                  <tr key={record.id}
                    style={{
                      transition: 'background 0.1s',
                      background: hoveredRowId === record.id ? tokens.colorNeutralBackground2 : '',
                    }}
                    onMouseEnter={() => setHoveredRowId(record.id)}
                    onMouseLeave={() => setHoveredRowId(null)}>
                    <td style={{ ...tdStyle, whiteSpace: 'nowrap', color: tokens.colorNeutralForeground3 }}>
                      {formatDateTime(record.createdDateTime)}
                    </td>
                    <td style={tdStyle}>{record.userPrincipalName || record.userId}</td>
                    <td style={tdStyle}><OperationBadge operation={record.operationName} /></td>
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
