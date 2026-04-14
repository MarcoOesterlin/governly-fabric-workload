import React from 'react';
import {
  Dialog,
  DialogSurface,
  DialogTitle,
  DialogBody,
  DialogActions,
  DialogContent,
  Button,
  ProgressBar,
  Text,
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';

interface BatchProgressDialogProps {
  open: boolean;
  successCount: number;
  failureCount: number;
  failures: Array<{ itemId: string; errorMessage: string }>;
  isComplete: boolean;
  onClose: () => void;
}

export const BatchProgressDialog: React.FC<BatchProgressDialogProps> = ({
  open,
  successCount,
  failureCount,
  failures,
  isComplete,
  onClose,
}) => {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={(_, data) => { if (!data.open && isComplete) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{t('Classifier_Progress_Title', 'Applying labels')}</DialogTitle>
          <DialogContent>
            {!isComplete && (
              <div style={{ padding: '16px 0' }}>
                <ProgressBar />
              </div>
            )}
            {isComplete && (
              <div>
                {successCount > 0 && (
                  <Text style={{ display: 'block', marginBottom: 8 }}>
                    {t('Classifier_Progress_Success', '{{count}} item(s) labeled successfully.', {
                      count: successCount,
                    })}
                  </Text>
                )}
                {failureCount > 0 && (
                  <Text style={{ display: 'block', marginBottom: 8, color: 'var(--colorPaletteRedForeground1)' }}>
                    {t('Classifier_Progress_Failure', '{{count}} item(s) failed.', {
                      count: failureCount,
                    })}
                  </Text>
                )}
                {failures.length > 0 && (
                  <ul style={{ margin: '8px 0', paddingLeft: 20 }}>
                    {failures.map(f => (
                      <li key={f.itemId} style={{ marginBottom: 4, fontSize: 13 }}>
                        <Text>{f.itemId}: {f.errorMessage}</Text>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" disabled={!isComplete} onClick={onClose}>
              {t('Classifier_Progress_Done', 'Done')}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
};
