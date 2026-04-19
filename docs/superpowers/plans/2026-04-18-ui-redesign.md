# Governly UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the tab-based layout with a sidebar + branded header shell, wire up all five views, and fix the Items view to show current sensitivity labels.

**Architecture:** `ClassifierItemEditor.tsx` is rebuilt as a standalone three-zone layout (header / sidebar / content) that no longer uses `ItemEditor`. All five views are registered and rendered by view key. `ItemsView.tsx` switches its data source to the admin `listItems` API and gains a "Current Label" badge column.

**Tech Stack:** React, Fluent UI v9 (`@fluentui/react-components`, `@fluentui/react-icons`), TypeScript

---

## File Map

| File | Action |
|------|--------|
| `app/index.ui.tsx` | Remove black debug bar DOM element; replace `dbg()` calls with `console.log` |
| `app/App.tsx` | Remove blue debug bar div; remove `paddingTop: 24` wrapper |
| `app/items/ClassifierItem/ClassifierItemEditor.tsx` | Full redesign — remove `ItemEditor`, add header + sidebar + content shell, register all 5 views |
| `app/items/ClassifierItem/views/ItemsView.tsx` | Switch to `listItems` admin API, add "Current Label" Badge column |

---

## Task 1: Remove debug bars

**Files:**
- Modify: `app/index.ui.tsx`
- Modify: `app/App.tsx`

- [ ] **Step 1: Remove black debug bar from `index.ui.tsx`**

Replace the entire debug bar block and `dbg()` helper with plain `console.log` calls. The file should look like this after the edit:

```typescript
import { createBrowserHistory } from "history";
import React from "react";
import { createRoot } from 'react-dom/client';

import { FluentProvider } from "@fluentui/react-components";
import { createWorkloadClient, InitParams } from '@ms-fabric/workload-client';

import { fabricLightTheme } from "./theme";
import { App } from "./App";

export async function initialize(params: InitParams) {
    console.log('🚀 UI initialization started with params:', params);

    const workloadClient = createWorkloadClient();
    console.log('✅ WorkloadClient created successfully');

    const history = createBrowserHistory();
    console.log('✅ Browser history created, initial path:', history.location.pathname);

    history.listen((location, action) => {
        console.log(`🔄 History changed [${action}]: ${location.pathname}`);
    });

    workloadClient.navigation.onNavigate((route) => {
        const hint = route.workspaceObjectIdHint ?? 'none';
        console.log(`NAV: ${route.targetUrl} | wsHint:${hint}`);
        let url = route.targetUrl;
        if (route.workspaceObjectIdHint) {
            const separator = url.includes('?') ? '&' : '?';
            url = `${url}${separator}wsId=${route.workspaceObjectIdHint}`;
        }
        history.push(url);
    });

    workloadClient.action.onAction(async function ({ action }) {
        console.log(`ACTION: ${action}`);
        switch (action) {
            case 'item.tab.onInit':
                return { title: 'Governly' };
            case 'item.tab.canDeactivate':
                return { canDeactivate: true };
            case 'item.tab.onDeactivate':
                return {};
            case 'item.tab.canDestroy':
                return { canDestroy: true };
            case 'item.tab.onDestroy':
                return {};
            case 'item.tab.onDelete':
                return {};
            default:
                console.log(`Unknown action: ${action}`);
                return {};
        }
    });

    const rootElement = document.getElementById('root');
    if (!rootElement) {
        console.error('❌ Root element not found!');
        document.body.innerHTML = '<div style="padding: 20px; color: red;">❌ Error: Root element not found</div>';
        return;
    }

    try {
        const root = createRoot(rootElement);
        root.render(
            <FluentProvider theme={fabricLightTheme}>
                <App history={history} workloadClient={workloadClient} />
            </FluentProvider>
        );
        console.log('✅ App rendered');
    } catch (error) {
        console.error('❌ Error during React rendering:', error);
        rootElement.innerHTML = `
            <div style="padding: 20px; color: red; font-family: monospace;">
                <h2>❌ React Rendering Error</h2>
                <p>Error: ${(error as Error).message}</p>
                <pre>${(error as Error).stack}</pre>
            </div>
        `;
    }
}
```

