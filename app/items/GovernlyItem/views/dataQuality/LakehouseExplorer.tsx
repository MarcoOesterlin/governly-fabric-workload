import React, { useCallback, useEffect, useRef, useState } from 'react';
import { GovernlyApiClient, Lakehouse, LakehouseTable } from '../../../../clients/GovernlyApiClient';
import { TableColumn, DqTableSelection } from './dqTypes';

interface Props {
  apiClient: GovernlyApiClient;
  workspaceId: string;
  selection: DqTableSelection[];
  onSelectionChange: (selection: DqTableSelection[]) => void;
  onLakehouseChange: (lakehouse: Lakehouse | null) => void;
}

const COL_STYLE: React.CSSProperties = {
  width: 220, minWidth: 180, borderRight: '1px solid #e0e0e0',
  overflowY: 'auto', display: 'flex', flexDirection: 'column',
};
const HEADER: React.CSSProperties = {
  padding: '8px 12px', fontWeight: 600, fontSize: 12, color: '#555',
  borderBottom: '1px solid #e0e0e0', background: '#fafafa', flexShrink: 0,
  display: 'flex', alignItems: 'center', gap: 6,
};
const ITEM = (active: boolean): React.CSSProperties => ({
  padding: '7px 12px', cursor: 'pointer', fontSize: 13,
  background: active ? '#e8f0fe' : 'transparent',
  color: active ? '#0f6cbd' : '#333',
  fontWeight: active ? 600 : 400,
  display: 'flex', alignItems: 'center', gap: 8,
  borderLeft: active ? '3px solid #0f6cbd' : '3px solid transparent',
  minWidth: 0,
});

