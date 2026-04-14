import React, { useEffect, useState } from 'react';
import {
  Card,
  CardHeader,
  Spinner,
  Button,
  Text,
} from '@fluentui/react-components';
import {
  GridRegular,
  DocumentRegular,
  TagRegular,
  WarningRegular,
} from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { Domain, FabricItemsPage, GovernlyApiClient, SensitivityLabel } from '../../../clients/GovernlyApiClient';

interface DashboardViewProps {
  apiClient: GovernlyApiClient;
  onNavigateTo: (view: string) => void;
}

interface DashboardSummary {
  totalDomains: number;
  totalItems: number;
  unlabeledItems: number;
  totalLabels: number;
}

interface SummaryCardProps {
  icon: React.ReactNode;
  count: number;
  title: string;
  viewTarget: string;
  onNavigateTo: (view: string) => void;
}

const SummaryCard: React.FC<SummaryCardProps> = ({ icon, count, title, viewTarget, onNavigateTo }) => (
  <Card style={{ minWidth: 160, flex: '1 1 160px' }}>
    <CardHeader
      image={<span style={{ fontSize: 24 }}>{icon}</span>}
      header={
        <Text size={500} weight="semibold" style={{ display: 'block' }}>
          {count.toLocaleString()}
        </Text>
      }
      description={<Text size={300}>{title}</Text>}
    />
    <div style={{ padding: '0 12px 12px' }}>
      <Button
        appearance="transparent"
        size="small"
        onClick={() => onNavigateTo(viewTarget)}
      >
        View →
      </Button>
    </div>
  </Card>
);

export const DashboardView: React.FC<DashboardViewProps> = ({ apiClient, onNavigateTo }) => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<DashboardSummary>({
    totalDomains: 0,
    totalItems: 0,
    unlabeledItems: 0,
    totalLabels: 0,
  });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    Promise.all([
      apiClient.listDomains().catch((): Domain[] => []),
      apiClient.listItems().catch((): FabricItemsPage => ({ items: [] })),
      apiClient.listSensitivityLabels().catch((): SensitivityLabel[] => []),
    ]).then(([domains, itemsPage, labels]) => {
      if (cancelled) return;
      const items = itemsPage.items || [];
      setSummary({
        totalDomains: domains.length,
        totalItems: items.length,
        unlabeledItems: items.filter(i => !i.sensitivity?.labelId).length,
        totalLabels: labels.length,
      });
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [apiClient]);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 32 }}>
        <Spinner size="medium" />
        <Text>{t('Classifier_Dashboard_Loading', 'Loading summary…')}</Text>
      </div>
    );
  }

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <SummaryCard
          icon={<GridRegular />}
          count={summary.totalDomains}
          title={t('Classifier_Dashboard_TotalDomains', 'Domains')}
          viewTarget="domains"
          onNavigateTo={onNavigateTo}
        />
        <SummaryCard
          icon={<DocumentRegular />}
          count={summary.totalItems}
          title={t('Classifier_Dashboard_TotalItems', 'Total Items')}
          viewTarget="items"
          onNavigateTo={onNavigateTo}
        />
        <SummaryCard
          icon={<WarningRegular />}
          count={summary.unlabeledItems}
          title={t('Classifier_Dashboard_Unlabeled', 'Unlabeled')}
          viewTarget="items"
          onNavigateTo={onNavigateTo}
        />
        <SummaryCard
          icon={<TagRegular />}
          count={summary.totalLabels}
          title="Labels"
          viewTarget="labels"
          onNavigateTo={onNavigateTo}
        />
      </div>
    </div>
  );
};
