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
  Dismiss24Regular,
  PeopleTeam24Regular,
} from '@fluentui/react-icons';
import {
  Button,
  MessageBar,
  MessageBarBody,
  MessageBarActions,
  Spinner,
  Tab,
  TabList,
  makeStyles,
  tokens,
} from '@fluentui/react-components';

import { GovernlyApiClient, FabricItem, SensitivityLabel, DataAgentProvisionResult } from '../../clients/GovernlyApiClient';
import { SpStatusBadge } from './components/SpStatusBadge';
import { callGetItem } from '../../controller/ItemCRUDController';
import { ItemsView } from './views/ItemsView';
import { DataQualityView } from './views/DataQualityView';
import { AccessManagementView } from './views/AccessManagementView';

interface GovernlyItemEditorProps {
  workloadClient: WorkloadClientAPI;
}

type ViewKey = 'items' | 'data-quality' | 'access';

interface NavItem {
  key: ViewKey;
  labelKey: string;
  defaultLabel: string;
  icon: React.ReactElement;
}

const NAV_ITEMS: NavItem[] = [
  { key: 'items',        labelKey: 'Nav_Items',       defaultLabel: 'Workspace Items', icon: <AppsList24Regular /> },
  { key: 'data-quality', labelKey: 'Nav_DataQuality', defaultLabel: 'Data Quality',   icon: <CheckmarkStarburst24Regular /> },
  { key: 'access',       labelKey: 'Nav_Access',      defaultLabel: 'Access Management', icon: <PeopleTeam24Regular /> },
];


const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    overflow: 'hidden',
    fontFamily: tokens.fontFamilyBase,
  },
  header: {
    height: '48px',
    background: '#f3f4f6',
    borderBottom: '1px solid #e2e8f0',
    display: 'flex',
    alignItems: 'center',
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    gap: tokens.spacingHorizontalXS,
    flexShrink: '0',
    boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
  },
  headerIcon: {
    color: '#0078d4',
    flexShrink: '0',
  },
  headerTitle: {
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase400,
    color: '#1a1a2e',
    flex: '1',
    letterSpacing: '0.2px',
  },
  body: {
    display: 'flex',
    flex: '1',
    overflow: 'hidden',
  },
  sidebar: {
    width: '220px',
    backgroundColor: tokens.colorNeutralBackground2,
    borderRightWidth: '1px',
    borderRightStyle: 'solid',
    borderRightColor: tokens.colorNeutralStroke1,
    display: 'flex',
    flexDirection: 'column',
    flexShrink: '0',
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    overflowY: 'auto',
  },
  tabList: {
    width: '100%',
  },
  content: {
    flex: '1',
    overflowY: 'auto',
    backgroundColor: tokens.colorNeutralBackground1,
  },
});