export const LakehouseExplorer: React.FC<Props> = ({ apiClient, workspaceId, selection, onSelectionChange, onLakehouseChange }) => {
  const [lakehouses, setLakehouses] = useState<Lakehouse[]>([]);
  const [lhLoading, setLhLoading] = useState(false);
  const [selectedLh, setSelectedLh] = useState<Lakehouse | null>(null);

  const [tables, setTables] = useState<LakehouseTable[]>([]);
  const [tblLoading, setTblLoading] = useState(false);
  const [focusedTable, setFocusedTable] = useState<string | null>(null);

  const [columns, setColumns] = useState<TableColumn[]>([]);
  const [colLoading, setColLoading] = useState(false);
  const [selectingAll, setSelectingAll] = useState(false);

  const selectionRef = useRef(selection);
  const justAddedRef = useRef<string | null>(null);
  useEffect(() => { selectionRef.current = selection; }, [selection]);

  useEffect(() => {
    setLhLoading(true);
    apiClient.listLakehouses(workspaceId)
      .then(all => setLakehouses(all.filter(lh => lh.displayName.toLowerCase() !== 'governly_dq')))
      .catch(console.error)
      .finally(() => setLhLoading(false));
  }, [apiClient, workspaceId]);

  const selectLakehouse = useCallback((lh: Lakehouse) => {
    setSelectedLh(lh);
    onLakehouseChange(lh);
    onSelectionChange([]);
    setFocusedTable(null);
    setColumns([]);
    setTblLoading(true);
    apiClient.listLakehouseTables(workspaceId, lh.id)
      .then(setTables)
      .catch(console.error)
      .finally(() => setTblLoading(false));
  }, [apiClient, workspaceId, onLakehouseChange, onSelectionChange]);

  const focusTable = useCallback((tableName: string) => {
    if (!selectedLh) return;
    setFocusedTable(tableName);
    setColLoading(true);
    setColumns([]);
    apiClient.getTableSchema(workspaceId, selectedLh.id, tableName)
      .then(cols => {
        setColumns(cols);
        if (justAddedRef.current === tableName) {
          justAddedRef.current = null;
          const allColNames = cols.map(c => c.name);
          onSelectionChange(selectionRef.current.map(s =>
            s.tableName === tableName ? { ...s, columns: allColNames } : s
          ));
        }
      })
      .catch(() => setColumns([]))
      .finally(() => setColLoading(false));
  }, [apiClient, workspaceId, selectedLh, onSelectionChange]);

  const toggleTable = useCallback((tableName: string) => {
    const exists = selection.find(s => s.tableName === tableName);
    if (exists) {
      onSelectionChange(selection.filter(s => s.tableName !== tableName));
    } else {
      justAddedRef.current = tableName;
      const newSel = [...selection, { tableName, columns: [] }];
      selectionRef.current = newSel;
      onSelectionChange(newSel);
      focusTable(tableName);
    }
  }, [selection, onSelectionChange, focusTable]);

  const toggleColumn = useCallback((tableName: string, colName: string) => {
    onSelectionChange(selection.map(s => {
      if (s.tableName !== tableName) return s;
      const cols = s.columns.includes(colName)
        ? s.columns.filter(c => c !== colName)
        : [...s.columns, colName];
      return { ...s, columns: cols };
    }));
  }, [selection, onSelectionChange]);

  const toggleAllColumns = useCallback((tableName: string) => {
    const all = columns.map(c => c.name);
    onSelectionChange(selection.map(s => {
      if (s.tableName !== tableName) return s;
      const allSelected = all.every(c => s.columns.includes(c));
      return { ...s, columns: allSelected ? [] : all };
    }));
  }, [selection, onSelectionChange, columns]);

  const selectAllTables = useCallback(async () => {
    if (!selectedLh || tables.length === 0) return;
    setSelectingAll(true);
    try {
      const results = await Promise.all(
        tables.map(async t => {
          const cols = await apiClient.getTableSchema(workspaceId, selectedLh.id, t.name);
          return { tableName: t.name, columns: cols.map(c => c.name) };
        })
      );
      const valid = results.filter(r => r.columns.length > 0);
      onSelectionChange(valid);
      if (valid.length > 0) {
        const last = valid[valid.length - 1];
        setFocusedTable(last.tableName);
        const cols = await apiClient.getTableSchema(workspaceId, selectedLh.id, last.tableName);
        setColumns(cols);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setSelectingAll(false);
    }
  }, [selectedLh, tables, apiClient, workspaceId, onSelectionChange]);

  const focusedSelection = selection.find(s => s.tableName === focusedTable);

  return (
    <div style={{ display: 'flex', height: '100%', fontSize: 13 }}>
      {/* Lakehouses */}
      <div style={COL_STYLE}>
        <div style={HEADER}>Lakehouses</div>
        {lhLoading && <div style={{ padding: 12, color: '#888' }}>Loading...</div>}
        {lakehouses.map(lh => (
          <div key={lh.id} style={ITEM(selectedLh?.id === lh.id)} onClick={() => selectLakehouse(lh)}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {lh.displayName}
            </span>
          </div>
        ))}
      </div>

      {/* Tables */}
      <div style={COL_STYLE}>
        <div style={HEADER}>
          <span style={{ flex: 1 }}>
            Tables{selection.length > 0 && <span style={{ color: '#0f6cbd' }}> ({selection.length})</span>}
          </span>
          {selectedLh && tables.length > 0 && (
            <span
              style={{ color: '#0f6cbd', cursor: 'pointer', fontWeight: 400, fontSize: 11, flexShrink: 0 }}
              onClick={selectAllTables}
            >
              {selectingAll ? 'Loading...' : 'Select all'}
            </span>
          )}
        </div>
        {tblLoading && <div style={{ padding: 12, color: '#888' }}>Loading...</div>}
        {!selectedLh && !tblLoading && <div style={{ padding: 12, color: '#aaa' }}>Select a lakehouse</div>}
        {tables.map(t => {
          const checked = !!selection.find(s => s.tableName === t.name);
          const colCount = selection.find(s => s.tableName === t.name)?.columns.length ?? 0;
          return (
            <div key={t.name} style={{ ...ITEM(focusedTable === t.name), justifyContent: 'space-between' }}>
              <div
                style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}
                onClick={() => toggleTable(t.name)}
              >
                <input type="checkbox" checked={checked} onChange={() => toggleTable(t.name)} onClick={e => e.stopPropagation()} style={{ margin: 0, flexShrink: 0 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t.name}
                </span>
              </div>
              {checked && (
                <span style={{ fontSize: 11, color: '#0f6cbd', cursor: 'pointer', flexShrink: 0, marginLeft: 4 }} onClick={() => focusTable(t.name)}>
                  {colCount} cols
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Columns */}
      <div style={{ ...COL_STYLE, borderRight: 'none', flex: 1 }}>
        <div style={HEADER}>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            Columns{focusedTable ? ` - ${focusedTable}` : ''}
          </span>
          {focusedTable && focusedSelection && columns.length > 0 && (
            <span
              style={{ color: '#0f6cbd', cursor: 'pointer', fontWeight: 400, fontSize: 11, flexShrink: 0 }}
              onClick={() => toggleAllColumns(focusedTable)}
            >
              {columns.every(c => focusedSelection.columns.includes(c.name)) ? 'Deselect all' : 'Select all'}
            </span>
          )}
        </div>
        {colLoading && <div style={{ padding: 12, color: '#888' }}>Loading schema...</div>}
        {!focusedTable && !colLoading && <div style={{ padding: 12, color: '#aaa' }}>Select a table</div>}
        {focusedSelection && columns.map(col => {
          const checked = focusedSelection.columns.includes(col.name);
          return (
            <div key={col.name} style={ITEM(checked)} onClick={() => toggleColumn(focusedTable!, col.name)}>
              <input type="checkbox" checked={checked} onChange={() => {}} style={{ margin: 0, flexShrink: 0 }} />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{col.name}</span>
              <span style={{ fontSize: 11, color: '#888', flexShrink: 0, marginLeft: 4 }}>{col.dataType}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};
