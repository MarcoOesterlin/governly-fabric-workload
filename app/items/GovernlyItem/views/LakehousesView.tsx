import React, { useEffect, useState } from 'react';
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
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import {
  GovernlyApiClient,
  Workspace,
  Lakehouse,
  LakehouseTable,
} from '../../../clients/GovernlyApiClient';

interface LakehousesViewProps {
  apiClient: GovernlyApiClient;
}

export const LakehousesView: React.FC<LakehousesViewProps> = ({ apiClient }) => {
  const { t } = useTranslation();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [lakehouses, setLakehouses] = useState<Lakehouse[]>([]);
  const [tables, setTables] = useState<LakehouseTable[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>('');
  const [selectedLakehouseId, setSelectedLakehouseId] = useState<string>('');
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(true);
  const [loadingLakehouses, setLoadingLakehouses] = useState(false);
  const [loadingTables, setLoadingTables] = useState(false);

  useEffect(() => {
    apiClient.listWorkspaces().catch((): Workspace[] => []).then(ws => {
      setWorkspaces(ws);
      setLoadingWorkspaces(false);
    });
  }, [apiClient]);

  useEffect(() => {
    if (!selectedWorkspaceId) {
      setLakehouses([]);
      setSelectedLakehouseId('');
      setTables([]);
      return;
    }
    setLoadingLakehouses(true);
    setLakehouses([]);
    setSelectedLakehouseId('');
    setTables([]);
    apiClient.listLakehouses(selectedWorkspaceId).catch((): Lakehouse[] => []).then(lh => {
      setLakehouses(lh);
      setLoadingLakehouses(false);
    });
  }, [apiClient, selectedWorkspaceId]);

  useEffect(() => {
    if (!selectedWorkspaceId || !selectedLakehouseId) {
      setTables([]);
      return;
    }
    setLoadingTables(true);
    setTables([]);
    apiClient.listLakehouseTables(selectedWorkspaceId, selectedLakehouseId).catch((): LakehouseTable[] => []).then(t => {
      setTables(t);
      setLoadingTables(false);
    });
  }, [apiClient, selectedWorkspaceId, selectedLakehouseId]);

  const columns: TableColumnDefinition<LakehouseTable>[] = [
    createTableColumn<LakehouseTable>({
      columnId: 'name',
      renderHeaderCell: () => t('Classifier_Lakehouses_ColTable', 'Table'),
      renderCell: (row) => row.name,
    }),
    createTableColumn<LakehouseTable>({
      columnId: 'type',
      renderHeaderCell: () => t('Classifier_Lakehouses_ColType', 'Type'),
      renderCell: (row) => row.type,
    }),
    createTableColumn<LakehouseTable>({
      columnId: 'format',
      renderHeaderCell: () => t('Classifier_Lakehouses_ColFormat', 'Format'),
      renderCell: (row) => row.format,
    }),
  ];

  const selectedWorkspaceName = workspaces.find(w => w.id === selectedWorkspaceId)?.displayName || '';
  const selectedLakehouseName = lakehouses.find(l => l.id === selectedLakehouseId)?.displayName || '';

  return (
    <div style={{ padding: 16 }}>
      {/* Cascading selectors */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        {loadingWorkspaces ? (
          <Spinner size="tiny" label="Loading workspaces…" />
        ) : (
          <Combobox
            placeholder={t('Classifier_Lakehouses_SelectWorkspace', 'Select a workspace')}
            value={selectedWorkspaceName}
            onOptionSelect={(_, data) => setSelectedWorkspaceId(data.optionValue || '')}
            style={{ minWidth: 200 }}
          >
            {workspaces.map(ws => (
              <Option key={ws.id} value={ws.id}>{ws.displayName}</Option>
            ))}
          </Combobox>
        )}

        {selectedWorkspaceId && (
          loadingLakehouses ? (
            <Spinner size="tiny" label="Loading lakehouses…" />
          ) : (
            <Combobox
              placeholder={t('Classifier_Lakehouses_SelectLakehouse', 'Select a lakehouse')}
              value={selectedLakehouseName}
              onOptionSelect={(_, data) => setSelectedLakehouseId(data.optionValue || '')}
              style={{ minWidth: 200 }}
            >
              {lakehouses.map(lh => (
                <Option key={lh.id} value={lh.id}>{lh.displayName}</Option>
              ))}
            </Combobox>
          )
        )}
      </div>

      {/* Tables */}
      {!selectedLakehouseId && (
        <Text>{t('Classifier_Lakehouses_Empty', 'Select a lakehouse to view its tables.')}</Text>
      )}
      {selectedLakehouseId && loadingTables && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Spinner size="medium" />
          <Text>{t('Classifier_Lakehouses_Loading', 'Loading tables…')}</Text>
        </div>
      )}
      {selectedLakehouseId && !loadingTables && tables.length === 0 && (
        <Text>No tables found in this lakehouse.</Text>
      )}
      {selectedLakehouseId && !loadingTables && tables.length > 0 && (
        <DataGrid
          items={tables}
          columns={columns}
          getRowId={(row: LakehouseTable) => row.name}
          style={{ width: '100%' }}
        >
          <DataGridHeader>
            <DataGridRow>
              {({ renderHeaderCell }) => (
                <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>
              )}
            </DataGridRow>
          </DataGridHeader>
          <DataGridBody<LakehouseTable>>
            {({ item, rowId }) => (
              <DataGridRow<LakehouseTable> key={rowId}>
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
