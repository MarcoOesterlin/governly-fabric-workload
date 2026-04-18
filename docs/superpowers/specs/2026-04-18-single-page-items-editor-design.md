# Single-Page Items Editor

## Problem

The Classifier item editor currently has five tabs (Dashboard, Items, Domains, Lakehouses, Labels). This fragments the core workflow — viewing items and managing their sensitivity labels. Users must navigate between tabs to accomplish a single task.

## Proposed Approach

Replace the tabbed layout with a single flat page. The page shows all workspace items in a DataGrid with an inline sensitivity-label picker per row. No filters, no bulk actions, no dashboard — just items and their labels.

## Architecture

### Page layout

```
┌─────────────────────────────────────────────┐
│  Ribbon  [ Refresh ]                        │
├─────────────────────────────────────────────┤
│  Name       │ Type     │ Workspace │ Label  │
│─────────────┼──────────┼───────────┼────────│
│  Report Q3  │ Report   │ Finance   │ [▾ ██] │
│  Dataset A  │ Dataset  │ Sales     │ [▾ ██] │
│  …          │ …        │ …         │ [▾ ██] │
└─────────────────────────────────────────────┘
  ↑ MessageBar (success/error, auto-dismiss)
```

### Columns

| Column | Content |
|---|---|
| Name | `item.displayName` |
| Type | `item.type` |
| Workspace | `item.workspaceName \|\| item.workspaceId` |
| Sensitivity Label | Inline `LabelPicker` Combobox showing current label; selecting a new value triggers `apiClient.bulkSetLabels` for that single item |

### Data flow

1. On mount, fetch items (`listItems`) and labels (`listSensitivityLabels`) in parallel.
2. Render items in a DataGrid (no selection mode).
3. Each row's Label column renders a `LabelPicker` with the item's current `sensitivity.labelId`.
4. When a user picks a label, call `apiClient.bulkSetLabels([{ id, type }], labelId)`.
5. On success, update the item's label in local state and show a success `MessageBar` (auto-dismiss after 3 seconds).
6. On failure, show an error `MessageBar`.
7. Refresh button re-fetches all data.

### Components

- **ClassifierItemEditor** — simplified orchestrator. No tabs, no bulk state, no dialogs. Renders `ItemEditor` shell with a single view.
- **ClassifierRibbon** — Refresh action only.
- **ItemsView** — the DataGrid. Accepts `labels` as a prop (fetched once by the parent) and renders an inline `LabelPicker` per row.
- **LabelPicker** — existing component, reused as-is.

### What gets removed

- `DashboardView` — no longer rendered
- `DomainsView` — removed as a tab
- `LakehousesView` — removed as a tab
- `LabelsView` — removed as a tab
- `BulkActionBar` — no bulk selection
- `BatchProgressDialog` — no bulk operations
- `ConfirmationDialog` usage for apply/remove bulk — no longer needed
- Tab navigation in the ribbon — single view, no tabs
- Multi-select on the DataGrid — per-item only

Files for removed views and bulk components remain on disk (not deleted) in case they are needed later, but they are no longer imported or rendered.

### What stays unchanged

- `GovernlyApiClient` — all API methods remain
- `LabelPicker` component — reused inline in each row
- `ItemEditor` shell — still wraps the view
- `Ribbon` component — still renders the toolbar
- Route definitions in `App.tsx` — unchanged

## Error handling

- API errors during label assignment show a `MessageBar` with intent `error`.
- API errors during initial data load show an inline error message in place of the DataGrid.
- Each label change is independent; a failure on one row does not affect others.

## Testing

- Manual verification: open the Classifier item → see flat items list → pick a label → confirm it applies.
- Verify Refresh re-fetches data.
- Verify error state when API call fails.
