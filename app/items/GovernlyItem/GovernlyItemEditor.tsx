import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useLocation } from 'react-router-dom';
import { WorkloadClientAPI } from '@ms-fabric/workload-client';
import { useTranslation } from 'react-i18next';
import {
  ArrowClockwise24Regular,
  ShieldTask24Regular,
  AppsList24Regular,
  CheckmarkStarburst24Regular,
  Open24Regular,
  Bot24Regular,
} from '@fluentui/react-icons';

import { GovernlyApiClient, FabricItem, SensitivityLabel, DataAgentProvisionResult } from '../../clients/GovernlyApiClient';
import { callGetItem } from '../../controller/ItemCRUDController';
import { ItemsView } from './views/ItemsView';
import { DataQualityView } from './views/DataQualityView';

interface GovernlyItemEditorProps {
  workloadClient: WorkloadClientAPI;
}

type ViewKey = 'items' | 'data-quality';

interface NavItem {
  key: ViewKey;
  labelKey: string;
  defaultLabel: string;
  icon: React.ReactElement;
}

const NAV_ITEMS: NavItem[] = [
  { key: 'items',        labelKey: 'Nav_Items',        defaultLabel: 'Workspace Items', icon: <AppsList24Regular /> },
  { key: 'data-quality', labelKey: 'Nav_DataQuality',  defaultLabel: 'Data Quality',    icon: <CheckmarkStarburst24Regular /> },
];