- [ ] **Step 2: Remove blue debug bar and paddingTop wrapper from `App.tsx`**

The `App` function body should become:

```typescript
export function App({ history, workloadClient }: AppProps) {
    console.log('🎯 App component rendering, location:', history.location.pathname);

    return <Router history={history}>
        <ErrorBoundary>
        <Switch>
            <Route path="/index.html/:itemObjectId">
                <ClassifierItemEditor workloadClient={workloadClient} />
            </Route>
            <Route path="/ClassifierItem-editor/:itemObjectId">
                <ClassifierItemEditor workloadClient={workloadClient} />
            </Route>
            <ConditionalPlaygroundRoutes workloadClient={workloadClient} />
            <Route>
                <DebugRoute />
            </Route>
        </Switch>
        </ErrorBoundary>
    </Router>;
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```
npx tsc --noEmit
```

Expected: no new errors (there is a pre-existing unused `claims` variable error in `Workload/src/routes/items.ts` — that is acceptable and unrelated).

- [ ] **Step 4: Commit**

```
git add app/index.ui.tsx app/App.tsx
git commit -m "chore: remove debug bars from index.ui.tsx and App.tsx

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: Redesign ClassifierItemEditor with sidebar layout

**Files:**
- Modify: `app/items/ClassifierItem/ClassifierItemEditor.tsx`

- [ ] **Step 1: Rewrite `ClassifierItemEditor.tsx`**

Replace the entire file contents with the following. This removes `ItemEditor`, adds the branded header, sidebar, and content area, and registers all five views:

