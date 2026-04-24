import React, { useCallback, useEffect, useRef, useState } from 'react';
import { GovernlyApiClient } from '../../../../clients/GovernlyApiClient';
import { DqRunMeta, DqFailedRow, DQ_DIMENSION_LABELS, DqDimension, DARK_THEME, LIGHT_THEME } from './dqTypes';

interface Props {
  apiClient: GovernlyApiClient;
  workspaceId: string;
  darkMode: boolean;
  initialRuns: DqRunMeta[];
  initialFailedRows: { rows: DqFailedRow[]; total: number } | null;
  preloadLoading: boolean;
  /** Pre-select a table filter when drilling from Table Health */
  initialTableFilter?: string;
  /** Pre-select a specific run when drilling from Table Health */
  initialRunId?: string;
}

const PAGE_SIZE = 50;

function mkRunLabel(r: DqRunMeta, isLatest: boolean) {
  return `${r.year}-${r.month}-${r.day}  ${r.run_id.slice(0, 2)}:${r.run_id.slice(2, 4)}:${r.run_id.slice(4, 6)} UTC${isLatest ? '  (latest)' : ''}`;
}

export const FailedRowsTab: React.FC<Props> = ({
  apiClient, workspaceId, darkMode, initialRuns, initialFailedRows, preloadLoading, initialTableFilter, initialRunId,
}) => {
  const t = darkMode ? DARK_THEME : LIGHT_THEME;

  const [runs, setRuns] = useState<DqRunMeta[]>(initialRuns);

  // Determine if we're starting on the latest run (preloaded data applies)
  const startRunId      = initialRunId ?? initialRuns[0]?.run_id ?? '';
  const startsOnLatest  = !initialRunId || initialRunId === initialRuns[0]?.run_id;

  const [selectedRunId, setSelectedRunId] = useState<string>(startRunId);
  const [allRows, setAllRows]   = useState<DqFailedRow[]>(
    startsOnLatest && initialFailedRows ? initialFailedRows.rows : []
  );
  const [page, setPage]         = useState(1);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);

  const [filterTable, setFilterTable]   = useState(initialTableFilter ?? '');
  const [filterColumn, setFilterColumn] = useState('');
  const [filterDim, setFilterDim]       = useState('');

  // Always-current ref to initialFailedRows so effects don't stale-close
  const preloadRef = useRef(initialFailedRows);
  preloadRef.current = initialFailedRows;

  // Track which run's rows are in allRows; prevents redundant fetches.
  // Only mark as loaded if preload actually provided rows — otherwise fetch from API.
  const lastLoadedRunRef = useRef<string>(startsOnLatest && initialFailedRows !== null ? startRunId : '');

  // Sync runs list when preload arrives
  useEffect(() => { setRuns(initialRuns); }, [initialRuns]);

  // Set selectedRunId once runs arrive if it was empty at mount
  useEffect(() => {
    if (!selectedRunId && initialRuns.length > 0) {
      setSelectedRunId(initialRunId ?? initialRuns[0].run_id);
    }
  }, [initialRuns]); // eslint-disable-line react-hooks/exhaustive-deps

  // Apply drill-through table filter on navigation from Dashboard
  useEffect(() => {
    setFilterTable(initialTableFilter ?? '');
    setFilterColumn('');
    setFilterDim('');
    setPage(1);
  }, [initialTableFilter]);

  // Apply drill-through run on navigation from Dashboard
  useEffect(() => {
    if (initialRunId) {
      lastLoadedRunRef.current = ''; // force reload
      setSelectedRunId(initialRunId);
    }
  }, [initialRunId]);

  // Load rows whenever selectedRunId changes or runs list arrives
  useEffect(() => {
    if (!runs.length || !selectedRunId) return;
    if (lastLoadedRunRef.current === selectedRunId) return;
    lastLoadedRunRef.current = selectedRunId;

    const latestRunId = runs[0].run_id;
    if (selectedRunId === latestRunId && preloadRef.current !== null) {
      setAllRows(preloadRef.current!.rows);
      setPage(1);
      return;
    }

    const runMeta = runs.find(r => r.run_id === selectedRunId);
    if (!runMeta) { lastLoadedRunRef.current = ''; return; }

    setLoading(true);
    setError(null);
    apiClient.getAllDqFailedRows(workspaceId, runMeta)
      .then(rows => { setAllRows(rows); setPage(1); setLoading(false); })
      .catch(err => { setError(err.message); setLoading(false); lastLoadedRunRef.current = ''; });
  }, [selectedRunId, runs.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset to page 1 when filters change
  useEffect(() => { setPage(1); }, [filterTable, filterColumn, filterDim]);

  // Change run from dropdown (clears column/dim filters, keeps table filter)
  const handleRunChange = useCallback((newRunId: string) => {
    if (newRunId === selectedRunId) return;
    lastLoadedRunRef.current = '';
    setSelectedRunId(newRunId);
    setFilterColumn('');
    setFilterDim('');
    setFilterTable('');
  }, [selectedRunId]);

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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: t.bg, color: t.text }}>
      {/* Controls */}
      <div style={{ padding: '12px 16px', borderBottom: `1px solid ${t.border}`, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', flexShrink: 0, background: t.surface }}>

        {/* Run selector */}
        <select value={selectedRunId} onChange={e => handleRunChange(e.target.value)} style={inputStyle}>
          {runs.length === 0
            ? <option value="">Loading runs…</option>
            : runs.map((r, i) => <option key={r.run_id} value={r.run_id}>{mkRunLabel(r, i === 0)}</option>)
          }
        </select>

        <div style={{ width: 1, height: 20, background: t.border }} />

        <select value={filterTable} onChange={e => setFilterTable(e.target.value)} style={inputStyle}>
          <option value="">All tables</option>
          {/* If drilled to a table not present in failed rows, show it as a placeholder option */}
          {filterTable && !uniqueTables.includes(filterTable) && (
            <option value={filterTable}>{filterTable} — no rows captured</option>
          )}
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
        {!runs.length && !loading && !preloadLoading && (
          <div style={{ padding: 32, color: t.muted, textAlign: 'center', fontSize: 14 }}>
            No DQ runs found. Run a notebook from the Configure tab first.
            <div style={{ fontSize: 12, marginTop: 8, color: t.subtext }}>Results are stored in the Governly_DQ lakehouse.</div>
          </div>
        )}
        {runs.length > 0 && filtered.length === 0 && !loading && (
          <div style={{ padding: 32, color: t.subtext, textAlign: 'center', fontSize: 14 }}>
            {allRows.length === 0
              ? 'All checks passed — no failed rows for this run.'
              : filterTable && !uniqueTables.includes(filterTable)
                ? <>
                    <div>No individual failed rows were captured for <strong style={{ color: t.text }}>{filterTable}</strong>.</div>
                    <div style={{ fontSize: 12, marginTop: 8, color: t.muted }}>
                      This can happen when a table has complex column types (arrays, structs) that prevented row capture.<br />
                      Re-run the DQ notebook to capture rows with the updated template.
                    </div>
                  </>
                : `No rows match the current filters. (${allRows.length} failed rows in this run)`}
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