const GovernlyItemEditor: React.FC<GovernlyItemEditorProps> = ({ workloadClient }) => {
  const styles = useStyles();
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
  const [showAgentBanner, setShowAgentBanner] = useState(false);

  useEffect(() => {
    if (!workspaceId) return;
    setDataAgentStatus('checking');
    apiClient.checkDataAgent(workspaceId)
      .then(status => {
        if (status.exists) {
          setDataAgentResult({ agentId: status.agentId, agentName: status.agentName, message: `${status.agentName ?? 'Data Agent'} is active` });
          setDataAgentStatus('done');
          setShowAgentBanner(true);
        } else {
          setDataAgentStatus('idle');
        }
      })
      .catch(() => setDataAgentStatus('idle'));
  }, [apiClient, workspaceId]);

  useEffect(() => {
    apiClient.listSensitivityLabels()
      .then(fetched => { setLabels(fetched); setLabelsError(undefined); })
      .catch((err: any) => setLabelsError(err?.message ?? String(err)));
  }, [apiClient, refreshTrigger]);

  useEffect(() => {
    if (!workspaceId) return undefined;
    let cancelled = false;
    setItemsLoading(true);
    setItemsError(undefined);
    apiClient.listWorkspaceItems(workspaceId)
      .then(fetched => { if (!cancelled) { setItems(fetched); setItemsLoading(false); } })
      .catch((err: any) => { if (!cancelled) { setItemsError(err?.message ?? String(err)); setItemsLoading(false); } });
    return () => { cancelled = true; };
  }, [apiClient, workspaceId, refreshTrigger]);

  useEffect(() => {
    if (!itemObjectId) return;
    if (wsIdFromUrl) { setWorkspaceId(wsIdFromUrl); setWorkspaceError(undefined); return; }

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Timed out resolving workspace (10s). Check the Dev Gateway is running.')), 10000)
    );
    Promise.race([callGetItem(workloadClient, itemObjectId), timeout])
      .then(result => {
        if (result?.item?.workspaceId) {
          setWorkspaceId(result.item.workspaceId);
        } else {
          const devWsId = process.env.WORKSPACE_GUID;
          if (devWsId) setWorkspaceId(devWsId);
          else setWorkspaceError('Could not resolve workspace ID from item metadata.');
        }
      })
      .catch((err: any) => {
        const devWsId = process.env.WORKSPACE_GUID;
        if (devWsId) { setWorkspaceId(devWsId); return; }
        setWorkspaceError(`Failed to load workspace context: ${err?.message ?? String(err)}`);
      });
  }, [workloadClient, itemObjectId, wsIdFromUrl]);

  const handleRefresh = useCallback(() => setRefreshTrigger(prev => prev + 1), []);

  const handleProvisionDataAgent = useCallback(() => {
    if (!workspaceId || dataAgentStatus === 'provisioning') return;
    setDataAgentStatus('provisioning');
    setDataAgentError(undefined);
    setDataAgentResult(undefined);
    apiClient.provisionDataAgent(workspaceId, 'Governly')
      .then(result => { setDataAgentResult(result); setDataAgentStatus('done'); setShowAgentBanner(true); })
      .catch((err: any) => { setDataAgentError(err?.message ?? String(err)); setDataAgentStatus('error'); setShowAgentBanner(true); });
  }, [apiClient, workspaceId, dataAgentStatus]);

  // Auto-dismiss success banner after 4 seconds (status stays 'done' so button stays correct)
  useEffect(() => {
    if (!showAgentBanner || dataAgentStatus !== 'done') return undefined;
    const timer = setTimeout(() => setShowAgentBanner(false), 4000);
    return () => clearTimeout(timer);
  }, [showAgentBanner, dataAgentStatus]);

  const handleOpenWorkspace = useCallback(() => {
    if (!workspaceId) return;
    workloadClient.navigation.navigate('host', { path: `/groups/${workspaceId}` })
      .catch(() => workloadClient.navigation.openBrowserTab({ url: `https://app.fabric.microsoft.com/groups/${workspaceId}` }).catch(console.error));
  }, [workloadClient, workspaceId]);

  const handleOpenAgentWorkspace = useCallback(async () => {
    if (!workspaceId) return;
    try {
      await workloadClient.navigation.navigate('host', { path: '/' });
      await new Promise(r => setTimeout(r, 300));
      await workloadClient.navigation.navigate('host', { path: `/groups/${workspaceId}` });
    } catch {
      workloadClient.navigation.navigate('host', { path: `/groups/${workspaceId}` }).catch(console.error);
    }
  }, [workloadClient, workspaceId]);

  const agentBusy = dataAgentStatus === 'provisioning' || dataAgentStatus === 'checking';
  const agentDone = dataAgentStatus === 'done';

  const agentButtonLabel =
    dataAgentStatus === 'checking'     ? 'Checking…' :
    dataAgentStatus === 'provisioning' ? 'Creating…' :
    dataAgentStatus === 'done'         ? `${dataAgentResult?.agentName ?? 'Data Agent'} ✓` :
    dataAgentStatus === 'error'        ? 'Retry Data Agent' :
    'Create Data Agent';

  const agentButtonTitle =
    dataAgentStatus === 'checking'     ? 'Checking Data Agent status…' :
    dataAgentStatus === 'provisioning' ? 'Creating Data Agent…' :
    dataAgentStatus === 'done'         ? `${dataAgentResult?.agentName ?? 'Data Agent'} is active` :
    dataAgentStatus === 'error'        ? `Error: ${dataAgentError} — click to retry` :
    'Create a Fabric Data Agent for this workspace';

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
        return <DataQualityView apiClient={apiClient} workspaceId={workspaceId ?? ''} workloadClient={workloadClient} refreshTrigger={refreshTrigger} />;
      case 'access':
        return <AccessManagementView workspaceId={workspaceId ?? ''} client={apiClient} />;
      default:
        return null;
    }
  };

  return (
    <div className={styles.root}>

      {/* ── Header ── */}
      <div className={styles.header}>
        <ShieldTask24Regular className={styles.headerIcon} />
        <span className={styles.headerTitle}>Governly</span>

        {workspaceId && (
          <button
            onClick={handleProvisionDataAgent}
            disabled={agentBusy || agentDone}
            title={agentButtonTitle}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '5px 14px', borderRadius: 6, border: '1px solid transparent',
              cursor: agentBusy || agentDone ? 'default' : 'pointer',
              fontSize: 13, fontWeight: 600,
              color: agentDone ? '#107c10' : '#323130',
              background: agentDone
                ? 'rgba(16,124,16,0.1)'
                : dataAgentStatus === 'error'
                  ? 'rgba(196,49,75,0.1)'
                  : 'rgba(0,120,212,0.08)',
              opacity: agentBusy ? 0.6 : 1,
              transition: 'background 0.15s',
            }}
          >
            {agentBusy
              ? <Spinner size="extra-tiny" />
              : <Bot24Regular style={{ fontSize: 16, color: agentDone ? '#107c10' : '#0078d4' }} />}
            {agentButtonLabel}
          </button>
        )}

        <SpStatusBadge apiClient={apiClient} />

        {workspaceId && (
          <button
            onClick={handleOpenWorkspace}
            title="Open workspace in Fabric"
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '5px 14px', borderRadius: 6, border: 'none',
              cursor: 'pointer', fontSize: 13, fontWeight: 500,
              color: '#323130', background: 'transparent',
            }}
          >
            <Open24Regular style={{ fontSize: 16, color: '#605e5c' }} />
            Open Workspace
          </button>
        )}

        <button
          onClick={handleRefresh}
          title={t('Classifier_Ribbon_Refresh', 'Refresh')}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '5px 14px', borderRadius: 6, border: 'none',
            cursor: 'pointer', fontSize: 13, fontWeight: 500,
            color: '#323130', background: 'transparent',
          }}
        >
          <ArrowClockwise24Regular style={{ fontSize: 16, color: '#605e5c' }} />
          {t('Classifier_Ribbon_Refresh', 'Refresh')}
        </button>
      </div>

      {/* ── Data Agent notification banner ── */}
      {showAgentBanner && (dataAgentStatus === 'done' || dataAgentStatus === 'error') && (
        <MessageBar intent={dataAgentStatus === 'done' ? 'success' : 'error'}>
          <MessageBarBody>
            {dataAgentStatus === 'done'
              ? dataAgentResult?.message ?? 'Data Agent is active'
              : `Data Agent provisioning failed: ${dataAgentError}`}
          </MessageBarBody>
          <MessageBarActions
            containerAction={
              <Button appearance="transparent" size="small" icon={<Dismiss24Regular />} aria-label="Dismiss" onClick={() => setShowAgentBanner(false)} />
            }
          >
            {dataAgentStatus === 'done' && dataAgentResult?.agentId && workspaceId && (
              <Button appearance="transparent" size="small" onClick={handleOpenAgentWorkspace}>
                Open Workspace
              </Button>
            )}
          </MessageBarActions>
        </MessageBar>
      )}

      {/* ── Body (sidebar + content) ── */}
      <div className={styles.body}>

        {/* ── Sidebar ── */}
        <div className={styles.sidebar}>
          <TabList
            vertical
            className={styles.tabList}
            selectedValue={activeView}
            onTabSelect={(_e, data) => setActiveView(data.value as ViewKey)}
          >
            {NAV_ITEMS.map(item => (
              <Tab key={item.key} value={item.key} icon={item.icon}>
                {t(item.labelKey, item.defaultLabel)}
              </Tab>
            ))}
          </TabList>
        </div>

        {/* ── Content ── */}
        <div className={styles.content}>
          {renderContent()}
        </div>
      </div>
    </div>
  );
};

export { GovernlyItemEditor };
export default GovernlyItemEditor;