```typescript
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useLocation } from 'react-router-dom';
import { WorkloadClientAPI } from '@ms-fabric/workload-client';
import { useTranslation } from 'react-i18next';
import { tokens } from '@fluentui/react-components';
import {
  ArrowClockwise24Regular,
  ShieldTask24Regular,
  AppsList24Regular,
  Tag24Regular,
  BuildingMultiple24Regular,
  Database24Regular,
  DataPie24Regular,
} from '@fluentui/react-icons';

import { GovernlyApiClient, SensitivityLabel } from '../../clients/GovernlyApiClient';
import { callGetItem } from '../../controller/ItemCRUDController';
import { ItemsView } from './views/ItemsView';
import { LabelsView } from './views/LabelsView';
import { DomainsView } from './views/DomainsView';
import { LakehousesView } from './views/LakehousesView';
import { DashboardView } from './views/DashboardView';

interface ClassifierItemEditorProps {
  workloadClient: WorkloadClientAPI;
}

type ViewKey = 'items' | 'labels' | 'domains' | 'lakehouses' | 'dashboard';

interface NavItem {
  key: ViewKey;
  labelKey: string;
  defaultLabel: string;
  icon: React.ReactElement;
}

const NAV_ITEMS: NavItem[] = [
  { key: 'items',      labelKey: 'Nav_Items',      defaultLabel: 'Items',      icon: <AppsList24Regular /> },
  { key: 'labels',     labelKey: 'Nav_Labels',     defaultLabel: 'Labels',     icon: <Tag24Regular /> },
  { key: 'domains',    labelKey: 'Nav_Domains',    defaultLabel: 'Domains',    icon: <BuildingMultiple24Regular /> },
  { key: 'lakehouses', labelKey: 'Nav_Lakehouses', defaultLabel: 'Lakehouses', icon: <Database24Regular /> },
  { key: 'dashboard',  labelKey: 'Nav_Dashboard',  defaultLabel: 'Dashboard',  icon: <DataPie24Regular /> },
];

const ClassifierItemEditor: React.FC<ClassifierItemEditorProps> = ({ workloadClient }) => {
  const { itemObjectId } = useParams<{ itemObjectId: string }>();
  const location = useLocation();
  const wsIdFromUrl = new URLSearchParams(location.search).get('wsId') ?? undefined;
  const { t } = useTranslation();

  const apiClient = useMemo(() => new GovernlyApiClient(workloadClient), [workloadClient]);

  const [activeView, setActiveView] = useState<ViewKey>('items');
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [labels, setLabels] = useState<SensitivityLabel[]>([]);
  const [labelsError, setLabelsError] = useState<string | undefined>();
  const [workspaceId, setWorkspaceId] = useState<string | undefined>();
  const [workspaceError, setWorkspaceError] = useState<string | undefined>();

  useEffect(() => {
    apiClient.listSensitivityLabels()
      .then(fetched => {
        console.log('[Governly] Loaded', fetched.length, 'sensitivity labels');
        setLabels(fetched);
        setLabelsError(undefined);
      })
      .catch((err: any) => {
        console.error('[Governly] listSensitivityLabels failed:', err);
        setLabelsError(err?.message ?? String(err));
      });
  }, [apiClient]);

  useEffect(() => {
    if (!itemObjectId) return;

    if (wsIdFromUrl) {
      console.log('[Governly] workspaceId from URL hint:', wsIdFromUrl);
      setWorkspaceId(wsIdFromUrl);
      setWorkspaceError(undefined);
      return;
    }

    console.log('[Governly] Resolving workspaceId via callGetItem for item:', itemObjectId);

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Timed out resolving workspace (10s). Check the Dev Gateway is running.')), 10000)
    );

    Promise.race([callGetItem(workloadClient, itemObjectId), timeout])
      .then(result => {
        console.log('[Governly] callGetItem result:', JSON.stringify(result));
        if (result?.item?.workspaceId) {
          setWorkspaceId(result.item.workspaceId);
        } else {
          const devWsId = process.env.WORKSPACE_GUID;
          if (devWsId) {
            console.warn('[Governly] Using WORKSPACE_GUID fallback:', devWsId);
            setWorkspaceId(devWsId);
          } else {
            setWorkspaceError('Could not resolve workspace ID from item metadata.');
          }
        }
      })
      .catch((err: any) => {
        console.error('[Governly] callGetItem failed:', err);
        const devWsId = process.env.WORKSPACE_GUID;
        if (devWsId) {
          console.warn('[Governly] Using WORKSPACE_GUID fallback:', devWsId);
          setWorkspaceId(devWsId);
          return;
        }
        const msg = err?.message ?? err?.errorDescription
          ?? (typeof err === 'object' ? JSON.stringify(err) : String(err));
        setWorkspaceError(`Failed to load workspace context: ${msg}`);
      });
  }, [workloadClient, itemObjectId, wsIdFromUrl]);

  const handleRefresh = useCallback(() => {
    setRefreshTrigger(prev => prev + 1);
  }, []);

  const renderContent = () => {
    switch (activeView) {
      case 'items':
        return (
          <ItemsView
            key={refreshTrigger}
            apiClient={apiClient}
            workspaceId={workspaceId}
            workspaceError={workspaceError}
            labels={labels}
            labelsError={labelsError}
          />
        );
      case 'labels':
        return <LabelsView apiClient={apiClient} />;
      case 'domains':
        return <DomainsView apiClient={apiClient} />;
      case 'lakehouses':
        return <LakehousesView apiClient={apiClient} />;
      case 'dashboard':
        return <DashboardView apiClient={apiClient} onNavigateTo={(v) => setActiveView(v as ViewKey)} />;
      default:
        return null;
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', fontFamily: 'var(--fontFamilyBase)' }}>
      {/* ── Header ── */}
      <div style={{
        height: 48,
        backgroundColor: '#0f6cbd',
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        padding: '0 16px',
        gap: 10,
        flexShrink: 0,
        boxShadow: '0 2px 4px rgba(0,0,0,0.15)',
      }}>
        <ShieldTask24Regular style={{ flexShrink: 0 }} />
        <span style={{ fontWeight: 600, fontSize: 16, letterSpacing: 0.2, flex: 1 }}>Governly</span>
        <button
          onClick={handleRefresh}
          title={t('Classifier_Ribbon_Refresh', 'Refresh')}
          style={{
            background: 'rgba(255,255,255,0.15)',
            border: 'none',
            borderRadius: 4,
            color: '#fff',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 10px',
            fontSize: 13,
          }}
        >
          <ArrowClockwise24Regular style={{ width: 16, height: 16 }} />
          {t('Classifier_Ribbon_Refresh', 'Refresh')}
        </button>
      </div>

      {/* ── Body (sidebar + content) ── */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* ── Sidebar ── */}
        <div style={{
          width: 220,
          backgroundColor: '#fafafa',
          borderRight: '1px solid #e0e0e0',
          display: 'flex',
          flexDirection: 'column',
          flexShrink: 0,
          paddingTop: 8,
        }}>
          {NAV_ITEMS.map(item => {
            const isActive = activeView === item.key;
            return (
              <button
                key={item.key}
                onClick={() => setActiveView(item.key)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '10px 16px',
                  background: isActive ? '#e8f0fe' : 'transparent',
                  border: 'none',
                  borderLeft: isActive ? '3px solid #0f6cbd' : '3px solid transparent',
                  color: isActive ? '#0f6cbd' : '#333',
                  fontWeight: isActive ? 600 : 400,
                  fontSize: 14,
                  cursor: 'pointer',
                  width: '100%',
                  textAlign: 'left',
                  borderRadius: '0 4px 4px 0',
                  marginBottom: 2,
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', color: isActive ? '#0f6cbd' : '#555', flexShrink: 0 }}>
                  {item.icon}
                </span>
                {t(item.labelKey, item.defaultLabel)}
              </button>
            );
          })}
        </div>

        {/* ── Content ── */}
        <div style={{ flex: 1, overflowY: 'auto', backgroundColor: '#fff' }}>
          {renderContent()}
        </div>
      </div>
    </div>
  );
};

export { ClassifierItemEditor };
export default ClassifierItemEditor;
```

