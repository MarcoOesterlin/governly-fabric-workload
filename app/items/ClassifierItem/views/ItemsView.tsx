import React, { useCallback, useMemo, useState } from 'react';
import {
  DataGrid,
  DataGridHeader,
  DataGridHeaderCell,
  DataGridBody,
  DataGridRow,
  DataGridCell,
  TableColumnDefinition,
  createTableColumn,
  Text,
  Spinner,
  MessageBar,
  MessageBarBody,
  Tooltip,
  Button,
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { FabricItem, GovernlyApiClient, SensitivityLabel } from '../../../clients/GovernlyApiClient';
import { LabelPicker, REMOVE_LABEL } from '../components/LabelPicker';

interface LabelBadgeProps {
  labelId?: string;
  labelName?: string;
  labels: SensitivityLabel[];
}

const LabelBadge: React.FC<LabelBadgeProps> = ({ labelId, labelName, labels }) => {
  if (!labelId && !labelName) {
    return <Text size={200} style={{ color: '#999', fontStyle: 'italic' }}>None</Text>;
  }
  const label = labels.find(l => l.id?.toLowerCase() === labelId?.toLowerCase());
  const color = label?.color ?? '#888';
  const name = label?.name ?? labelName ?? labelId ?? '';
  const tooltipContent = label?.description ?? name;

  return (
    <Tooltip content={tooltipContent} relationship="description" withArrow>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'default' }}>
        <span style={{
          width: 10, height: 10,
          borderRadius: 2,
          backgroundColor: color,
          border: '1px solid rgba(0,0,0,0.2)',
          flexShrink: 0,
          display: 'inline-block',
        }} />
        <span style={{
          fontSize: 12,
          padding: '1px 6px',
          borderRadius: 3,
          backgroundColor: `${color}22`,
          color,
          border: `1px solid ${color}66`,
        }}>
          {name}
        </span>
      </span>
    </Tooltip>
  );
};

interface ItemsViewProps {
  apiClient: GovernlyApiClient;
  workspaceId?: string;
  workspaceError?: string;
  labels: SensitivityLabel[];
  labelsError?: string;
  items: FabricItem[];
  itemsLoading: boolean;
  itemsError?: string;
  onItemsChange: (items: FabricItem[]) => void;
}

interface StatusMessage {
  type: 'success' | 'error';
  text: string;
}

