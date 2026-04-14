# Governly Implementation Plan

## Problem
Build a Microsoft Fabric Workload ("Governly") that lets Fabric Administrators bulk-apply
Microsoft Purview sensitivity labels across Fabric Domains, Fabric Items, and Lakehouse
Tables & Columns — all from within the Fabric portal, with no backend service.

## Approach
Fork the official Microsoft Extensibility Toolkit Starter-Kit as the code base.
The workload runs as a pure `FERemote` React SPA embedded in Fabric's sandboxed iframe.
Auth is delegated via `workloadClient.auth.acquireAccessToken()` — no secrets at runtime.
Tokens are acquired scoped to the Fabric Admin API and Microsoft Graph separately.
Tenant ID is discovered from the JWT `tid` claim at runtime.

### Workload identity
- Workload name:  `Org.Governly`
- Item type:      `Classifier`  (full: `Org.Governly.Classifier`)
- Display name:   "Governly – Data Classifier"
- Route pattern:  `/ClassifierItem-editor/:itemObjectId`

---

## File Map

```
src/
  index.ts                          # bootstrap({ initializeWorker, initializeUI })
  index.ui.tsx                      # createWorkloadClient + FluentProvider + Router
  index.worker.ts                   # item lifecycle handlers
  App.tsx                           # React Router v5 Switch/Route
  models/
    SensitivityLabel.ts             # { id, name, color, description, isEndpointProtectionEnabled }
    FabricItem.ts                   # { id, displayName, type, workspaceId, labelId? }
    FabricDomain.ts                 # { id, displayName, defaultLabelId? }
    LakehouseTable.ts               # { name, lakehouseId, workspaceId, columnCount }
    ClassifierDefinition.ts         # item payload { savedLabelId?, savedFilters }
    BulkOperation.ts                # { itemIds[], labelId, operationType }
  clients/
    GovernlyAdminClient.ts          # Fabric Admin REST: items, domains, bulkSetLabels
    GovernlyGraphClient.ts          # Graph beta: sensitivityLabels
    GovernlyLakehouseClient.ts      # Fabric REST: lakehouse tables
  hooks/
    useLabels.ts                    # fetch + cache sensitivity labels from Graph
    useDomains.ts                   # fetch + manage Fabric domains
    useFabricItems.ts               # fetch items (paginated, filterable)
    useBulkOperation.ts             # orchestrate bulkSetLabels with rate-limit guard
  components/
    LabelPicker.tsx                 # Dropdown of sensitivity labels (colored badge)
    ItemScopeSelector.tsx           # Checkboxes: Domains | Items | Lakehouse Tables
    BulkProgressBar.tsx             # Progress indicator during apply
    FilterPanel.tsx                 # WorkspaceId + ItemType filters
    DomainCard.tsx                  # Expandable domain row with current/new label
    ItemsTable.tsx                  # Selectable table of Fabric items with labels
    LakehouseTableList.tsx          # Tables within a selected Lakehouse
  items/
    ClassifierItem/
      ClassifierItemEditor.tsx      # ItemEditor + ribbon + left/center panel views
      ClassifierItemDefinition.ts   # TypeScript interface for item payload
  workload.xml                      # <WorkloadManifest> item type registration
  Product.json                      # Display name, description, icon, category
  localWorkloadManifest.xml         # Dev overrides (FERemote URL = localhost:60006)
```

---

## Tasks

### Task 1 — bootstrap
Copy Starter-Kit files into the worktree (`src/`, `webpack.config.js`, `tsconfig.json`,
`package.json`, `.env.example`). Run `npm install`. Confirm dev server starts on port 60006.
Delete or stub the HelloWorld item files — replace with Classifier skeleton.

**Acceptance:** `npm start` runs without errors. Browser shows Fluent UI shell.

---

### Task 2 — manifest
Configure `workload.xml` and `Product.json`:
- WorkloadName = `Org.Governly`
- ItemType TypeName = `Org.Governly.Classifier`
- Display name = "Governly – Data Classifier"
- Description = "Bulk-apply Microsoft Purview sensitivity labels across Fabric"
- Icon = governance shield SVG (inline base64 or asset reference)
- `localWorkloadManifest.xml` → FERemote URL = `http://localhost:60006`

