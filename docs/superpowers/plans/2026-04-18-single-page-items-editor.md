# Single-Page Items Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the five-tab Classifier editor with a single flat page listing all workspace items with an inline per-row sensitivity label picker.

**Architecture:** `ClassifierItemEditor` is simplified to fetch labels once and render a single `ItemsView`. `ItemsView` drops all filter UI and multi-select; it renders a DataGrid where each row's Label column is an inline `LabelPicker` that calls `bulkSetLabels` on change. A `MessageBar` at the top of `ItemsView` auto-dismisses after 3 s to report success/error.

**Tech Stack:** React 18, Fluent UI v9 (`@fluentui/react-components`), TypeScript, existing `GovernlyApiClient`, existing `LabelPicker` component.

---

## File Map

| Action | File |
|---|---|
| Modify | `app/items/ClassifierItem/ClassifierItemEditor.tsx` |
| Modify | `app/items/ClassifierItem/views/ItemsView.tsx` |
| No change | `app/items/ClassifierItem/components/LabelPicker.tsx` |
| No change | `app/clients/GovernlyApiClient.ts` |
| No change | `app/components/ItemEditor/ItemEditor.tsx` |

Unused view files (`DashboardView.tsx`, `DomainsView.tsx`, `LakehousesView.tsx`, `LabelsView.tsx`) are left on disk but no longer imported.

---

## Task 1: Simplify ClassifierItemEditor

Remove all bulk/tab machinery and wire labels down to ItemsView.

**Files:**
- Modify: `app/items/ClassifierItem/ClassifierItemEditor.tsx`

- [ ] **Step 1: Replace the file contents**

Replace the full contents of `app/items/ClassifierItem/ClassifierItemEditor.tsx` with:

```tsx
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { WorkloadClientAPI } from '@ms-fabric/workload-client';
import { useTranslation } from 'react-i18next';
import { ArrowClockwise24Regular } from '@fluentui/react-icons';

import { ItemEditor, RegisteredView, ViewContext } from '../../components/ItemEditor';
import { Ribbon } from '../../components/ItemEditor/Ribbon';
import { RibbonAction } from '../../components/ItemEditor/RibbonToolbar';

import { GovernlyApiClient, SensitivityLabel } from '../../clients/GovernlyApiClient';
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
  void itemObjectId;

  const apiClient = useMemo(() => new GovernlyApiClient(workloadClient), [workloadClient]);

  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [labels, setLabels] = useState<SensitivityLabel[]>([]);

  useEffect(() => {
    apiClient.listSensitivityLabels().then(setLabels).catch(() => {});
  }, [apiClient]);

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
          labels={labels}
        />
      ),
    },
  ], [apiClient, refreshTrigger, labels]);

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
```

- [ ] **Step 2: Verify TypeScript is clean**

```bash
npx tsc --noEmit
```

Expected: zero errors in `ClassifierItemEditor.tsx`. (There is a pre-existing unused-variable error in `Workload/src/routes/items.ts` — that is unrelated and can be ignored.)

- [ ] **Step 3: Commit**

```bash
git add app/items/ClassifierItem/ClassifierItemEditor.tsx
git commit -m "refactor: simplify ClassifierItemEditor to single-view, fetch labels once"
```

---

## Task 2: Rewrite ItemsView with inline label picker

Drop filters, drop multi-select, add per-row LabelPicker that calls the API immediately.

**Files:**
- Modify: `app/items/ClassifierItem/views/ItemsView.tsx`

- [ ] **Step 1: Replace the file contents**

Replace the full contents of `app/items/ClassifierItem/views/ItemsView.tsx` with:

```tsx
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
import { FabricItem, FabricItemsPage, GovernlyApiClient, SensitivityLabel } from '../../../clients/GovernlyApiClient';
import { LabelPicker } from '../components/LabelPicker';

interface ItemsViewProps {
  apiClient: GovernlyApiClient;
  labels: SensitivityLabel[];
}

interface StatusMessage {
  type: 'success' | 'error';
  text: string;
}

export const ItemsView: React.FC<ItemsViewProps> = ({ apiClient, labels }) => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<FabricItem[]>([]);
  const [statusMsg, setStatusMsg] = useState<StatusMessage | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiClient.listItems().catch((): FabricItemsPage => ({ items: [] })).then((page) => {
      if (cancelled) return;
      setItems(page.items || []);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [apiClient]);

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
      columnId: 'workspace',
      renderHeaderCell: () => t('Classifier_Items_ColWorkspace', 'Workspace'),
      renderCell: (item) => item.workspaceName || item.workspaceId,
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
```

- [ ] **Step 2: Verify TypeScript is clean**

```bash
npx tsc --noEmit
```

Expected: zero new errors.

- [ ] **Step 3: Commit**

```bash
git add app/items/ClassifierItem/views/ItemsView.tsx
git commit -m "refactor: rewrite ItemsView as flat list with inline per-row label picker"
```

---

## Task 3: Final verification

- [ ] **Step 1: Full TypeScript check**

```bash
npx tsc --noEmit
```

Expected: no new errors beyond pre-existing ones.

- [ ] **Step 2: Dev build smoke test**

```bash
npm run build:ghpages 2>&1 | tail -20
```

Expected: `webpack` exits successfully with no errors.

- [ ] **Step 3: Final commit (if any stragglers)**

```bash
git add -A
git status
```

Expected: clean working tree (no uncommitted changes).
