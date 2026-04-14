import React, { useEffect, useMemo, useState } from 'react';
import {
  DataGrid,
  DataGridHeader,
  DataGridHeaderCell,
  DataGridBody,
  DataGridRow,
  DataGridCell,
  TableColumnDefinition,
  createTableColumn,
  Combobox,
  Option,
  Spinner,
  Text,
  TableRowId,
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { FabricItem, FabricItemsPage, GovernlyApiClient, Workspace } from '../../../clients/GovernlyApiClient';

interface ItemsViewProps {
  apiClient: GovernlyApiClient;
  selectedItems: FabricItem[];
  onSelectionChange: (items: FabricItem[]) => void;
}

type LabelFilter = 'all' | 'labeled' | 'unlabeled';

export const ItemsView: React.FC<ItemsViewProps> = ({
  apiClient,
  selectedItems,
  onSelectionChange,
}) => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<FabricItem[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [filterWorkspaceId, setFilterWorkspaceId] = useState<string>('');
  const [filterType, setFilterType] = useState<string>('');
  const [filterLabel, setFilterLabel] = useState<LabelFilter>('all');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      apiClient.listItems().catch((): FabricItemsPage => ({ items: [] })),
      apiClient.listWorkspaces().catch((): Workspace[] => []),
    ]).then(([page, ws]) => {
      if (cancelled) return;
      setItems(page.items || []);
      setWorkspaces(ws);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [apiClient]);

  const itemTypes = useMemo(() => {
    const types = new Set(items.map(i => i.type));
    return Array.from(types).sort();
  }, [items]);

  const filteredItems = useMemo(() => {
    return items.filter(item => {
      if (filterWorkspaceId && item.workspaceId !== filterWorkspaceId) return false;
      if (filterType && item.type !== filterType) return false;
      if (filterLabel === 'labeled' && !item.sensitivity?.labelId) return false;
      if (filterLabel === 'unlabeled' && !!item.sensitivity?.labelId) return false;
      return true;
    });
  }, [items, filterWorkspaceId, filterType, filterLabel]);

  const selectedKeys = useMemo(
    () => new Set<TableRowId>(selectedItems.map(i => i.id)),
    [selectedItems]
  );

  const columns: TableColumnDefinition<FabricItem>[] = [
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
      columnId: 'workspace',
      renderHeaderCell: () => t('Classifier_Items_ColWorkspace', 'Workspace'),
      renderCell: (item) => item.workspaceName || item.workspaceId,
    }),
    createTableColumn<FabricItem>({
      columnId: 'label',
      renderHeaderCell: () => t('Classifier_Items_ColLabel', 'Current Label'),
      renderCell: (item) => item.sensitivity?.labelName || '—',
    }),
  ];

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 32 }}>
        <Spinner size="medium" />
        <Text>{t('Classifier_Items_Loading', 'Loading items…')}</Text>
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <Combobox
          placeholder={t('Classifier_Items_FilterWorkspace', 'Workspace')}
          value={workspaces.find(w => w.id === filterWorkspaceId)?.displayName || ''}
          onOptionSelect={(_, data) => setFilterWorkspaceId(data.optionValue || '')}
          clearable
          style={{ minWidth: 180 }}
        >
          <Option value="">All workspaces</Option>
          {workspaces.map(ws => (
            <Option key={ws.id} value={ws.id}>{ws.displayName}</Option>
          ))}
        </Combobox>

        <Combobox
          placeholder={t('Classifier_Items_FilterType', 'Item type')}
          value={filterType}
          onOptionSelect={(_, data) => setFilterType(data.optionValue || '')}
          clearable
          style={{ minWidth: 160 }}
        >
          <Option value="">All types</Option>
          {itemTypes.map(type => (
            <Option key={type} value={type}>{type}</Option>
          ))}
        </Combobox>

        <Combobox
          placeholder={t('Classifier_Items_FilterLabel', 'Label status')}
          value={filterLabel}
          onOptionSelect={(_, data) => setFilterLabel((data.optionValue || 'all') as LabelFilter)}
          style={{ minWidth: 160 }}
        >
          <Option value="all">All</Option>
          <Option value="labeled">Labeled</Option>
          <Option value="unlabeled">Unlabeled</Option>
        </Combobox>
      </div>

      {filteredItems.length === 0 ? (
        <Text>{t('Classifier_Items_Empty', 'No items match the current filters.')}</Text>
      ) : (
        <DataGrid
          items={filteredItems}
          columns={columns}
          selectionMode="multiselect"
          selectedItems={selectedKeys}
          onSelectionChange={(_, data) => {
            const selectedIds = data.selectedItems as Set<string>;
            onSelectionChange(filteredItems.filter(i => selectedIds.has(i.id)));
          }}
          getRowId={(item: FabricItem) => item.id}
          style={{ width: '100%' }}
        >
          <DataGridHeader>
            <DataGridRow selectionCell={{ 'aria-label': t('Classifier_Items_SelectAll', 'Select all') }}>
              {({ renderHeaderCell }) => (
                <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>
              )}
            </DataGridRow>
          </DataGridHeader>
          <DataGridBody<FabricItem>>
            {({ item, rowId }) => (
              <DataGridRow<FabricItem>
                key={rowId}
                selectionCell={{ 'aria-label': `Select ${item.displayName}` }}
              >
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