**Acceptance:** Manifest validates against the Starter-Kit schema. No XML errors.

---

### Task 3 — models
Create all TypeScript interfaces under `src/models/`:
- `SensitivityLabel.ts`
- `FabricItem.ts`
- `FabricDomain.ts`
- `LakehouseTable.ts`
- `ClassifierDefinition.ts`  ← the item payload
- `BulkOperation.ts`

All types must be `readonly` where appropriate. No `any`.

**Acceptance:** `tsc --noEmit` passes with zero errors.

---

### Task 4 — test-infra
Add `jest.config.js`, `src/setupTests.ts`, `@testing-library/react` and
`@testing-library/jest-dom` to `package.json`. Configure `msw` for API mocking.
Write one smoke test: renders `<LabelPicker labels={[]} />` without crashing.

**Acceptance:** `npm test` runs and the smoke test passes.

---

### Task 5 — admin-client
`src/clients/GovernlyAdminClient.ts` — class with:
- `constructor(getToken: () => Promise<string>)`
- `getItems(filters?: { workspaceId?, type? }): AsyncGenerator<FabricItem[]>`  (handles pagination)
- `getDomains(): Promise<FabricDomain[]>`
- `setDomainLabel(domainId: string, labelId: string): Promise<void>`
- `bulkSetLabels(itemIds: string[], labelId: string): Promise<BulkOperationResult>`
- `bulkRemoveLabels(itemIds: string[]): Promise<BulkOperationResult>`
- Rate-limiter: max 25 bulkSet/Remove calls per hour (sliding window, throws `RateLimitError`)
- Chunk size: 2,000 items per request

Base URL: `https://api.fabric.microsoft.com/v1`
Token scope: `https://analysis.windows.net/powerbi/api/.default`

**Acceptance:** Unit tests with MSW mock all five methods. Rate-limiter test verifies 26th call throws.

---

### Task 6 — graph-client
`src/clients/GovernlyGraphClient.ts` — class with:
- `constructor(getToken: () => Promise<string>)`
- `getSensitivityLabels(): Promise<SensitivityLabel[]>`

Endpoint: `GET https://graph.microsoft.com/beta/security/informationProtection/sensitivityLabels`
Token scope: `https://graph.microsoft.com/.default`
Maps raw Graph response to `SensitivityLabel` model.

**Acceptance:** Unit test with MSW mock returns mapped labels array.

---

### Task 7 — lakehouse-client
`src/clients/GovernlyLakehouseClient.ts` — class with:
- `constructor(getToken: () => Promise<string>)`
- `getTables(workspaceId: string, lakehouseId: string): Promise<LakehouseTable[]>`

Endpoint: `GET /v1/workspaces/{wsId}/lakehouses/{lhId}/tables` (paginated)
Token scope: `https://analysis.windows.net/powerbi/api/.default`

**Acceptance:** Unit test with MSW mock returns paginated table list.

---

### Task 8 — use-labels hook
`src/hooks/useLabels.ts`:
- Calls `GovernlyGraphClient.getSensitivityLabels()`
- Token acquired via `workloadClient.auth.acquireAccessToken({ scopes: ['https://graph.microsoft.com/.default'] })`
- Returns `{ labels, isLoading, error }`
- Caches result in module-level variable for the session (labels rarely change)

**Acceptance:** Unit test verifies loading/loaded/error states.

---

### Task 9 — use-domains hook
`src/hooks/useDomains.ts`:
- Calls `GovernlyAdminClient.getDomains()`
- Token: `https://analysis.windows.net/powerbi/api/.default`
- Returns `{ domains, isLoading, error, setDomainLabel }`

**Acceptance:** Unit test verifies domain list fetch and optimistic label update.

---

### Task 10 — use-items hook
`src/hooks/useFabricItems.ts`:
- Wraps `GovernlyAdminClient.getItems()` async generator
- Supports `workspaceId` and `type` filter params
- Returns `{ items, isLoading, hasMore, loadMore, error }`

**Acceptance:** Unit test verifies paginated loading and filter changes reset pagination.