export const ItemsView: React.FC<ItemsViewProps> = ({
  apiClient, workspaceId, workspaceError, labels, labelsError,
  items, itemsLoading, itemsError, onItemsChange,
}) => {
  const { t } = useTranslation();
  const [statusMsg, setStatusMsg] = useState<StatusMessage | null>(null);
  const [pendingChanges, setPendingChanges] = useState<Record<string, string>>({});
  const [applying, setApplying] = useState(false);

  const hasPending = Object.keys(pendingChanges).length > 0;

  const stageChange = useCallback((item: FabricItem, labelId: string) => {
    setPendingChanges(prev => ({ ...prev, [item.id]: labelId }));
  }, []);

  const discardChanges = useCallback(() => setPendingChanges({}), []);

  const applyChanges = useCallback(async () => {
    setApplying(true);
    const entries = Object.entries(pendingChanges);

    // Group item IDs by target label (REMOVE_LABEL = '' means "remove")
    const byLabel = new Map<string, string[]>();
    for (const [itemId, labelId] of entries) {
      if (!byLabel.has(labelId)) byLabel.set(labelId, []);
      byLabel.get(labelId)!.push(itemId);
    }

    const successIds = new Set<string>();
    const failures: string[] = [];

    for (const [labelId, itemIds] of byLabel) {
      const batchItems = items
        .filter(i => itemIds.includes(i.id))
        .map(i => ({ id: i.id, type: i.type }));

      try {
        if (labelId === REMOVE_LABEL) {
          // Remove labels from these items
          const result = await apiClient.bulkRemoveLabels(batchItems);
          if (result.failureCount > 0) {
            failures.push(...result.failures.map(f => f.errorMessage));
          } else {
            itemIds.forEach(id => successIds.add(id));
          }
        } else {
          // Apply a new label to these items
          const result = await apiClient.bulkSetLabels(batchItems, labelId);
          if (result.failureCount > 0) {
            failures.push(...result.failures.map(f => f.errorMessage));
          } else {
            itemIds.forEach(id => successIds.add(id));
          }
        }
      } catch (e: any) {
        failures.push(e?.message ?? 'Unknown error');
      }
    }

    if (successIds.size > 0) {
      onItemsChange(items.map(i => {
        if (successIds.has(i.id)) {
          const labelId = pendingChanges[i.id];
          if (labelId === REMOVE_LABEL) {
            return { ...i, sensitivity: undefined };
          }
          const labelName = labels.find(l => l.id === labelId)?.name;
          return { ...i, sensitivity: { labelId, labelName } };
        }
        return i;
      }));
      setPendingChanges(prev => {
        const next = { ...prev };
        successIds.forEach(id => delete next[id]);
        return next;
      });
    }

    setApplying(false);

    if (failures.length > 0) {
      setStatusMsg({ type: 'error', text: `Failed to apply ${failures.length} change(s): ${failures.join('; ')}` });
    } else {
      setStatusMsg({ type: 'success', text: `Successfully applied ${successIds.size} change(s).` });
    }
    setTimeout(() => setStatusMsg(null), 8000);
  }, [apiClient, pendingChanges, items, labels, onItemsChange]);

  const columns: TableColumnDefinition<FabricItem>[] = useMemo(() => [
    createTableColumn<FabricItem>({
      columnId: 'name',
      renderHeaderCell: () => t('Classifier_Items_ColName', 'Name'),
      renderCell: (item) => item.displayName,
    }),
    createTableColumn<FabricItem>({
      columnId: 'type',
      renderHeaderCell: () => t('Classifier_Items_ColType', 'Type'),
      renderCell: (item) => item.type,
    }),
    createTableColumn<FabricItem>({
      columnId: 'currentLabel',
      renderHeaderCell: () => t('Classifier_Items_ColCurrentLabel', 'Current Label'),
      renderCell: (item) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <LabelBadge
            labelId={item.sensitivity?.labelId}
            labelName={item.sensitivity?.labelName}
            labels={labels}
          />
          {pendingChanges[item.id] && (
            <Tooltip content="Change staged — click Apply to write to Fabric" relationship="description" withArrow>
              <span style={{
                width: 8, height: 8, borderRadius: '50%',
                backgroundColor: '#f7630c', display: 'inline-block', flexShrink: 0,
              }} />
            </Tooltip>
          )}
        </span>
      ),
    }),
    createTableColumn<FabricItem>({
      columnId: 'changeLabel',
      renderHeaderCell: () => t('Classifier_Items_ColChangeLabel', 'Change Label'),
      renderCell: (item) => (
        <LabelPicker
          labels={labels}
          value={pendingChanges[item.id] ?? item.sensitivity?.labelId}
          onChange={(labelId) => stageChange(item, labelId)}
          placeholder={t('Classifier_Items_NoLabel', 'No label')}
        />
      ),
    }),
  ], [t, labels, pendingChanges, stageChange]);

  if (workspaceError) {
    return (
      <div style={{ padding: 24 }}>
        <MessageBar intent="error">
          <MessageBarBody><strong>Workspace Error:</strong> {workspaceError}</MessageBarBody>
        </MessageBar>
      </div>
    );
  }

  if (!workspaceId) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 32 }}>
        <Spinner size="medium" />
        <Text>{t('Classifier_Items_ConnectingWorkspace', 'Connecting to workspace…')}</Text>
      </div>
    );
  }

  if (itemsLoading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 32 }}>
        <Spinner size="medium" />
        <Text>{t('Classifier_Items_Loading', 'Loading workspace items…')}</Text>
      </div>
    );
  }

  if (itemsError) {
    return (
      <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <MessageBar intent="error">
          <MessageBarBody><strong>Failed to load workspace items:</strong> {itemsError}</MessageBarBody>
        </MessageBar>
        <Text size={200} style={{ color: '#555' }}>
          Tip: Make sure you are logged in with <code>az login</code> and the Dev Gateway is running.
        </Text>
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      {labelsError && (
        <MessageBar intent="warning" style={{ marginBottom: 12 }}>
          <MessageBarBody><strong>Could not load sensitivity labels:</strong> {labelsError}</MessageBarBody>
        </MessageBar>
      )}
      {statusMsg && (
        <MessageBar intent={statusMsg.type === 'success' ? 'success' : 'error'} style={{ marginBottom: 12 }}>
          <MessageBarBody>{statusMsg.text}</MessageBarBody>
        </MessageBar>
      )}

      {hasPending && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12,
          padding: '10px 14px', borderRadius: 6,
          backgroundColor: '#fff8f0', border: '1px solid #f7630c44',
        }}>
          <span style={{ fontSize: 13, color: '#c94f07', flex: 1 }}>
            <strong>{Object.keys(pendingChanges).length}</strong> label change{Object.keys(pendingChanges).length !== 1 ? 's' : ''} staged — review and apply when ready
          </span>
          <Button
            appearance="primary"
            disabled={applying}
            onClick={applyChanges}
          >
            {applying ? 'Applying…' : `Apply ${Object.keys(pendingChanges).length} change${Object.keys(pendingChanges).length !== 1 ? 's' : ''}`}
          </Button>
          <Button appearance="subtle" disabled={applying} onClick={discardChanges}>
            Discard
          </Button>
        </div>
      )}

      {items.length === 0 ? (
        <Text>{t('Classifier_Items_Empty', 'No items found in this workspace.')}</Text>
      ) : (
        <DataGrid
          items={items}
          columns={columns}
          getRowId={(item: FabricItem) => item.id}
          style={{ width: '100%' }}
        >
          <DataGridHeader>
            <DataGridRow>
              {({ renderHeaderCell }) => (
                <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>
              )}
            </DataGridRow>
          </DataGridHeader>
          <DataGridBody<FabricItem>>
            {({ item, rowId }) => (
              <DataGridRow<FabricItem> key={rowId}>
                {({ renderCell }) => (
                  <DataGridCell>{renderCell(item)}</DataGridCell>
                )}
              </DataGridRow>
            )}
          </DataGridBody>
        </DataGrid>
      )}
    </div>
  );
};
