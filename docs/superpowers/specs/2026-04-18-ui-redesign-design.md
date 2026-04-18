# Governly UI Redesign — Design Spec

**Date:** 2026-04-18  
**Status:** Approved

---

## Problem Statement

The current UI uses a horizontal tab bar for navigation and lacks polish. The Items view
does not show which sensitivity label is already applied to each workspace item, and the
layout does not match the look and feel of Microsoft Fabric's native UI. Three debug bars
are still visible to the user.

---

## Goals

1. Replace horizontal tabs with a sidebar navigation (Fluent UI style, matching Fabric).
2. Add a branded header bar showing the Governly name.
3. Show the currently-applied sensitivity label as a coloured badge on each item row.
4. Fix the data source for the Items view so it returns sensitivity label data.
5. Remove all debug bars.

---

## Out of Scope

- Bulk / multi-select label assignment (inline per-row picker is sufficient for now).
- Redesigning the content inside Labels, Domains, Lakehouses, or Dashboard views.
- Dark mode.
- Responsive / mobile layout.

---

## Architecture

### Shell layout (`ClassifierItemEditor.tsx`)

Replace the current `TabList` with a three-zone layout:

```
┌─────────────────────────────────────────────────┐
│  HEADER (48px)  — Governly logo + name           │
├──────────────┬──────────────────────────────────┤
│  SIDEBAR     │  CONTENT AREA                    │
│  (220px)     │  (flex: 1, overflow-y: auto)     │
│              │                                  │
│  • Items     │  <ActiveView />                  │
│  • Labels    │                                  │
│  • Domains   │                                  │
│  • Lakehouses│                                  │
│  • Dashboard │                                  │
└──────────────┴──────────────────────────────────┘
```

**Header**: `colorBrandBackground` background, white "Governly" text, a governance shield
icon (Fluent `ShieldTask24Regular` or similar). Fixed height 48px.

**Sidebar**: White/neutral background, Fluent `Nav`-style list. Each nav item has:
- A Fluent icon (see table below)
- A label string
- Active state highlighted with `colorBrandBackground` left border + `colorBrandForeground` text

| Section    | Icon                        |
|------------|-----------------------------|
| Items      | `DatabaseMultiple24Regular` |
| Labels     | `Tag24Regular`              |
| Domains    | `BuildingMultiple24Regular` |
| Lakehouses | `TableMultiple24Regular`    |
| Dashboard  | `DataPie24Regular`          |

**Content area**: Scrollable, 16px padding. No section title bar needed (sidebar makes context clear).

**State**: Active section stored as a `useState<string>` in `ClassifierItemEditor.tsx`. Default: `'items'`.

### Debug bars removed

Remove the following:
- Black debug bar in `app/index.ui.tsx`
- Blue debug bar in `app/App.tsx`
- Green debug bar in `app/items/ClassifierItem/ClassifierItemEditor.tsx`

---

## Items View (`ItemsView.tsx`)

### Data source change

`listWorkspaceItems` calls `/workspaces/{id}/items` which does **not** return sensitivity
label data. Switch to the existing `listItems` admin API method which calls
`/admin/items?workspaceId={id}` and returns `sensitivity: { labelId, labelName }`.

The `listItems` method paginates with a `continuationToken`. The view should page through
all results automatically (same pattern as the current `listWorkspaceItems` loop).

### Columns

| Column | Content |
|--------|---------|
| Name | `item.displayName` |
| Type | `item.type` (plain text) |
| Current Label | Coloured `Badge` showing `labelName`; colour swatch from `labelId → SensitivityLabel.color`; shows "None" (grey) if no label |
| Change Label | `LabelPicker` combobox pre-populated with current `labelId`; on select calls `bulkSetLabels` and updates the badge inline |

The "Current Label" badge and "Change Label" picker can be in the same column or
adjacent columns — implementation detail. The badge serves as visual confirmation;
the picker is the action control.

### Error & loading states

Keep existing error/loading UI — just update the container styling to match the new shell.

---

## Implementation Notes

- The new layout lives entirely in `ClassifierItemEditor.tsx` (shell) and `ItemsView.tsx` (data change).
- All other view files (`LabelsView`, `DomainsView`, `LakehousesView`, `DashboardView`) are unchanged.
- The `GovernlyApiClient` needs no new methods — `listItems` already exists and returns sensitivity data.
- `LabelPicker` component is reused as-is.
- Use Fluent UI tokens (`colorBrandBackground`, `colorNeutralBackground1`, etc.) for all new styling — no hardcoded colours.

---

## Files Changed

| File | Change |
|------|--------|
| `app/items/ClassifierItem/ClassifierItemEditor.tsx` | Full rewrite: sidebar + header shell, remove debug bar |
| `app/items/ClassifierItem/views/ItemsView.tsx` | Switch to admin API, add Current Label badge column |
| `app/index.ui.tsx` | Remove debug bar |
| `app/App.tsx` | Remove debug bar |

---

## Acceptance Criteria

1. App renders with a branded header and left sidebar navigation.
2. Clicking each sidebar item loads the correct view.
3. Items view shows items fetched from the admin API with their current sensitivity label as a coloured badge.
4. Changing a label via the inline dropdown updates the badge immediately without a page reload.
5. No debug bars visible anywhere in the UI.
6. TypeScript compilation passes with no new errors.
