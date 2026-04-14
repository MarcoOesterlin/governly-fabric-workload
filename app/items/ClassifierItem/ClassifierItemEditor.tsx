import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { WorkloadClientAPI } from '@ms-fabric/workload-client';
import { useTranslation } from 'react-i18next';
import { Tab, TabList } from '@fluentui/react-tabs';
import {
  ArrowClockwise24Regular,
  Tag24Regular,
  TagDismiss24Regular,
} from '@fluentui/react-icons';

import { ItemEditor, RegisteredView, ViewContext } from '../../components/ItemEditor';
import { Ribbon } from '../../components/ItemEditor/Ribbon';
import { RibbonAction } from '../../components/ItemEditor/RibbonToolbar';

import { GovernlyApiClient, FabricItem, SensitivityLabel } from '../../clients/GovernlyApiClient';

import { DashboardView } from './views/DashboardView';
import { ItemsView } from './views/ItemsView';
import { DomainsView } from './views/DomainsView';
import { LakehousesView } from './views/LakehousesView';
import { LabelsView } from './views/LabelsView';

import { ConfirmationDialog } from './components/ConfirmationDialog';
import { BatchProgressDialog } from './components/BatchProgressDialog';
import { BulkActionBar } from './components/BulkActionBar';
import { LabelPicker } from './components/LabelPicker';

interface ClassifierItemEditorProps {
  workloadClient: WorkloadClientAPI;
}

interface ClassifierRibbonProps {
  viewContext: ViewContext;
  selectedItemsCount: number;
  onRefresh: () => void;
  onApplyLabel: () => void;
  onRemoveLabel: () => void;
}

const ClassifierRibbon: React.FC<ClassifierRibbonProps> = ({
  viewContext,
  selectedItemsCount,
  onRefresh,
  onApplyLabel,
  onRemoveLabel,
}) => {
  const { t } = useTranslation();

  const navTabs = [
    { key: 'dashboard', label: t('Classifier_Tab_Dashboard', 'Dashboard') },
    { key: 'items', label: t('Classifier_Tab_Items', 'Items') },
    { key: 'domains', label: t('Classifier_Tab_Domains', 'Domains') },
    { key: 'lakehouses', label: t('Classifier_Tab_Lakehouses', 'Lakehouses') },
    { key: 'labels', label: t('Classifier_Tab_Labels', 'Labels') },
  ];

  const homeActions: RibbonAction[] = useMemo(() => {
    const actions: RibbonAction[] = [
      {
        key: 'refresh',
        label: t('Classifier_Ribbon_Refresh', 'Refresh'),
        icon: ArrowClockwise24Regular,
        onClick: onRefresh,
      },
    ];
    if (selectedItemsCount > 0) {
      actions.push({
        key: 'apply-label',
        label: t('Classifier_Ribbon_ApplyLabel', 'Apply Label'),
        icon: Tag24Regular,
        onClick: onApplyLabel,
        showDividerAfter: false,
      });
      actions.push({
        key: 'remove-label',
        label: t('Classifier_Ribbon_RemoveLabel', 'Remove Label'),
        icon: TagDismiss24Regular,
        onClick: onRemoveLabel,
      });
    }
    return actions;
  }, [t, selectedItemsCount, onRefresh, onApplyLabel, onRemoveLabel]);

  return (
    <div>
      {/* View navigation tabs */}
      <div style={{ padding: '0 16px', borderBottom: '1px solid var(--colorNeutralStroke2, #e0e0e0)' }}>
        <TabList
          selectedValue={viewContext.currentView || 'dashboard'}
          onTabSelect={(_, data) => viewContext.setCurrentView(data.value as string)}
        >
          {navTabs.map(tab => (
            <Tab key={tab.key} value={tab.key}>{tab.label}</Tab>
          ))}
        </TabList>
      </div>
      {/* Action ribbon */}
      <Ribbon homeToolbarActions={homeActions} viewContext={viewContext} />
    </div>
  );
};

interface BatchState {
  successCount: number;
  failureCount: number;
  failures: Array<{ itemId: string; errorMessage: string }>;
  isComplete: boolean;
}

