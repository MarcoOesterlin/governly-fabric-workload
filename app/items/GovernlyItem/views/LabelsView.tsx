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
  Badge,
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { GovernlyApiClient, SensitivityLabel } from '../../../clients/GovernlyApiClient';

interface LabelsViewProps {
  apiClient: GovernlyApiClient;
}

const ColorSwatch: React.FC<{ color?: string; name: string }> = ({ color, name }) => (
  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
    <span
      style={{
        display: 'inline-block',
        width: 12,
        height: 12,
        backgroundColor: color || '#ccc',
        borderRadius: 2,
        border: '1px solid rgba(0,0,0,0.15)',
        flexShrink: 0,
      }}
    />
    <span>{name}</span>
  </span>
);

export const LabelsView: React.FC<LabelsViewProps> = ({ apiClient }) => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [labels, setLabels] = useState<SensitivityLabel[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiClient.listSensitivityLabels()
      .catch((err): SensitivityLabel[] => {
        console.warn('[Governly] listSensitivityLabels failed:', err);
        return [];
      })
      .then(l => {
      if (cancelled) return;
      setLabels(l);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [apiClient]);

  // Flatten with parent rows first, then children grouped under them
  const orderedLabels = React.useMemo(() => {
    const parents = labels.filter(l => !l.parent);
    const childrenByParent: Record<string, SensitivityLabel[]> = {};
    labels.filter(l => l.parent).forEach(l => {
      const pid = l.parent!.id;
      if (!childrenByParent[pid]) childrenByParent[pid] = [];
      childrenByParent[pid].push(l);
    });
    const result: SensitivityLabel[] = [];
    parents.forEach(p => {
      result.push(p);
      (childrenByParent[p.id] || []).forEach(c => result.push(c));
    });
    // Add any remaining labels not covered above
    labels.forEach(l => {
      if (!result.find(r => r.id === l.id)) result.push(l);
    });
    return result;
  }, [labels]);

  const columns: TableColumnDefinition<SensitivityLabel>[] = [
    createTableColumn<SensitivityLabel>({
      columnId: 'name',
      renderHeaderCell: () => t('Classifier_Labels_ColName', 'Label'),
      renderCell: (label) => (
        <span style={{ paddingLeft: label.parent ? 20 : 0 }}>
          <ColorSwatch color={label.color} name={label.name} />
        </span>
      ),
    }),
    createTableColumn<SensitivityLabel>({
      columnId: 'sensitivity',
      renderHeaderCell: () => t('Classifier_Labels_ColLevel', 'Sensitivity'),
      renderCell: (label) => (
        <Badge appearance="filled" color="informative">
          {label.sensitivity}
        </Badge>
      ),
    }),
    createTableColumn<SensitivityLabel>({
      columnId: 'description',
      renderHeaderCell: () => t('Classifier_Labels_ColDescription', 'Description'),
      renderCell: (label) => label.description || '—',
    }),
  ];

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 32 }}>
        <Spinner size="medium" />
        <Text>{t('Classifier_Labels_Loading', 'Loading labels…')}</Text>
      </div>
    );
  }

  if (orderedLabels.length === 0) {
    return (
      <div style={{ padding: 32 }}>
        <Text>{t('Classifier_Labels_Empty', 'No sensitivity labels found in this tenant.')}</Text>
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      <DataGrid
        items={orderedLabels}
        columns={columns}
        getRowId={(label: SensitivityLabel) => label.id}
        style={{ width: '100%' }}
      >
        <DataGridHeader>
          <DataGridRow>
            {({ renderHeaderCell }) => (
              <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>
            )}
          </DataGridRow>
        </DataGridHeader>
        <DataGridBody<SensitivityLabel>>
          {({ item, rowId }) => (
            <DataGridRow<SensitivityLabel> key={rowId}>
              {({ renderCell }) => (
                <DataGridCell>{renderCell(item)}</DataGridCell>
              )}
            </DataGridRow>
          )}
        </DataGridBody>
      </DataGrid>
    </div>
  );
};