const GovernlyItemEditor: React.FC<GovernlyItemEditorProps> = ({ workloadClient }) => {
  const { itemObjectId } = useParams<{ itemObjectId: string }>();
  const location = useLocation();
  const wsIdFromUrl = new URLSearchParams(location.search).get('wsId') ?? undefined;
  const { t } = useTranslation();

  const apiClient = useMemo(() => new GovernlyApiClient(workloadClient), [workloadClient]);

  const [activeView, setActiveView] = useState<ViewKey>('items');
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [labels, setLabels] = useState<SensitivityLabel[]>([]);
  const [labelsError, setLabelsError] = useState<string | undefined>();
  const [workspaceId, setWorkspaceId] = useState<string | undefined>();
  const [workspaceError, setWorkspaceError] = useState<string | undefined>();
  const [items, setItems] = useState<FabricItem[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [itemsError, setItemsError] = useState<string | undefined>();

  const [dataAgentStatus, setDataAgentStatus] = useState<'checking' | 'idle' | 'provisioning' | 'done' | 'error'>('checking');
  const [dataAgentResult, setDataAgentResult] = useState<DataAgentProvisionResult | undefined>();
  const [dataAgentError, setDataAgentError] = useState<string | undefined>();

  // Auto-check if Data Agent exists when workspace loads
  useEffect(() => {
    if (!workspaceId) return;
    setDataAgentStatus('checking');
    apiClient.checkDataAgent(workspaceId)
      .then(status => {
        if (status.exists) {
          console.log('[Governly] Data Agent already exists:', status.agentId);
          setDataAgentResult({
            agentId: status.agentId,
            agentName: status.agentName,
            message: `${status.agentName ?? 'Data Agent'} is active`,
          });
          setDataAgentStatus('done');
        } else {
          setDataAgentStatus('idle');
        }
      })
      .catch(() => {
        setDataAgentStatus('idle');
      });
  }, [apiClient, workspaceId]);

  useEffect(() => {
    apiClient.listSensitivityLabels()
      .then(fetched => {
        console.log('[Governly] Loaded', fetched.length, 'sensitivity labels');
        setLabels(fetched);
        setLabelsError(undefined);
      })
      .catch((err: any) => {
        console.error('[Governly] listSensitivityLabels failed:', err);
        setLabelsError(err?.message ?? String(err));
      });
  }, [apiClient, refreshTrigger]);

  useEffect(() => {
    if (!workspaceId) return undefined;
    let cancelled = false;
    setItemsLoading(true);
    setItemsError(undefined);

    apiClient.listWorkspaceItems(workspaceId)
      .then(fetched => {
        if (cancelled) return;
        console.log('[Governly] listWorkspaceItems returned', fetched.length, 'items');
        setItems(fetched);
        setItemsLoading(false);
      })
      .catch((err: any) => {
        if (cancelled) return;
        console.error('[Governly] listWorkspaceItems failed:', err);
        setItemsError(err?.message ?? (typeof err === 'object' ? JSON.stringify(err) : String(err)));
        setItemsLoading(false);
      });

    return () => { cancelled = true; };
  }, [apiClient, workspaceId, refreshTrigger]);

  useEffect(() => {
    if (!itemObjectId) return;

    if (wsIdFromUrl) {
      console.log('[Governly] workspaceId from URL hint:', wsIdFromUrl);
      setWorkspaceId(wsIdFromUrl);
      setWorkspaceError(undefined);
      return;
    }

    console.log('[Governly] Resolving workspaceId via callGetItem for item:', itemObjectId);

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Timed out resolving workspace (10s). Check the Dev Gateway is running.')), 10000)
    );

    Promise.race([callGetItem(workloadClient, itemObjectId), timeout])
      .then(result => {
        console.log('[Governly] callGetItem result:', JSON.stringify(result));
        if (result?.item?.workspaceId) {
          setWorkspaceId(result.item.workspaceId);
        } else {
          const devWsId = process.env.WORKSPACE_GUID;
          if (devWsId) {
            console.warn('[Governly] Using WORKSPACE_GUID fallback:', devWsId);
            setWorkspaceId(devWsId);
          } else {
            setWorkspaceError('Could not resolve workspace ID from item metadata.');
          }
        }
      })
      .catch((err: any) => {
        console.error('[Governly] callGetItem failed:', err);
        const devWsId = process.env.WORKSPACE_GUID;
        if (devWsId) {
          console.warn('[Governly] Using WORKSPACE_GUID fallback:', devWsId);
          setWorkspaceId(devWsId);
          return;
        }
        const msg = err?.message ?? err?.errorDescription
          ?? (typeof err === 'object' ? JSON.stringify(err) : String(err));
        setWorkspaceError(`Failed to load workspace context: ${msg}`);
      });
  }, [workloadClient, itemObjectId, wsIdFromUrl]);

  const handleRefresh = useCallback(() => {
    setRefreshTrigger(prev => prev + 1);
  }, []);

  const handleProvisionDataAgent = useCallback(() => {
    if (!workspaceId || dataAgentStatus === 'provisioning') return;
    setDataAgentStatus('provisioning');
    setDataAgentError(undefined);
    setDataAgentResult(undefined);

    apiClient.provisionDataAgent(workspaceId, 'Governly')
      .then(result => {
        console.log('[Governly] Data Agent provisioned:', result);
        setDataAgentResult(result);
        setDataAgentStatus('done');
      })
      .catch((err: any) => {
        console.error('[Governly] Data Agent provisioning failed:', err);
        setDataAgentError(err?.message ?? String(err));
        setDataAgentStatus('error');
      });
  }, [apiClient, workspaceId, dataAgentStatus]);

  const renderContent = () => {
    switch (activeView) {
      case 'items':
        return (
          <ItemsView
            apiClient={apiClient}
            workspaceId={workspaceId}
            workspaceError={workspaceError}
            labels={labels}
            labelsError={labelsError}
            items={items}
            itemsLoading={itemsLoading}
            itemsError={itemsError}
            onItemsChange={setItems}
          />
        );
      case 'data-quality':
        return <DataQualityView apiClient={apiClient} workspaceId={workspaceId ?? ''} workloadClient={workloadClient} />;
      default:
        return null;
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', fontFamily: 'var(--fontFamilyBase)' }}>
      {/* ── Header ── */}
      <div style={{
        height: 48,
        backgroundColor: '#0f6cbd',
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        padding: '0 16px',
        gap: 10,
        flexShrink: 0,
        boxShadow: '0 2px 4px rgba(0,0,0,0.15)',
      }}>
        <ShieldTask24Regular style={{ flexShrink: 0 }} />
        <span style={{ fontWeight: 600, fontSize: 16, letterSpacing: 0.2, flex: 1 }}>Governly</span>
        {workspaceId && (
          <button
            onClick={handleProvisionDataAgent}
            disabled={dataAgentStatus === 'provisioning' || dataAgentStatus === 'checking' || dataAgentStatus === 'done'}
            title={
              dataAgentStatus === 'checking'      ? 'Checking Data Agent status...' :
              dataAgentStatus === 'provisioning'  ? 'Creating Data Agent...' :
              dataAgentStatus === 'done'           ? `${dataAgentResult?.agentName ?? 'Data Agent'} is active` :
              dataAgentStatus === 'error'          ? `Error: ${dataAgentError} — click to retry` :
              'Create a Fabric Data Agent for this workspace'
            }
            style={{
              background: dataAgentStatus === 'done'     ? 'rgba(100,200,100,0.25)' :
                          dataAgentStatus === 'error'    ? 'rgba(255,80,80,0.25)'  :
                          dataAgentStatus === 'checking' ? 'rgba(255,255,255,0.10)' :
                          'rgba(255,255,255,0.15)',
              border: 'none',
              borderRadius: 4,
              color: '#fff',
              cursor: (dataAgentStatus === 'provisioning' || dataAgentStatus === 'checking' || dataAgentStatus === 'done') ? 'default' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 10px',
              fontSize: 13,
              opacity: (dataAgentStatus === 'provisioning' || dataAgentStatus === 'checking') ? 0.7 : 1,
            }}
          >
            <Bot24Regular style={{ width: 16, height: 16 }} />
            {dataAgentStatus === 'checking'     ? 'Checking…' :
             dataAgentStatus === 'provisioning' ? 'Creating…' :
             dataAgentStatus === 'done'         ? 'Data Agent ✓' :
             dataAgentStatus === 'error'        ? 'Data Agent ✗' :
             'Create Data Agent'}
          </button>
        )}
        {workspaceId && (
          <button
            onClick={() => {
              workloadClient.navigation.navigate('host', {
                path: `/groups/${workspaceId}`,
              }).catch(() => {
                // fallback: open in new browser tab
                workloadClient.navigation.openBrowserTab({
                  url: `https://app.fabric.microsoft.com/groups/${workspaceId}`,
                }).catch(console.error);
              });
            }}
            title="Open workspace in Fabric"
            style={{
              background: 'rgba(255,255,255,0.15)',
              border: 'none',
              borderRadius: 4,
              color: '#fff',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 10px',
              fontSize: 13,
            }}
          >
            <Open24Regular style={{ width: 16, height: 16 }} />
            Open Workspace
          </button>
        )}
        <button
          onClick={handleRefresh}
          title={t('Classifier_Ribbon_Refresh', 'Refresh')}
          style={{
            background: 'rgba(255,255,255,0.15)',
            border: 'none',
            borderRadius: 4,
            color: '#fff',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 10px',
            fontSize: 13,
          }}
        >
          <ArrowClockwise24Regular style={{ width: 16, height: 16 }} />
          {t('Classifier_Ribbon_Refresh', 'Refresh')}
        </button>
      </div>

      {/* ── Data Agent notification banner ── */}
      {(dataAgentStatus === 'done' || dataAgentStatus === 'error') && (() => {
        const hasAgent  = !!dataAgentResult?.agentId;
        const isSuccess = dataAgentStatus === 'done';
        const bgColor   = isSuccess ? '#dff6dd' : '#fde7e9';
        const textColor = isSuccess ? '#1a7237' : '#a4262c';
        const icon      = isSuccess ? '✅' : '❌';
        const openAgent = async () => {
          const wsPath = `/groups/${workspaceId}`;
          try {
            // Navigate home first so Fabric reloads the workspace items list on return
            await workloadClient.navigation.navigate('host', { path: '/' });
            await new Promise(r => setTimeout(r, 300));
            await workloadClient.navigation.navigate('host', { path: wsPath });
          } catch {
            workloadClient.navigation.navigate('host', { path: wsPath }).catch(console.error);
          }
        };
        return (
          <div style={{ backgroundColor: bgColor, color: textColor, padding: '8px 16px', fontSize: 13, display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            <span>{icon} {isSuccess ? dataAgentResult?.message : `Data Agent provisioning failed: ${dataAgentError}`}</span>
            {isSuccess && hasAgent && workspaceId && (
              <button onClick={openAgent} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', fontWeight: 600, padding: 0, textDecoration: 'underline' }}>
                Open Workspace →
              </button>
            )}
            <button onClick={() => setDataAgentStatus('idle')} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', fontSize: 16 }}>×</button>
          </div>
        );
      })()}

      {/* ── Body (sidebar + content) ── */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* ── Sidebar ── */}
        <div style={{
          width: 220,
          backgroundColor: '#fafafa',
          borderRight: '1px solid #e0e0e0',
          display: 'flex',
          flexDirection: 'column',
          flexShrink: 0,
          paddingTop: 8,
        }}>
          {NAV_ITEMS.map(item => {
            const isActive = activeView === item.key;
            return (
              <button
                key={item.key}
                onClick={() => setActiveView(item.key)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '10px 16px',
                  background: isActive ? '#e8f0fe' : 'transparent',
                  border: 'none',
                  borderLeft: isActive ? '3px solid #0f6cbd' : '3px solid transparent',
                  color: isActive ? '#0f6cbd' : '#333',
                  fontWeight: isActive ? 600 : 400,
                  fontSize: 14,
                  cursor: 'pointer',
                  width: '100%',
                  textAlign: 'left',
                  borderRadius: '0 4px 4px 0',
                  marginBottom: 2,
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', color: isActive ? '#0f6cbd' : '#555', flexShrink: 0 }}>
                  {item.icon}
                </span>
                {t(item.labelKey, item.defaultLabel)}
              </button>
            );
          })}
        </div>

        {/* ── Content ── */}
        <div style={{ flex: 1, overflowY: 'auto', backgroundColor: '#fff' }}>
          {renderContent()}
        </div>
      </div>
    </div>
  );
};

export { GovernlyItemEditor };
export default GovernlyItemEditor;
