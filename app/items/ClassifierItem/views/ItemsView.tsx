import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DataGrid,
  DataGridHeader,
  DataGridHeaderCell,
  DataGridBody,
  DataGridRow,
  DataGridCell,
  TableColumnDefinition,
  createTableColumn,
  Spinner,
  Text,
  MessageBar,
  MessageBarBody,
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { FabricItem, GovernlyApiClient, SensitivityLabel } from '../../../clients/GovernlyApiClient';
import { LabelPicker } from '../components/LabelPicker';

interface ItemsViewProps {
  apiClient: GovernlyApiClient;
  workspaceId?: string;
  labels: SensitivityLabel[];
}

interface StatusMessage {
  type: 'success' | 'error';
  text: string;
}

export const ItemsView: React.FC<ItemsViewProps> = ({ apiClient, workspaceId, labels }) => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<FabricItem[]>([]);
  const [statusMsg, setStatusMsg] = useState<StatusMessage | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (workspaceId) {
      setLoading(true);
      apiClient.listWorkspaceItems(workspaceId)
        .then((fetched) => {
          if (cancelled) return;
          setItems(fetched);
          setLoading(false);
        })
        .catch(() => {
          if (cancelled) return;
          setItems([]);
          setLoading(false);
        });
    }
    return () => { cancelled = true; };
  }, [apiClient, workspaceId]);

  const handleLabelChange = useCallback(async (item: FabricItem, labelId: string) => {
    try {
      await apiClient.bulkSetLabels([{ id: item.id, type: item.type }], labelId);
      const labelName = labels.find(l => l.id === labelId)?.name;
      setItems(prev =>
        prev.map(i =>
          i.id === item.id
            ? { ...i, sensitivity: { labelId, labelName } }
            : i
        )
      );
      setStatusMsg({ type: 'success', text: t('Classifier_Items_LabelUpdated', 'Label updated.') });
    } catch {
      setStatusMsg({ type: 'error', text: t('Classifier_Items_LabelError', 'Failed to update label.') });
    }
    setTimeout(() => setStatusMsg(null), 3000);
  }, [apiClient, labels, t]);

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
      columnId: 'label',
      renderHeaderCell: () => t('Classifier_Items_ColLabel', 'Sensitivity Label'),
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

  if (!workspaceId || loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 32 }}>
        <Spinner size="medium" />
        <Text>{t('Classifier_Items_Loading', 'Loading items…')}</Text>
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
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