---

### Task 11 — use-bulk hook
`src/hooks/useBulkOperation.ts`:
- Accepts `{ selectedItemIds: string[], labelId: string, operation: 'set' | 'remove' }`
- Calls `GovernlyAdminClient.bulkSetLabels` or `bulkRemoveLabels` in chunks
- Returns `{ run, progress, isRunning, result, error }`
- `progress` = `{ processed: number, total: number, percent: number }`
- Surfaces `RateLimitError` as user-readable message

**Acceptance:** Unit test verifies progress increments and error surface.

---

### Task 12 — components
Build all shared UI components in `src/components/` using `@fluentui/react-components` v9:

- **`LabelPicker`** — `Dropdown` with colored `Badge` for each label. Props: `labels`, `value`, `onChange`.
- **`ItemScopeSelector`** — `CheckboxGroup` for Domains / Items / Lakehouse Tables scope selection.
- **`BulkProgressBar`** — `ProgressBar` + percentage text. Shows during apply operation.
- **`FilterPanel`** — `Input` (workspace ID) + `Dropdown` (item type). Calls `onFilterChange`.
- **`DomainCard`** — `AccordionItem` showing domain name, current label badge, `LabelPicker` for new label.
- **`ItemsTable`** — `DataGrid` (Fluent v9) with checkbox column, name, type, workspace, current label.
- **`LakehouseTableList`** — Flat `List` of tables within a selected Lakehouse.

All components must be wrapped in `React.memo`. No inline styles — use `makeStyles` from `@fluentui/react-components`.

**Acceptance:** Each component has a render test. Storybook-style snapshot or DOM assertion.

---

### Task 13 — views
Build the three main views that compose into the `ClassifierItemEditor`:

**`DomainsView`** — Left panel: domain list with `DomainCard`s. Center: selected domain's items.
**`ItemsView`** — Left panel: `FilterPanel`. Center: `ItemsTable` with multi-select + `LabelPicker` at top.
**`LakehouseView`** — Left panel: Lakehouse selector. Center: `LakehouseTableList` with label column.

Each view accepts `workloadClient` prop and manages its own data via hooks.

**Acceptance:** Integration test renders each view with MSW mocks and verifies correct data display.

---

### Task 14 — editor
`src/items/ClassifierItem/ClassifierItemEditor.tsx`:
- Uses `ItemEditor` from Starter-Kit with `views` array: `[DomainsView, ItemsView, LakehouseView]`
- Ribbon: `homeToolbarActions` with `createSaveAction()` + custom "Apply Labels" `ToolbarButton` (wrapped in `Tooltip`)
- `messageBar` state: shows success/error after bulk operation
- `ItemEditorEmptyView` shown when no label selected
- `ItemEditorDefaultView` with left/center panels for main state
- Persists `savedLabelId` + `savedFilters` to item payload via `workloadClient.items.save()`

**Acceptance:** Renders without errors. Ribbon actions fire correct callbacks.

---

### Task 15 — readme
Update `README.md` with:
1. What Governly is
2. Prerequisites (Fabric capacity, Fabric Administrator role, app registration)
3. Step-by-step deploy guide: run `scripts/CreateGovernlyApp.ps1` → upload manifest → create Classifier item
4. Development setup: `npm install` → `npm start` → DevGateway → local Fabric workspace
5. Architecture overview diagram (ASCII)
6. API permissions table

**Acceptance:** README renders correctly in GitHub. All links resolve.

---

## Notes

- React Router is **v5** in the Starter-Kit (`<Switch>/<Route>`, not `<Routes>/<Route>`)
- Use `@fluentui/react-components` v9 only — NOT `@fluentui/react` v8 or `@fabric-msft/fabric-react`
- `ToolbarButton` MUST always be wrapped in `Tooltip` per toolkit conventions
- NEVER implement scrolling inside item views — `ItemEditor` handles overflow
- Ribbon MUST include `homeToolbarActions` (mandatory per toolkit)
- `workloadClient.auth.acquireAccessToken()` is the ONLY auth mechanism — no client secrets at runtime
- Tenant ID from JWT `tid` claim — no .env TENANTID needed
