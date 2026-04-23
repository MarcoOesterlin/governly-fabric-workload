# DQ Dashboard Redesign

**Date:** 2026-04-23  
**Status:** Approved — implementing

## Problem

The DQ dashboard has four usability and performance issues:
1. **Slow load** — N+1 API calls (listDqRuns + one getDqRunSummary per run for trend data)
2. **No dark mode** — only a light theme; no way to toggle
3. **Emojis** — used for tabs and status indicators; looks unprofessional
4. **Weak visual design** — cards lack hierarchy, charts use default colour scheme

## Solution

### 1. Backend preload endpoint
`GET /api/dq-preload?workspaceId=` — finds DQ lakehouse, lists all runs, reads all `summary.json` files **in parallel** server-side, returns `{ runs, summaries }` in one response. In-memory cache with 5-minute TTL per workspace. Cache invalidated on `POST /api/dq-notebook`.

### 2. Dark/Light mode toggle
- **Dark** is the default (Vizro-inspired dark navy)
- Pill toggle in the tab bar right edge: "● Dark" / "○ Light"
- `darkMode: boolean` state lives in `DataQualityView`, persisted via `localStorage`
- Passed as prop to all three tabs

### 3. Design tokens (DqTheme)

| Token | Dark | Light |
|---|---|---|
| bg | `#13192b` | `#f1f5f9` |
| surface | `#1e2540` | `#ffffff` |
| border | `#2d3561` | `#e2e8f0` |
| accent | `#0ea5e9` | `#2563eb` |
| pass | `#10b981` | `#16a34a` |
| fail | `#f87171` | `#dc2626` |
| warn | `#f59e0b` | `#d97706` |
| text | `#f1f5f9` | `#1e293b` |
| subtext | `#94a3b8` | `#64748b` |
| muted | `#475569` | `#94a3b8` |

### 4. Visual changes
- KPI cards: left accent border (Vizro signature)
- Dimension bar chart: horizontal bars (cleaner than column)
- Trend chart: area chart with gradient fill
- All ApexCharts: theme-aware (dark/light mode switch)
- All emojis removed from tabs, status messages, error states

## Files changed
- `devServer/dqRoutes.js` — preload endpoint + cache
- `app/items/GovernlyItem/views/dataQuality/dqTypes.ts` — theme types
- `app/clients/GovernlyApiClient.ts` — `preloadDqDashboard()`
- `app/items/GovernlyItem/views/DataQualityView.tsx` — toggle + props
- `app/items/GovernlyItem/views/dataQuality/DashboardTab.tsx` — full redesign
- `app/items/GovernlyItem/views/dataQuality/FailedRowsTab.tsx` — theme
- `app/items/GovernlyItem/views/dataQuality/ConfigureRunTab.tsx` — theme