const ClassifierItemEditor: React.FC<ClassifierItemEditorProps> = ({ workloadClient }) => {
  const { itemObjectId } = useParams<{ itemObjectId: string }>();
  const { t } = useTranslation();

  // Silence unused variable warning — itemObjectId is part of the route context
  void itemObjectId;

  const apiClient = useMemo(() => new GovernlyApiClient(workloadClient), [workloadClient]);

  const [selectedItems, setSelectedItems] = useState<FabricItem[]>([]);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  // Apply label dialog state
  const [applyDialogOpen, setApplyDialogOpen] = useState(false);
  const [selectedLabelId, setSelectedLabelId] = useState<string | undefined>();
  const [availableLabels, setAvailableLabels] = useState<SensitivityLabel[]>([]);

  // Remove label dialog state
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);

  // Batch progress dialog state
  const [batchDialogOpen, setBatchDialogOpen] = useState(false);
  const [batchState, setBatchState] = useState<BatchState>({
    successCount: 0,
    failureCount: 0,
    failures: [],
    isComplete: false,
  });

  // Ref to setCurrentView from ItemEditor
  const setCurrentViewRef = useRef<(view: string) => void>(() => {});
  const handleViewSetter = useCallback((setter: (view: string) => void) => {
    setCurrentViewRef.current = setter;
  }, []);

  const handleRefresh = useCallback(() => {
    setRefreshTrigger(prev => prev + 1);
  }, []);

  const handleOpenApplyDialog = useCallback(() => {
    setSelectedLabelId(undefined);
    setApplyDialogOpen(true);
  }, []);

  const handleOpenRemoveDialog = useCallback(() => {
    setRemoveDialogOpen(true);
  }, []);

  // Load labels when apply dialog opens
  useEffect(() => {
    if (applyDialogOpen && availableLabels.length === 0) {
      apiClient.listSensitivityLabels().then(setAvailableLabels).catch(() => {});
    }
  }, [applyDialogOpen, apiClient, availableLabels.length]);

  const runBulkOperation = useCallback(
    async (op: () => Promise<{ successCount: number; failureCount: number; failures: Array<{ itemId: string; errorMessage: string }> }>) => {
      setBatchState({ successCount: 0, failureCount: 0, failures: [], isComplete: false });
      setBatchDialogOpen(true);
      try {
        const result = await op();
        setBatchState({ ...result, isComplete: true });
      } catch {
        setBatchState({
          successCount: 0,
          failureCount: selectedItems.length,
          failures: [],
          isComplete: true,
        });
      }
    },
    [selectedItems.length]
  );

  const handleApplyLabel = useCallback(async () => {
    if (!selectedLabelId) return;
    setApplyDialogOpen(false);
    await runBulkOperation(() =>
      apiClient.bulkSetLabels(
        selectedItems.map(i => ({ id: i.id, type: i.type })),
        selectedLabelId
      )
    );
  }, [apiClient, selectedItems, selectedLabelId, runBulkOperation]);

  const handleRemoveLabel = useCallback(async () => {
    setRemoveDialogOpen(false);
    await runBulkOperation(() =>
      apiClient.bulkRemoveLabels(selectedItems.map(i => ({ id: i.id, type: i.type })))
    );
  }, [apiClient, selectedItems, runBulkOperation]);

  const selectedLabelName = availableLabels.find(l => l.id === selectedLabelId)?.name;

  const views: RegisteredView[] = useMemo(() => [
    {
      name: 'dashboard',
      component: (
        <DashboardView
          key={refreshTrigger}
          apiClient={apiClient}
          onNavigateTo={(view) => setCurrentViewRef.current(view)}
        />
      ),
    },
    {
      name: 'items',
      component: (
        <ItemsView
          key={refreshTrigger}
          apiClient={apiClient}
          selectedItems={selectedItems}
          onSelectionChange={setSelectedItems}
        />
      ),
    },
    {
      name: 'domains',
      component: (
        <DomainsView
          key={refreshTrigger}
          apiClient={apiClient}
        />
      ),
    },
    {
      name: 'lakehouses',
      component: (
        <LakehousesView
          key={refreshTrigger}
          apiClient={apiClient}
        />
      ),
    },
    {
      name: 'labels',
      component: (
        <LabelsView
          key={refreshTrigger}
          apiClient={apiClient}
        />
      ),
    },
  ], [apiClient, refreshTrigger, selectedItems]);

  return (
    <>
      <ItemEditor
        ribbon={(context: ViewContext) => (
          <ClassifierRibbon
            viewContext={context}
            selectedItemsCount={selectedItems.length}
            onRefresh={handleRefresh}
            onApplyLabel={handleOpenApplyDialog}
            onRemoveLabel={handleOpenRemoveDialog}
          />
        )}
        views={views}
        initialView="dashboard"
        viewSetter={handleViewSetter}
      />

      {/* Sticky bulk action bar */}
      <BulkActionBar
        selectedCount={selectedItems.length}
        onApplyLabel={handleOpenApplyDialog}
        onRemoveLabel={handleOpenRemoveDialog}
        onClear={() => setSelectedItems([])}
      />

      {/* Apply label confirmation dialog */}
      <ConfirmationDialog
        open={applyDialogOpen}
        title={t('Classifier_Confirm_Title', 'Confirm action')}
        message={t('Classifier_Confirm_ApplyLabel', "Apply '{{label}}' to {{count}} item(s)?", {
          label: selectedLabelName || '…',
          count: selectedItems.length,
        })}
        confirmLabel={t('Classifier_Confirm_Apply', 'Apply')}
        onConfirm={handleApplyLabel}
        onCancel={() => setApplyDialogOpen(false)}
      >
        <LabelPicker
          labels={availableLabels}
          value={selectedLabelId}
          onChange={setSelectedLabelId}
        />
      </ConfirmationDialog>

      {/* Remove label confirmation dialog */}
      <ConfirmationDialog
        open={removeDialogOpen}
        title={t('Classifier_Confirm_Title', 'Confirm action')}
        message={t('Classifier_Confirm_RemoveLabel', 'Remove label from {{count}} item(s)?', {
          count: selectedItems.length,
        })}
        confirmLabel={t('Classifier_Confirm_Apply', 'Apply')}
        onConfirm={handleRemoveLabel}
        onCancel={() => setRemoveDialogOpen(false)}
      />

      {/* Batch progress dialog */}
      <BatchProgressDialog
        open={batchDialogOpen}
        successCount={batchState.successCount}
        failureCount={batchState.failureCount}
        failures={batchState.failures}
        isComplete={batchState.isComplete}
        onClose={() => {
          setBatchDialogOpen(false);
          setSelectedItems([]);
          handleRefresh();
        }}
      />
    </>
  );
};

export { ClassifierItemEditor };
export default ClassifierItemEditor;
