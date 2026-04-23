import React, { useState, useEffect } from 'react';
import { WorkloadClientAPI } from '@ms-fabric/workload-client';
import { GovernlyApiClient } from '../../../clients/GovernlyApiClient';
import { ConfigureRunTab } from './dataQuality/ConfigureRunTab';
import { DashboardTab } from './dataQuality/DashboardTab';
import { FailedRowsTab } from './dataQuality/FailedRowsTab';
import { DARK_THEME, LIGHT_THEME, DqPreloadResult } from './dataQuality/dqTypes';

interface Props {
  apiClient: GovernlyApiClient;
  workspaceId: string;
  workloadClient: WorkloadClientAPI;
}

type TabKey = 'configure' | 'dashboard' | 'failed';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'configure',  label: 'Configure & Run' },
  { key: 'dashboard',  label: 'Dashboard' },
  { key: 'failed',     label: 'Failed Rows' },
];

const STORAGE_KEY = 'governly_dq_dark_mode';

export const DataQualityView: React.FC<Props> = ({ apiClient, workspaceId, workloadClient }) => {
  const [activeTab, setActiveTab] = useState<TabKey>('configure');
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === null ? true : stored === 'true';
  });

  // Eagerly preload all dashboard + failed rows data on mount
  const [preload, setPreload]               = useState<DqPreloadResult | null>(null);
  const [preloadLoading, setPreloadLoading] = useState(false);
  const [preloadError, setPreloadError]     = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    setPreloadLoading(true);
    apiClient.preloadDqDashboard(workspaceId)
      .then(data => { setPreload(data); setPreloadError(null); })
      .catch(err => setPreloadError(err.message))
      .finally(() => setPreloadLoading(false));
  }, [apiClient, workspaceId]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(darkMode));
  }, [darkMode]);

  const t = darkMode ? DARK_THEME : LIGHT_THEME;

  // Tab bar is always light; only content area follows darkMode
  const tabBg = activeTab === 'configure' ? '#ffffff' : t.surface;
  const tabBorder = activeTab === 'configure' ? '#e2e8f0' : t.border;

  if (!workspaceId) {
    return (
      <div style={{ padding: 32, color: t.subtext, fontSize: 14, background: t.bg }}>
        Resolving workspace…
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: activeTab === 'configure' ? '#f1f5f9' : t.bg, color: t.text }}>
      {/* Tab bar — always light */}
      <div style={{ display: 'flex', alignItems: 'center', borderBottom: `2px solid ${tabBorder}`, flexShrink: 0, background: tabBg, paddingRight: 12 }}>
        {TABS.map(tab => {
          const active = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              style={{
                padding: '10px 20px',
                border: 'none',
                borderBottom: active ? `2px solid #0f6cbd` : '2px solid transparent',
                marginBottom: -2,
                background: 'transparent',
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: active ? 600 : 400,
                color: active ? '#0f6cbd' : '#555',
              }}
            >
              {tab.label}
            </button>
          );
        })}

        {/* Dark/Light mode pill toggle — only shown on Dashboard and Failed Rows tabs */}
        {activeTab !== 'configure' && (
          <button
            onClick={() => setDarkMode(d => !d)}
            style={{
              marginLeft: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '5px 12px',
              borderRadius: 20,
              border: `1px solid ${t.border}`,
              background: darkMode ? t.surface : '#e2e8f0',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 500,
              color: t.subtext,
              flexShrink: 0,
            }}
          >
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: darkMode ? t.accent : '#94a3b8', display: 'inline-block' }} />
            {darkMode ? 'Dark' : 'Light'}
          </button>
        )}
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {activeTab === 'configure' && <ConfigureRunTab apiClient={apiClient} workspaceId={workspaceId} workloadClient={workloadClient} darkMode={false} />}
        {activeTab === 'dashboard' && (
          <DashboardTab
            apiClient={apiClient}
            workspaceId={workspaceId}
            darkMode={darkMode}
            runs={preload?.runs ?? []}
            summaries={preload?.summaries ?? {}}
            loading={preloadLoading}
            error={preloadError}
          />
        )}
        {activeTab === 'failed' && (
          <FailedRowsTab
            apiClient={apiClient}
            workspaceId={workspaceId}
            darkMode={darkMode}
            initialRuns={preload?.runs ?? []}
            initialFailedRows={preload?.latestFailedRows ?? null}
            preloadLoading={preloadLoading}
          />
        )}
      </div>
    </div>
  );
};

