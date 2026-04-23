import React, { useCallback, useEffect, useState } from 'react';
import { GovernlyApiClient } from '../../../../clients/GovernlyApiClient';
import { DqRunMeta, DqFailedRow, DQ_DIMENSION_LABELS, DqDimension, DARK_THEME, LIGHT_THEME } from './dqTypes';

interface Props {
  apiClient: GovernlyApiClient;
  workspaceId: string;
  darkMode: boolean;
  initialRuns: DqRunMeta[];
  initialFailedRows: { rows: DqFailedRow[]; total: number } | null;
  preloadLoading: boolean;
  /** Pre-select a table filter when navigating here from Table Health */
  initialTableFilter?: string;
}

const PAGE_SIZE = 50;

export const FailedRowsTab: React.FC<Props> = ({ apiClient, workspaceId, darkMode, initialRuns, initialFailedRows, preloadLoading, initialTableFilter }) => {
  const t = darkMode ? DARK_THEME : LIGHT_THEME;

  const [runs, setRuns]         = useState<DqRunMeta[]>(initialRuns);
  const [allRows, setAllRows]   = useState<DqFailedRow[]>(initialFailedRows?.rows ?? []);
  const [page, setPage]         = useState(1);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);

  const [filterTable, setFilterTable]   = useState(initialTableFilter ?? '');
  const [filterColumn, setFilterColumn] = useState('');
  const [filterDim, setFilterDim]       = useState('');

  // Apply drill-through when initialTableFilter changes (navigation from Dashboard)
  useEffect(() => {
    setFilterTable(initialTableFilter ?? '');
    setFilterColumn('');
    setFilterDim('');
    setPage(1);
  }, [initialTableFilter]);

  // Sync when preloaded data arrives (contains all rows now)
  useEffect(() => { setRuns(initialRuns); }, [initialRuns]);
  useEffect(() => {
    if (initialFailedRows) {
      setAllRows(initialFailedRows.rows);
      setPage(1);
    }
  }, [initialFailedRows]);

  const latestRun = runs[0] ?? null;

  const loadAllRows = useCallback((runMeta: DqRunMeta) => {
    setLoading(true);
    setError(null);
    apiClient.getAllDqFailedRows(workspaceId, runMeta)
      .then(rows => { setAllRows(rows); setPage(1); setLoading(false); })
      .catch(err => { setError(err.message); setLoading(false); });
  }, [apiClient, workspaceId]);

  // Only fetch from API if we have no preloaded data for this run
  useEffect(() => {
    if (!latestRun) { setAllRows([]); return; }
    if (initialFailedRows !== null) return; // preload already provided all rows
    setFilterTable('');
    setFilterColumn('');
    setFilterDim('');
    loadAllRows(latestRun);
  }, [latestRun?.run_id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset to page 1 when filters change
  useEffect(() => { setPage(1); }, [filterTable, filterColumn, filterDim]);

  // Derive unique dropdown options from ALL rows
  const uniqueTables  = [...new Set(allRows.map(r => r.table_name))].sort();
  const uniqueColumns = [...new Set(allRows.map(r => r.column_name))].sort();
  const uniqueDims    = [...new Set(allRows.map(r => r.dimension))].sort() as DqDimension[];

  // Client-side filter + paginate
  const filtered    = allRows.filter(r =>
    (!filterTable  || r.table_name === filterTable) &&
    (!filterColumn || r.column_name === filterColumn) &&
    (!filterDim    || r.dimension === filterDim)
  );
  const totalPages  = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const displayRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const TH: React.CSSProperties = {
    padding: '8px 10px', fontWeight: 600, fontSize: 12, color: t.subtext,
    borderBottom: `2px solid ${t.border}`, textAlign: 'left', background: t.surface, whiteSpace: 'nowrap',
  };
  const TD: React.CSSProperties = {
    padding: '7px 10px', fontSize: 12, borderBottom: `1px solid ${t.border}`,
    verticalAlign: 'top', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    color: t.text,
  };

  const inputStyle: React.CSSProperties = {
    padding: '5px 8px', borderRadius: 4, border: `1px solid ${t.border}`,
    fontSize: 12, background: t.surface, color: t.text,
  };

  const latestLabel = latestRun
    ? `${latestRun.year}-${latestRun.month}-${latestRun.day} ${latestRun.run_id.slice(0,2)}:${latestRun.run_id.slice(2,4)}:${latestRun.run_id.slice(4,6)} UTC`
    : '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: t.bg, color: t.text }}>
      {/* Controls */}
      <div style={{ padding: '12px 16px', borderBottom: `1px solid ${t.border}`, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', flexShrink: 0, background: t.surface }}>
        {latestLabel && (
          <span style={{ fontSize: 12, color: t.subtext, padding: '5px 10px', background: t.bg, borderRadius: 4, border: `1px solid ${t.border}` }}>
            Latest run: <strong style={{ color: t.text }}>{latestLabel}</strong>
          </span>
        )}

        <div style={{ width: 1, height: 20, background: t.border }} />

        <select value={filterTable} onChange={e => setFilterTable(e.target.value)} style={inputStyle}>
          <option value="">All tables</option>
          {uniqueTables.map(tb => <option key={tb} value={tb}>{tb}</option>)}
        </select>

        <select value={filterColumn} onChange={e => setFilterColumn(e.target.value)} style={inputStyle}>
          <option value="">All columns</option>
          {uniqueColumns.map(c => <option key={c} value={c}>{c}</option>)}
        </select>

        <select value={filterDim} onChange={e => setFilterDim(e.target.value)} style={inputStyle}>
          <option value="">All dimensions</option>
          {uniqueDims.map(d => <option key={d} value={d}>{DQ_DIMENSION_LABELS[d]}</option>)}
        </select>

        {(loading || preloadLoading) && <span style={{ fontSize: 12, color: t.muted }}>Loading…</span>}
        {error   && <span style={{ fontSize: 12, color: t.fail }}>{error}</span>}

        <span style={{ marginLeft: 'auto', fontSize: 12, color: t.subtext }}>
          {filterTable || filterColumn || filterDim
            ? `${filtered.length} of ${allRows.length} failed row${allRows.length !== 1 ? 's' : ''}`
            : `${allRows.length} failed row${allRows.length !== 1 ? 's' : ''} total`
          }
        </span>
      </div>

      {/* Table */}
      <div style={{ flex: 1, overflowY: 'auto', background: t.bg }}>
        {!latestRun && !loading && !preloadLoading && (
          <div style={{ padding: 32, color: t.muted, textAlign: 'center', fontSize: 14 }}>
            No DQ runs found. Run a notebook from the Configure tab first.
            <div style={{ fontSize: 12, marginTop: 8, color: t.subtext }}>Results are stored in the Governly_DQ lakehouse.</div>
          </div>
        )}
        {latestRun && filtered.length === 0 && !loading && (
          <div style={{ padding: 32, color: t.subtext, textAlign: 'center', fontSize: 14 }}>
            {allRows.length === 0 ? 'All checks passed — no failed rows.' : 'No rows match the current filters.'}
          </div>
        )}

        {displayRows.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>
                <th style={TH}>Table</th>
                <th style={TH}>Column</th>
                <th style={TH}>Dimension</th>
                <th style={TH}>Reason</th>
                <th style={TH}>Rule ID</th>
                <th style={{ ...TH, maxWidth: 260 }}>Values</th>
              </tr>
            </thead>
            <tbody>
              {displayRows.map((row, i) => (
                <tr key={i} style={{ background: i % 2 === 0 ? t.bg : t.surface }}>
                  <td style={TD}>{row.table_name}</td>
                  <td style={TD}>{row.column_name}</td>
                  <td style={TD}>
                    <span style={{ padding: '2px 6px', borderRadius: 3, background: `${t.fail}22`, color: t.fail, fontWeight: 600, fontSize: 11 }}>
                      {DQ_DIMENSION_LABELS[row.dimension] ?? row.dimension}
                    </span>
                  </td>
                  <td style={{ ...TD, maxWidth: 200, color: t.fail }}>
                    {row.failure_reason ?? '—'}
                  </td>
                  <td style={{ ...TD, fontFamily: 'monospace', fontSize: 11 }}>{row.rule_id}</td>
                  <td style={{ ...TD, maxWidth: 260, fontFamily: 'monospace', fontSize: 11 }} title={row.raw_values}>
                    {row.raw_values?.length > 110 ? row.raw_values.slice(0, 110) + '…' : row.raw_values}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {filtered.length > PAGE_SIZE && (
        <div style={{ padding: '8px 16px', borderTop: `1px solid ${t.border}`, display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, flexShrink: 0, background: t.surface, color: t.subtext }}>
          <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1 || loading}
            style={{ padding: '4px 10px', borderRadius: 4, border: `1px solid ${t.border}`, cursor: 'pointer', background: t.bg, color: t.text }}>
            ‹ Prev
          </button>
          <span>Page {page} of {totalPages}</span>
          <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages || loading}
            style={{ padding: '4px 10px', borderRadius: 4, border: `1px solid ${t.border}`, cursor: 'pointer', background: t.bg, color: t.text }}>
            Next ›
          </button>
        </div>
      )}
    </div>
  );
};
