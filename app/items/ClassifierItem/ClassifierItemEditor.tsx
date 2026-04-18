import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { WorkloadClientAPI } from '@ms-fabric/workload-client';
import { useTranslation } from 'react-i18next';
import { ArrowClockwise24Regular } from '@fluentui/react-icons';

import { ItemEditor, RegisteredView, ViewContext } from '../../components/ItemEditor';
import { Ribbon } from '../../components/ItemEditor/Ribbon';
import { RibbonAction } from '../../components/ItemEditor/RibbonToolbar';

import { GovernlyApiClient, SensitivityLabel } from '../../clients/GovernlyApiClient';
import { callGetItem } from '../../controller/ItemCRUDController';
import { ItemsView } from './views/ItemsView';

interface ClassifierItemEditorProps {
  workloadClient: WorkloadClientAPI;
}

interface ClassifierRibbonProps {
  viewContext: ViewContext;
  onRefresh: () => void;
}

const ClassifierRibbon: React.FC<ClassifierRibbonProps> = ({ viewContext, onRefresh }) => {
  const { t } = useTranslation();
  const homeActions: RibbonAction[] = [
    {
      key: 'refresh',
      label: t('Classifier_Ribbon_Refresh', 'Refresh'),
      icon: ArrowClockwise24Regular,
      onClick: onRefresh,
    },
  ];
  return <Ribbon homeToolbarActions={homeActions} viewContext={viewContext} />;
};

const ClassifierItemEditor: React.FC<ClassifierItemEditorProps> = ({ workloadClient }) => {
  const { itemObjectId } = useParams<{ itemObjectId: string }>();

  const apiClient = useMemo(() => new GovernlyApiClient(workloadClient), [workloadClient]);

  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [labels, setLabels] = useState<SensitivityLabel[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | undefined>();

  useEffect(() => {
    apiClient.listSensitivityLabels().then(setLabels).catch(() => {});
  }, [apiClient]);

  useEffect(() => {
    if (!itemObjectId) return;
    callGetItem(workloadClient, itemObjectId).then(result => {
      if (result?.item?.workspaceId) setWorkspaceId(result.item.workspaceId);
    }).catch(() => {});
  }, [workloadClient, itemObjectId]);

  const handleRefresh = useCallback(() => {
    setRefreshTrigger(prev => prev + 1);
  }, []);

  const views: RegisteredView[] = useMemo(() => [
    {
      name: 'items',
      component: (
        <ItemsView
          key={refreshTrigger}
          apiClient={apiClient}
          workspaceId={workspaceId}
          labels={labels}
        />
      ),
    },
  ], [apiClient, refreshTrigger, labels, workspaceId]);

  return (
    <ItemEditor
      ribbon={(context: ViewContext) => (
        <ClassifierRibbon
          viewContext={context}
          onRefresh={handleRefresh}
        />
      )}
      views={views}
      initialView="items"
    />
  );
};

export { ClassifierItemEditor };
export default ClassifierItemEditor;
