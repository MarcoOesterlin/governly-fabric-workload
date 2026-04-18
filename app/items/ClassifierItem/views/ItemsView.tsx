import React, { useCallback, useMemo, useState } from 'react';
import {
  Badge,
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
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { FabricItem, GovernlyApiClient, SensitivityLabel } from '../../../clients/GovernlyApiClient';
import { LabelPicker } from '../components/LabelPicker';

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
  const color = label?.color;
  const name = label?.name ?? labelName ?? labelId;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      {color && (
        <span style={{
          width: 10, height: 10,
          borderRadius: 2,
          backgroundColor: color,
          border: '1px solid rgba(0,0,0,0.15)',
          flexShrink: 0,
          display: 'inline-block',
        }} />
      )}
      <Badge
        appearance="tint"
        size="small"
        style={color ? { backgroundColor: `${color}22`, color, border: `1px solid ${color}66` } : undefined}
      >
        {name}
      </Badge>
    </span>
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


  const handleLabelChange = useCallback(async (item: FabricItem, labelId: string) => {
    try {
      await apiClient.bulkSetLabels([{ id: item.id, type: item.type }], labelId);
      const labelName = labels.find(l => l.id === labelId)?.name;
      onItemsChange(
        items.map(i => i.id === item.id ? { ...i, sensitivity: { labelId, labelName } } : i)
      );
      setStatusMsg({ type: 'success', text: t('Classifier_Items_LabelUpdated', 'Label updated.') });
    } catch {
      setStatusMsg({ type: 'error', text: t('Classifier_Items_LabelError', 'Failed to update label.') });
    }
    setTimeout(() => setStatusMsg(null), 3000);
  }, [apiClient, labels, items, onItemsChange, t]);

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
        <LabelBadge
          labelId={item.sensitivity?.labelId}
          labelName={item.sensitivity?.labelName}
          labels={labels}
        />
      ),
    }),
    createTableColumn<FabricItem>({
      columnId: 'changeLabel',
      renderHeaderCell: () => t('Classifier_Items_ColChangeLabel', 'Change Label'),
      renderCell: (item) => (
        <LabelPicker
          labels={labels}
          value={item.sensitivity?.labelId}
          onChange={(labelId) => handleLabelChange(item, labelId)}
          placeholder={t('Classifier_Items_NoLabel', 'No label')}
        />
      ),
    }),
  ], [t, labels, handleLabelChange]);

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
