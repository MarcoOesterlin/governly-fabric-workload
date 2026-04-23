export type DqDimension =
  | 'completeness'
  | 'uniqueness'
  | 'validity'
  | 'consistency'
  | 'timeliness'
  | 'accuracy';

export const DQ_DIMENSION_LABELS: Record<DqDimension, string> = {
  completeness: 'Completeness',
  uniqueness:   'Uniqueness',
  validity:     'Validity',
  consistency:  'Consistency',
  timeliness:   'Timeliness',
  accuracy:     'Accuracy',
};

export const DQ_DIMENSION_DESCRIPTIONS: Record<DqDimension, string> = {
  completeness: 'Non-null / non-empty rate per column (threshold >= 95%)',
  uniqueness:   'Distinct-value rate per column (threshold >= 95%)',
  validity:     'Type-cast / format success rate (threshold >= 98%)',
  consistency:  'Cross-column order rules, e.g. start <= end (auto-detected)',
  timeliness:   'Date/timestamp freshness — max(col) within 7 days of now',
  accuracy:     'Reference-list match (requires reference table — coming soon)',
};

export const DQ_ACTIVE_DIMENSIONS: DqDimension[] = [
  'completeness',
  'uniqueness',
  'validity',
  'consistency',
  'timeliness',
];

export interface TableColumn {
  name: string;
  dataType: string;
}

export interface DqTableSelection {
  tableName: string;
  columns: string[];
}

export const DQ_DEFAULT_THRESHOLDS: Record<DqDimension, number> = {
  completeness: 95,
  uniqueness:   95,
  validity:     98,
  consistency:  100,
  timeliness:   100,
  accuracy:     95,
};

export interface DqRunConfig {
  runId: string;
  workspaceId: string;
  lakehouseId: string;
  lakehouseName: string;
  tables: DqTableSelection[];
  dimensions: DqDimension[];
  thresholds: Record<DqDimension, number>;
}

export interface DqResultRow {
  run_id: string;
  table_name: string;
  column_name: string;
  dimension: DqDimension;
  metric_name: string;
  metric_value: number;   // 0–100 percentage
  threshold: number;      // 0–100 percentage
  passed: boolean;
  run_timestamp: string;
  total_rows: number;     // rows evaluated for this check
}

export interface DqFailedRow {
  run_id: string;
  table_name: string;
  column_name: string;
  dimension: DqDimension;
  rule_id: string;
  row_hash: string;
  raw_values: string;
  failure_reason: string; // human-readable explanation
}

export interface DqRunSummary {
  run_id: string;
  run_timestamp: string;
  lakehouse_id: string;
  source_lakehouse_id?: string;
  source_lakehouse_name?: string;
  results: DqResultRow[];
}

export interface DqRunMeta {
  run_id: string;        // HHMMSS string e.g. "212045"
  run_timestamp: string;
  lakehouse_id: string;
  source_lakehouse_id?: string;
  source_lakehouse_name?: string;
  year: string;
  month: string;
  day: string;
}

// ── Theme system ──────────────────────────────────────────────────────────────

export interface DqTheme {
  bg:      string;
  surface: string;
  border:  string;
  accent:  string;
  pass:    string;
  fail:    string;
  warn:    string;
  text:    string;
  subtext: string;
  muted:   string;
}

export const DARK_THEME: DqTheme = {
  bg:      '#0e1015',
  surface: '#181d2e',
  border:  '#252d45',
  accent:  '#00b4e6',
  pass:    '#00cc72',
  fail:    '#f5405a',
  warn:    '#f5a623',
  text:    '#f2f2f2',
  subtext: '#c9d1d9',
  muted:   '#3a4464',
};

export const LIGHT_THEME: DqTheme = {
  bg:      '#f1f5f9',
  surface: '#ffffff',
  border:  '#e2e8f0',
  accent:  '#2563eb',
  pass:    '#16a34a',
  fail:    '#dc2626',
  warn:    '#d97706',
  text:    '#1e293b',
  subtext: '#64748b',
  muted:   '#94a3b8',
};

export interface DqPreloadResult {
  runs: DqRunMeta[];
  summaries: Record<string, DqRunSummary>;
  latestFailedRows?: { rows: DqFailedRow[]; total: number } | null;
}
