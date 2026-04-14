import React from 'react';
import { Button, Text } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';

interface BulkActionBarProps {
  selectedCount: number;
  onApplyLabel: () => void;
  onRemoveLabel: () => void;
  onClear: () => void;
}

export const BulkActionBar: React.FC<BulkActionBarProps> = ({
  selectedCount,
  onApplyLabel,
  onRemoveLabel,
  onClear,
}) => {
  const { t } = useTranslation();

  if (selectedCount === 0) return null;

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 100,
        backgroundColor: 'var(--colorNeutralBackground1)',
        borderTop: '1px solid var(--colorNeutralStroke1)',
        padding: '8px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        boxShadow: '0 -2px 8px rgba(0,0,0,0.08)',
      }}
    >
      <Text weight="semibold">
        {t('Classifier_BulkBar_Selected', '{{count}} selected', { count: selectedCount })}
      </Text>
      <Button appearance="primary" size="small" onClick={onApplyLabel}>
        {t('Classifier_BulkBar_Apply', 'Apply Label')}
      </Button>
      <Button appearance="secondary" size="small" onClick={onRemoveLabel}>
        {t('Classifier_BulkBar_Remove', 'Remove Label')}
      </Button>
      <Button appearance="transparent" size="small" onClick={onClear}>
        {t('Classifier_BulkBar_Clear', 'Clear selection')}
      </Button>
    </div>
  );
};
