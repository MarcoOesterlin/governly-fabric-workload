import React, { useState, useCallback } from 'react';
import { WorkloadClientAPI } from '@ms-fabric/workload-client';
import { v4 as uuidv4 } from 'uuid';
import { GovernlyApiClient, Lakehouse } from '../../../../clients/GovernlyApiClient';
import { DqDimension, DQ_ACTIVE_DIMENSIONS, DqTableSelection, DqRunConfig, DQ_DEFAULT_THRESHOLDS, DARK_THEME, LIGHT_THEME } from './dqTypes';
import { LakehouseExplorer } from './LakehouseExplorer';
import { DimensionPicker } from './DimensionPicker';

interface Props {
  apiClient: GovernlyApiClient;
  workspaceId: string;
  workloadClient: WorkloadClientAPI;
  darkMode: boolean;
}

type RunState = 'idle' | 'creating' | 'done' | 'error';

interface LhConfig { lakehouse: Lakehouse; tables: DqTableSelection[] }

export const ConfigureRunTab: React.FC<Props> = ({ apiClient, workspaceId, workloadClient, darkMode }) => {
  const t = darkMode ? DARK_THEME : LIGHT_THEME;

  const [selectedLakehouse, setSelectedLakehouse] = useState<Lakehouse | null>(null);
  const [tableSelection, setTableSelection] = useState<DqTableSelection[]>([]);
  const [dimensions, setDimensions] = useState<DqDimension[]>([...DQ_ACTIVE_DIMENSIONS]);
  const [thresholds, setThresholds] = useState<Record<DqDimension, number>>({ ...DQ_DEFAULT_THRESHOLDS });

  const setThreshold = (dim: DqDimension, value: number) =>
    setThresholds(prev => ({ ...prev, [dim]: value }));

  // Multi-lakehouse "Select All" mode
  const [allLhConfigs, setAllLhConfigs] = useState<LhConfig[]>([]);
  const [selectAllLoading, setSelectAllLoading] = useState(false);

  const [runState, setRunState] = useState<RunState>('idle');
  const [notebookUrl, setNotebookUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // In all-lakehouses mode, canRun if any lh has tables; otherwise check single selection
  const canRun = allLhConfigs.length > 0
    ? allLhConfigs.some(c => c.tables.some(tb => tb.columns.length > 0)) && dimensions.length > 0
    : selectedLakehouse !== null &&
      tableSelection.length > 0 &&
      tableSelection.some(tb => tb.columns.length > 0) &&
      dimensions.length > 0;

  const handleSelectAllLakehouses = useCallback(async () => {
    setSelectAllLoading(true);
    setAllLhConfigs([]);
    try {
      const all = await apiClient.listLakehouses(workspaceId);
      const filtered = all.filter(lh => lh.displayName.toLowerCase() !== 'governly_dq');
      const configs = await Promise.all(filtered.map(async lh => {
        const tbls = await apiClient.listLakehouseTables(workspaceId, lh.id);
        const withCols = await Promise.all(tbls.map(async tb => {
          const cols = await apiClient.getTableSchema(workspaceId, lh.id, tb.name);
          return { tableName: tb.name, columns: cols.map(c => c.name) };
        }));
        return { lakehouse: lh, tables: withCols.filter(tb => tb.columns.length > 0) };
      }));
      setAllLhConfigs(configs.filter(c => c.tables.length > 0));
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setSelectAllLoading(false);
    }
  }, [apiClient, workspaceId]);

  const handleRun = useCallback(async () => {
    if (!canRun) return;
    setRunState('creating');
    setError(null);
    setNotebookUrl(null);

    const runId = uuidv4();
    const lhConfigs: LhConfig[] = allLhConfigs.length > 0
      ? allLhConfigs
      : selectedLakehouse ? [{ lakehouse: selectedLakehouse, tables: tableSelection }] : [];

    let lastUrl: string | null = null;
    try {
      for (const { lakehouse, tables } of lhConfigs) {
        const config: DqRunConfig = {
          runId,
          workspaceId,
          lakehouseId: lakehouse.id,
          lakehouseName: lakehouse.displayName,
          tables: tables.filter(tb => tb.columns.length > 0),
          dimensions,
          thresholds,
        };
        const result = await apiClient.createDqNotebook(config);
        lastUrl = result.webUrl;
      }
      setNotebookUrl(lastUrl);
      setRunState('done');
    } catch (err: any) {
      setError(err?.message ?? String(err));
      setRunState('error');
    }
  }, [apiClient, workspaceId, selectedLakehouse, tableSelection, allLhConfigs, dimensions, thresholds, canRun]);

  const totalColumns = allLhConfigs.length > 0
    ? allLhConfigs.reduce((sum, c) => sum + c.tables.reduce((s2, tb) => s2 + tb.columns.length, 0), 0)
    : tableSelection.reduce((sum, tb) => sum + tb.columns.length, 0);

  const selectionSummary = allLhConfigs.length > 0
    ? `${allLhConfigs.length} lakehouses · ${allLhConfigs.reduce((s, c) => s + c.tables.length, 0)} tables · ${totalColumns} columns`
    : selectedLakehouse
      ? `${selectedLakehouse.displayName} · ${tableSelection.length} table${tableSelection.length !== 1 ? 's' : ''} · ${totalColumns} column${totalColumns !== 1 ? 's' : ''}`
      : 'No data selected yet';

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden', background: t.bg, color: t.text }}>
      {/* Left: cascading explorer */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderRight: `1px solid ${t.border}` }}>
        <div style={{ padding: '12px 16px', borderBottom: `1px solid ${t.border}`, fontWeight: 600, fontSize: 14, background: t.surface, color: t.text, display: 'flex', alignItems: 'center', gap: 12 }}>
          <span>1. Select Data</span>
          <button
            onClick={handleSelectAllLakehouses}
            disabled={selectAllLoading}
            style={{
              marginLeft: 'auto', padding: '4px 12px', borderRadius: 4, border: `1px solid ${t.accent}`,
              background: 'transparent', color: t.accent, fontWeight: 500, fontSize: 12,
              cursor: selectAllLoading ? 'default' : 'pointer', opacity: selectAllLoading ? 0.6 : 1,
            }}
          >
            {selectAllLoading ? 'Loading all...' : 'Select All Lakehouses'}
          </button>
          {allLhConfigs.length > 0 && (
            <button
              onClick={() => setAllLhConfigs([])}
              style={{ padding: '4px 8px', borderRadius: 4, border: `1px solid ${t.border}`, background: 'transparent', color: t.subtext, fontSize: 11, cursor: 'pointer' }}
            >
              Clear
            </button>
          )}
        </div>
        {allLhConfigs.length > 0 ? (
          <div style={{ flex: 1, overflowY: 'auto', padding: 16, background: t.bg }}>
            <div style={{ fontSize: 13, color: t.text, fontWeight: 500, marginBottom: 12 }}>
              All Lakehouses Selected
            </div>
            {allLhConfigs.map(({ lakehouse, tables }) => (
              <div key={lakehouse.id} style={{ marginBottom: 12, padding: 12, background: t.surface, borderRadius: 6, border: `1px solid ${t.border}` }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: t.text, marginBottom: 6 }}>{lakehouse.displayName}</div>
                {tables.map(tb => (
                  <div key={tb.tableName} style={{ fontSize: 12, color: t.subtext, padding: '2px 0' }}>
                    {tb.tableName} — {tb.columns.length} columns
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <LakehouseExplorer
              apiClient={apiClient}
              workspaceId={workspaceId}
              selection={tableSelection}
              onSelectionChange={setTableSelection}
              onLakehouseChange={setSelectedLakehouse}
            />
          </div>
        )}
      </div>

      {/* Right: dimensions + run */}
      <div style={{ width: 340, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: `1px solid ${t.border}`, fontWeight: 600, fontSize: 14, background: t.surface, color: t.text }}>
          2. Choose Metrics
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px', background: t.bg }}>
          <DimensionPicker
            selected={dimensions}
            onChange={setDimensions}
            thresholds={thresholds}
            onThresholdChange={setThreshold}
            theme={t}
          />
        </div>

        {/* Run panel */}
        <div style={{ padding: 16, borderTop: `1px solid ${t.border}`, background: t.surface }}>
          <div style={{ fontSize: 12, color: t.subtext, marginBottom: 12 }}>
            {selectionSummary}
          </div>

          <button
            onClick={handleRun}
            disabled={!canRun || runState === 'creating'}
            style={{
              width: '100%', padding: '10px 0', borderRadius: 4, border: 'none',
              background: canRun && runState !== 'creating' ? t.accent : t.muted,
              color: '#fff', fontWeight: 600, fontSize: 14, cursor: canRun && runState !== 'creating' ? 'pointer' : 'default',
            }}
          >
            {runState === 'creating' ? 'Updating & starting notebook…' : 'Run DQ Checks'}
          </button>

          {!canRun && runState === 'idle' && (
            <div style={{ fontSize: 11, color: t.muted, marginTop: 6, textAlign: 'center' }}>
              Select a lakehouse, at least one table with columns, and at least one dimension
            </div>
          )}

          {runState === 'done' && notebookUrl && (
            <div style={{ marginTop: 12, padding: 10, background: `${t.pass}22`, border: `1px solid ${t.pass}44`, borderRadius: 4, fontSize: 13, color: t.pass }}>
              Notebook updated and running!{' '}
              <button
                onClick={() => {
                  try {
                    const path = new URL(notebookUrl).pathname;
                    workloadClient.navigation.navigate('host', { path }).catch(console.error);
                  } catch {
                    console.error('Could not navigate to notebook:', notebookUrl);
                  }
                }}
                style={{ background: 'none', border: 'none', color: t.pass, fontWeight: 600, cursor: 'pointer', padding: 0, fontSize: 13, textDecoration: 'underline' }}
              >
                Open in Fabric
              </button>
              <div style={{ fontSize: 11, color: t.subtext, marginTop: 4 }}>
                Check the Dashboard tab in a few minutes for results.
              </div>
            </div>
          )}

          {runState === 'error' && error && (
            <div style={{ marginTop: 12, padding: 10, background: `${t.fail}22`, border: `1px solid ${t.fail}44`, borderRadius: 4, fontSize: 12, color: t.fail }}>
              {error}
              <button onClick={() => setRunState('idle')} style={{ display: 'block', marginTop: 6, background: 'none', border: 'none', color: t.fail, cursor: 'pointer', textDecoration: 'underline', padding: 0, fontSize: 11 }}>
                Retry
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
