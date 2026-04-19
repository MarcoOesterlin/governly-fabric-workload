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
  Spinner,
  Text,
  MessageBar,
  MessageBarBody,
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { Domain, GovernlyApiClient, SensitivityLabel } from '../../../clients/GovernlyApiClient';
import { LabelPicker } from '../components/LabelPicker';

interface DomainsViewProps {
  apiClient: GovernlyApiClient;
  onLabelUpdated?: () => void;
}

interface StatusMessage {
  type: 'success' | 'error';
  text: string;
}

export const DomainsView: React.FC<DomainsViewProps> = ({ apiClient, onLabelUpdated }) => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [labels, setLabels] = useState<SensitivityLabel[]>([]);
  const [statusMsg, setStatusMsg] = useState<StatusMessage | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      apiClient.listDomains().catch((): Domain[] => []),
      apiClient.listSensitivityLabels().catch((err): SensitivityLabel[] => {
        console.warn('[Governly] listSensitivityLabels failed:', err);
        return [];
      }),
    ]).then(([d, l]) => {
      if (cancelled) return;
      setDomains(d);
      setLabels(l);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [apiClient]);

  const handleLabelChange = async (domainId: string, labelId: string | null) => {
    try {
      await apiClient.updateDomainLabel(domainId, labelId);
      setDomains(prev =>
        prev.map(d =>
          d.id === domainId
            ? { ...d, defaultLabelId: labelId || undefined, defaultLabelName: labels.find(l => l.id === labelId)?.name }
            : d
        )
      );
      setStatusMsg({ type: 'success', text: 'Default label updated.' });
      onLabelUpdated?.();
    } catch {
      setStatusMsg({ type: 'error', text: 'Failed to update label.' });
    }
    setTimeout(() => setStatusMsg(null), 3000);
  };

  const columns: TableColumnDefinition<Domain>[] = [
    createTableColumn<Domain>({
      columnId: 'name',
      renderHeaderCell: () => t('Classifier_Domains_ColName', 'Name'),
      renderCell: (domain) => domain.displayName,
    }),
    createTableColumn<Domain>({
      columnId: 'description',
      renderHeaderCell: () => t('Classifier_Domains_ColDescription', 'Description'),
      renderCell: (domain) => domain.description || '—',
    }),
    createTableColumn<Domain>({
      columnId: 'parent',
      renderHeaderCell: () => t('Classifier_Domains_ColParent', 'Parent'),
      renderCell: (domain) => domain.parentDomainName || '—',
    }),
    createTableColumn<Domain>({
      columnId: 'defaultLabel',
      renderHeaderCell: () => t('Classifier_Domains_ColDefaultLabel', 'Default Label'),
      renderCell: (domain) => (
        <LabelPicker
          labels={labels}
          value={domain.defaultLabelId}
          onChange={(labelId) => handleLabelChange(domain.id, labelId)}
          placeholder="No label"
        />
      ),
    }),
  ];

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 32 }}>
        <Spinner size="medium" />
        <Text>{t('Classifier_Domains_Loading', 'Loading domains…')}</Text>
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

      {domains.length === 0 ? (
        <Text>{t('Classifier_Domains_Empty', 'No domains found.')}</Text>
      ) : (
        <DataGrid
          items={domains}
          columns={columns}
          getRowId={(domain: Domain) => domain.id}
          style={{ width: '100%' }}
        >
          <DataGridHeader>
            <DataGridRow>
              {({ renderHeaderCell }) => (
                <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>
              )}
            </DataGridRow>
          </DataGridHeader>
          <DataGridBody<Domain>>
            {({ item, rowId }) => (
              <DataGridRow<Domain> key={rowId}>
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