- [ ] **Step 2: Verify TypeScript compiles**

```
npx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 3: Commit**

```
git add app/items/ClassifierItem/ClassifierItemEditor.tsx
git commit -m "feat: redesign ClassifierItemEditor with header + sidebar layout

- Replace ItemEditor with custom header/sidebar/content shell
- Add branded Governly header (blue, #0f6cbd) with refresh button
- Add sidebar navigation: Items, Labels, Domains, Lakehouses, Dashboard
- Register all five views (previously only Items was wired up)
- Remove green debug bar

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: Update ItemsView — admin API + current label badge

**Files:**
- Modify: `app/items/ClassifierItem/views/ItemsView.tsx`

- [ ] **Step 1: Rewrite `ItemsView.tsx`**

Replace the file contents. Key changes:
- Use `listItems` (admin API, returns sensitivity data) instead of `listWorkspaceItems`
- Paginate through all results using `continuationToken`
- Add "Current Label" column with a coloured Badge
- Keep the "Change Label" `LabelPicker` column (pre-populated)

```typescript
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
  Text,
  Badge,
  MessageBar,
  MessageBarBody,
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { FabricItem, GovernlyApiClient, SensitivityLabel } from '../../../clients/GovernlyApiClient';
import { LabelPicker } from '../components/LabelPicker';

interface ItemsViewProps {
  apiClient: GovernlyApiClient;
  workspaceId?: string;
  workspaceError?: string;
  labels: SensitivityLabel[];
  labelsError?: string;
}

interface StatusMessage {
  type: 'success' | 'error';
  text: string;
}

/** Small coloured dot + label name badge for the current label column */
const LabelBadge: React.FC<{ label: SensitivityLabel | undefined }> = ({ label }) => {
  if (!label) {
    return (
      <Badge appearance="outline" color="informative" style={{ color: '#888', borderColor: '#ccc' }}>
        None
      </Badge>
    );
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span
        style={{
          width: 10,
          height: 10,
          borderRadius: 2,
          backgroundColor: label.color || '#ccc',
          border: '1px solid rgba(0,0,0,0.15)',
          flexShrink: 0,
          display: 'inline-block',
        }}
      />
      <Badge appearance="filled" style={{
        backgroundColor: label.color || '#0078d4',
        color: '#fff',
        fontSize: 11,
      }}>
        {label.name}
      </Badge>
    </span>
  );
};

export const ItemsView: React.FC<ItemsViewProps> = ({
  apiClient,
  workspaceId,
  workspaceError,
  labels,
  labelsError,
}) => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<FabricItem[]>([]);
  const [statusMsg, setStatusMsg] = useState<StatusMessage | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!workspaceId) return;

    setLoading(true);
    setApiError(null);

    // Page through all results from the admin API (returns sensitivity label data)
    (async () => {
      try {
        const all: FabricItem[] = [];
        let continuationToken: string | undefined = undefined;
        do {
          const page = await apiClient.listItems({ workspaceId, continuationToken });
          all.push(...page.items);
          continuationToken = page.continuationToken;
        } while (continuationToken);

        if (cancelled) return;
        console.log('[Governly] listItems returned', all.length, 'items');
        setItems(all);
        setLoading(false);
      } catch (err: any) {
        if (cancelled) return;
        console.error('[Governly] listItems failed:', err);
        const msg: string = err?.message ?? (typeof err === 'object' ? JSON.stringify(err) : String(err));
        setApiError(msg);
        setItems([]);
        setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [apiClient, workspaceId]);

  const handleLabelChange = useCallback(async (item: FabricItem, labelId: string) => {
    try {
      await apiClient.bulkSetLabels([{ id: item.id, type: item.type }], labelId);
      const found = labels.find(l => l.id === labelId);
      setItems(prev =>
        prev.map(i =>
          i.id === item.id
            ? { ...i, sensitivity: { labelId, labelName: found?.name } }
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
      renderCell: (item) => <Text>{item.displayName}</Text>,
    }),
    createTableColumn<FabricItem>({
      columnId: 'type',
      renderHeaderCell: () => t('Classifier_Items_ColType', 'Type'),
      renderCell: (item) => <Text size={200} style={{ color: '#666' }}>{item.type}</Text>,
    }),
    createTableColumn<FabricItem>({
      columnId: 'currentLabel',
      renderHeaderCell: () => t('Classifier_Items_ColCurrentLabel', 'Current Label'),
      renderCell: (item) => {
        const label = labels.find(l => l.id === item.sensitivity?.labelId);
        return <LabelBadge label={label} />;
      },
    }),
    createTableColumn<FabricItem>({
      columnId: 'changeLabel',
      renderHeaderCell: () => t('Classifier_Items_ColChangeLabel', 'Change Label'),
      renderCell: (item) => (
        <LabelPicker
          labels={labels}
          value={item.sensitivity?.labelId}
          onChange={(labelId) => handleLabelChange(item, labelId)}
          placeholder={t('Classifier_Items_NoLabel', 'Select label…')}
        />
      ),
    }),
  ], [t, labels, handleLabelChange]);

  if (workspaceError) {
    return (
      <div style={{ padding: 24, background: '#fff3cd', border: '2px solid #e0a800', borderRadius: 6, margin: 16, fontFamily: 'sans-serif', fontSize: 14 }}>
        <strong style={{ color: '#856404' }}>⚠ Workspace Error</strong>
        <p style={{ margin: '8px 0 0', color: '#333' }}>{workspaceError}</p>
      </div>
    );
  }

  if (!workspaceId) {
    return (
      <div style={{ padding: 24, background: '#e8f4fd', border: '2px solid #0078d4', borderRadius: 6, margin: 16, fontFamily: 'sans-serif', fontSize: 14 }}>
        <strong style={{ color: '#0078d4' }}>⏳ Connecting to workspace…</strong>
        <p style={{ margin: '8px 0 0', color: '#333' }}>If this doesn't change after a few seconds, restart the Dev Gateway.</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ padding: 24, background: '#e8f4fd', border: '2px solid #0078d4', borderRadius: 6, margin: 16, fontFamily: 'sans-serif', fontSize: 14 }}>
        <strong style={{ color: '#0078d4' }}>⏳ Loading workspace items…</strong>
      </div>
    );
  }

  if (apiError) {
    return (
      <div style={{ margin: 16, fontFamily: 'sans-serif', fontSize: 14 }}>
        <div style={{ padding: 16, background: '#fde7e9', border: '2px solid #d13438', borderRadius: 6, color: '#333' }}>
          <strong style={{ color: '#d13438' }}>⚠ Failed to load workspace items</strong>
          <p style={{ margin: '8px 0 0', fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap' }}>{apiError}</p>
        </div>
        <div style={{ marginTop: 12, padding: 16, background: '#fef8e7', border: '1px solid #e0c060', borderRadius: 6, lineHeight: 1.8 }}>
          <strong>Troubleshooting:</strong>
          <ol style={{ margin: '8px 0 0 18px', padding: 0 }}>
            <li>Make sure you are logged in to Azure CLI: <code>az login</code></li>
            <li>Make sure the Dev Gateway is running and the workload is registered</li>
            <li>Check the devServer console for detailed proxy logs</li>
          </ol>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      {labelsError && (
        <div style={{ marginBottom: 12, padding: 10, background: '#fff3cd', border: '1px solid #e0a800', borderRadius: 4, fontFamily: 'sans-serif', fontSize: 13, color: '#333' }}>
          <strong style={{ color: '#856404' }}>⚠ Could not load sensitivity labels: </strong>
          <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{labelsError}</span>
        </div>
      )}
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

- [ ] **Step 2: Verify TypeScript compiles**

```
npx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 3: Commit**

```
git add app/items/ClassifierItem/views/ItemsView.tsx
git commit -m "feat: show current sensitivity label in Items view

- Switch data source from listWorkspaceItems to admin listItems API
  (admin API returns sensitivity.labelId/labelName per item)
- Paginate through all results with continuationToken loop
- Add LabelBadge component: coloured dot + filled badge showing label name
- Add 'Current Label' column (badge) alongside 'Change Label' (LabelPicker)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Self-Review

**Spec coverage:**
- ✅ Remove debug bars (Task 1)
- ✅ Branded header with Governly name + icon (Task 2)
- ✅ Sidebar navigation with icons: Items, Labels, Domains, Lakehouses, Dashboard (Task 2)
- ✅ All five views registered and rendered (Task 2)
- ✅ Content area scrollable (Task 2 — `overflowY: auto`)
- ✅ Admin API for items with sensitivity data (Task 3)
- ✅ Current label shown as coloured badge (Task 3 — `LabelBadge`)
- ✅ Inline `LabelPicker` to change label (Task 3)
- ✅ TypeScript check after each task

**No placeholders found.**

**Type consistency:**
- `FabricItem.sensitivity` is `{ labelId: string; labelName?: string } | undefined` — used correctly in `LabelBadge` and `handleLabelChange`
- `listItems` returns `FabricItemsPage` with `items: FabricItem[]` and `continuationToken?: string` — loop uses both correctly
- `ViewKey` union type matches all five `NAV_ITEMS` keys and the `switch` cases
