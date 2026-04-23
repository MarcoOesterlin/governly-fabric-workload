import React, { useState, useCallback } from 'react';
import { WorkloadClientAPI } from '@ms-fabric/workload-client';
import { v4 as uuidv4 } from 'uuid';
import { GovernlyApiClient, Lakehouse } from '../../../../clients/GovernlyApiClient';
import { DqDimension, DQ_ACTIVE_DIMENSIONS, DqTableSelection, DqRunConfig, DARK_THEME, LIGHT_THEME } from './dqTypes';
import { LakehouseExplorer } from './LakehouseExplorer';
import { DimensionPicker } from './DimensionPicker';

interface Props {
  apiClient: GovernlyApiClient;
  workspaceId: string;
  workloadClient: WorkloadClientAPI;
  darkMode: boolean;
}

type RunState = 'idle' | 'creating' | 'done' | 'error';

export const ConfigureRunTab: React.FC<Props> = ({ apiClient, workspaceId, workloadClient, darkMode }) => {
  const t = darkMode ? DARK_THEME : LIGHT_THEME;

  const [selectedLakehouse, setSelectedLakehouse] = useState<Lakehouse | null>(null);
  const [tableSelection, setTableSelection] = useState<DqTableSelection[]>([]);
  const [dimensions, setDimensions] = useState<DqDimension[]>([...DQ_ACTIVE_DIMENSIONS]);

  const [runState, setRunState] = useState<RunState>('idle');
  const [notebookUrl, setNotebookUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canRun =
    selectedLakehouse !== null &&
    tableSelection.length > 0 &&
    tableSelection.some(tb => tb.columns.length > 0) &&
    dimensions.length > 0;

  const handleRun = useCallback(async () => {
    if (!selectedLakehouse || !canRun) return;
    setRunState('creating');
    setError(null);
    setNotebookUrl(null);

    const config: DqRunConfig = {
      runId: uuidv4(),
      workspaceId,
      lakehouseId: selectedLakehouse.id,
      lakehouseName: selectedLakehouse.displayName,
      tables: tableSelection.filter(tb => tb.columns.length > 0),
      dimensions,
    };

    try {
      const result = await apiClient.createDqNotebook(config);
      setNotebookUrl(result.webUrl);
      setRunState('done');
    } catch (err: any) {
      setError(err?.message ?? String(err));
      setRunState('error');
    }
  }, [apiClient, workspaceId, selectedLakehouse, tableSelection, dimensions, canRun]);

  const totalColumns = tableSelection.reduce((sum, tb) => sum + tb.columns.length, 0);

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden', background: t.bg, color: t.text }}>
      {/* Left: cascading explorer */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderRight: `1px solid ${t.border}` }}>
        <div style={{ padding: '12px 16px', borderBottom: `1px solid ${t.border}`, fontWeight: 600, fontSize: 14, background: t.surface, color: t.text }}>
          1. Select Data
        </div>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <LakehouseExplorer
            apiClient={apiClient}
            workspaceId={workspaceId}
            selection={tableSelection}
            onSelectionChange={setTableSelection}
            onLakehouseChange={setSelectedLakehouse}
          />
        </div>
      </div>

      {/* Right: dimensions + run */}
      <div style={{ width: 340, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: `1px solid ${t.border}`, fontWeight: 600, fontSize: 14, background: t.surface, color: t.text }}>
          2. Choose Metrics
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px', background: t.bg }}>
          <DimensionPicker selected={dimensions} onChange={setDimensions} />
        </div>

        {/* Run panel */}
        <div style={{ padding: 16, borderTop: `1px solid ${t.border}`, background: t.surface }}>
          <div style={{ fontSize: 12, color: t.subtext, marginBottom: 12 }}>
            {selectedLakehouse
              ? <><strong style={{ color: t.text }}>{selectedLakehouse.displayName}</strong> · {tableSelection.length} table{tableSelection.length !== 1 ? 's' : ''} · {totalColumns} column{totalColumns !== 1 ? 's' : ''} · {dimensions.length} dimension{dimensions.length !== 1 ? 's' : ''}</>
              : 'No data selected yet'}
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
