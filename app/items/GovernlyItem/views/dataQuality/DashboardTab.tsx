import React, { useEffect, useMemo, useState } from 'react';
import ReactApexChart from 'react-apexcharts';
import { ApexOptions } from 'apexcharts';
import { GovernlyApiClient } from '../../../../clients/GovernlyApiClient';
import { DqRunMeta, DqRunSummary, DqResultRow, DQ_DIMENSION_LABELS, DqDimension, DARK_THEME, LIGHT_THEME } from './dqTypes';

interface Props {
  apiClient: GovernlyApiClient;
  workspaceId: string;
  darkMode: boolean;
}

interface TrendPoint {
  meta: DqRunMeta;
  passRate: number;
  label: string;
}

export const DashboardTab: React.FC<Props> = ({ apiClient, workspaceId, darkMode }) => {
  const t = darkMode ? DARK_THEME : LIGHT_THEME;

  const [runs, setRuns]               = useState<DqRunMeta[]>([]);
  const [summaryMap, setSummaryMap]   = useState<Record<string, DqRunSummary>>({});
  const [selectedRun, setSelectedRun] = useState<string>('');
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState<string | null>(null);

  // Single preload call — replaces N+1 API calls
  useEffect(() => {
    setLoading(true);
    apiClient.preloadDqDashboard(workspaceId)
      .then(({ runs: r, summaries }) => {
        setRuns(r);
        setSummaryMap(summaries);
        if (r.length > 0) setSelectedRun(r[0].run_id);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [apiClient, workspaceId]);

  const summary: DqRunSummary | null = summaryMap[selectedRun] ?? null;
  const results: DqResultRow[] = summary?.results ?? [];

  const trendData: TrendPoint[] = useMemo(() => {
    return [...runs].reverse().map(meta => ({
      meta,
      passRate: (() => {
        const s = summaryMap[meta.run_id];
        if (!s || s.results.length === 0) return 0;
        return Math.round(s.results.filter(r => r.passed).length / s.results.length * 100);
      })(),
      label: `${meta.year}-${meta.month}-${meta.day} ${meta.run_id.slice(0,2)}:${meta.run_id.slice(2,4)}`,
    }));
  }, [runs, summaryMap]);

  // ── Derived metrics ──────────────────────────────────────────────────────────
  const overallPassRate = useMemo(() => {
    if (!results.length) return null;
    return results.filter(r => r.passed).length / results.length;
  }, [results]);

  const byDimension = useMemo(() => {
    const map: Record<string, { pass: number; total: number }> = {};
    for (const r of results) {
      if (!map[r.dimension]) map[r.dimension] = { pass: 0, total: 0 };
      map[r.dimension].total++;
      if (r.passed) map[r.dimension].pass++;
    }
    return map;
  }, [results]);

  const heatmapData = useMemo(() => {
    const tables = [...new Set(results.map(r => r.table_name))];
    const dims   = [...new Set(results.map(r => r.dimension))] as DqDimension[];
    return dims.map(dim => ({
      name: DQ_DIMENSION_LABELS[dim] ?? dim,
      data: tables.map(tbl => {
        const row = results.find(r => r.table_name === tbl && r.dimension === dim);
        return { x: tbl, y: row ? Math.round(row.metric_value) : null };
      }),
    }));
  }, [results]);

  // ── Shared chart config ───────────────────────────────────────────────────────
  const chartTheme = {
    background: 'transparent',
    foreColor: t.subtext,
    fontFamily: 'inherit',
    toolbar: { show: false },
  };

  const dimKeys = Object.keys(byDimension);
  const dimRates = dimKeys.map(d => Math.round((byDimension[d].pass / byDimension[d].total) * 100));

  const barOptions: ApexOptions = {
    chart: { ...chartTheme, type: 'bar' },
    theme: { mode: darkMode ? 'dark' : 'light' },
    plotOptions: { bar: { borderRadius: 4, horizontal: true, barHeight: '60%' } },
    colors: dimRates.map(r => r >= 95 ? t.pass : r >= 80 ? t.warn : t.fail),
    xaxis: { categories: dimKeys.map(d => DQ_DIMENSION_LABELS[d as DqDimension] ?? d), min: 0, max: 100, labels: { formatter: (v: number) => `${v}%`, style: { colors: t.subtext } } },
    yaxis: { labels: { style: { colors: t.subtext } } },
    tooltip: { y: { formatter: (v: number) => `${v}%` }, theme: darkMode ? 'dark' : 'light' },
    dataLabels: { enabled: true, formatter: (v: number) => `${v}%`, style: { fontSize: '11px' } },
    grid: { borderColor: t.border },
  };

  const barSeries = [{ name: 'Pass Rate', data: dimRates }];

  const gaugePassRate = overallPassRate ?? 0;
  const gaugeColor = gaugePassRate >= 0.95 ? t.pass : gaugePassRate >= 0.80 ? t.warn : t.fail;

  const gaugeOptions: ApexOptions = {
    chart: { ...chartTheme, type: 'radialBar' },
    theme: { mode: darkMode ? 'dark' : 'light' },
    plotOptions: { radialBar: { hollow: { size: '55%' }, dataLabels: {
      name: { show: true, offsetY: -10, color: t.subtext, fontSize: '13px' },
      value: { fontSize: '28px', fontWeight: 700, color: gaugeColor, formatter: (v: number) => `${v}%` },
    }}},
    colors: [gaugeColor],
    labels: ['Overall Pass Rate'],
  };

  const trendOptions: ApexOptions = {
    chart: {
      ...chartTheme,
      type: 'area',
      events: {
        dataPointSelection: (_e: any, _ctx: any, cfg: any) => {
          const pt = trendData[cfg.dataPointIndex];
          if (pt) setSelectedRun(pt.meta.run_id);
        },
      },
    },
    theme: { mode: darkMode ? 'dark' : 'light' },
    stroke: { curve: 'smooth', width: 2 },
    fill: { type: 'gradient', gradient: { shadeIntensity: 1, opacityFrom: 0.4, opacityTo: 0.05 } },
    markers: {
      size: trendData.map(pt => pt.meta.run_id === selectedRun ? 8 : 4),
      colors: trendData.map(pt => pt.meta.run_id === selectedRun ? t.accent : t.surface),
      strokeColors: t.accent,
      strokeWidth: 2,
    },
    colors: [t.accent],
    xaxis: { categories: trendData.map(d => d.label), labels: { rotate: -30, style: { fontSize: '10px', colors: t.subtext } } },
    yaxis: { min: 0, max: 100, labels: { formatter: (v: number) => `${v}%`, style: { colors: t.subtext } } },
    tooltip: { y: { formatter: (v: number) => `${v}%` }, theme: darkMode ? 'dark' : 'light' },
    grid: { borderColor: t.border },
  };

  const trendSeries = [{ name: 'Overall Pass Rate', data: trendData.map(d => d.passRate) }];

  const heatOptions: ApexOptions = {
    chart: { ...chartTheme, type: 'heatmap' },
    theme: { mode: darkMode ? 'dark' : 'light' },
    dataLabels: { enabled: true, style: { fontSize: '11px' }, formatter: (v: number) => v != null ? `${v}%` : 'N/A' },
    plotOptions: { heatmap: { shadeIntensity: 0.5, colorScale: { ranges: [
      { from: 0,  to: 79,  color: t.fail, name: 'Poor' },
      { from: 80, to: 94,  color: t.warn, name: 'Moderate' },
      { from: 95, to: 100, color: t.pass, name: 'Good' },
    ]}}},
    xaxis: { type: 'category', labels: { style: { colors: t.subtext } } },
    yaxis: { labels: { style: { colors: t.subtext } } },
    grid: { borderColor: t.border },
    tooltip: { y: { formatter: (v: number) => v != null ? `${v}%` : 'N/A' }, theme: darkMode ? 'dark' : 'light' },
  };

  // ── Score cards ───────────────────────────────────────────────────────────────
  const totalRules    = results.length;
  const passedRules   = results.filter(r => r.passed).length;
  const failedRules   = totalRules - passedRules;
  const tablesHit     = new Set(results.map(r => r.table_name)).size;
  const totalRowsEval = results.reduce((sum, r) => sum + (r.total_rows ?? 0), 0);

  const selectedMeta = runs.find(r => r.run_id === selectedRun);
  const runLabel = selectedMeta
    ? `${selectedMeta.year}-${selectedMeta.month}-${selectedMeta.day} ${selectedMeta.run_id.slice(0,2)}:${selectedMeta.run_id.slice(2,4)}:${selectedMeta.run_id.slice(4,6)} UTC`
    : '';
  const sourceLakehouseName = summary?.source_lakehouse_name ?? summary?.source_lakehouse_id ?? '';

  const card = (label: string, value: string | number, accent: string) => (
    <div key={label} style={{
      flex: '1 1 110px', minWidth: 110,
      background: t.surface,
      border: `1px solid ${t.border}`,
      borderLeft: `3px solid ${accent}`,
      borderRadius: 8,
      padding: '14px 16px',
    }}>
      <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, color: t.subtext, marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, color: accent }}>{value}</div>
    </div>
  );

  const panel = (children: React.ReactNode, extraStyle?: React.CSSProperties) => (
    <div style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 8, padding: 16, ...extraStyle }}>
      {children}
    </div>
  );

  const sectionTitle = (title: string, subtitle?: string) => (
    <div style={{ fontSize: 13, fontWeight: 600, color: t.text, marginBottom: 8 }}>
      {title}
      {subtitle && <span style={{ fontWeight: 400, fontSize: 11, color: t.muted, marginLeft: 8 }}>{subtitle}</span>}
    </div>
  );

  return (
    <div style={{ padding: 20, overflowY: 'auto', height: '100%', boxSizing: 'border-box', background: t.bg, color: t.text }}>
      {/* Controls */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
        <select
          value={selectedRun}
          onChange={e => setSelectedRun(e.target.value)}
          disabled={runs.length === 0}
          style={{ padding: '6px 10px', borderRadius: 4, border: `1px solid ${t.border}`, fontSize: 13, background: t.surface, color: t.text }}
        >
          <option value="">— Select Run —</option>
          {runs.map(r => (
            <option key={r.run_id} value={r.run_id}>
              {`${r.year}-${r.month}-${r.day} ${r.run_id.slice(0,2)}:${r.run_id.slice(2,4)} UTC`}
            </option>
          ))}
        </select>

        {loading && <span style={{ color: t.subtext, fontSize: 13 }}>Loading…</span>}
        {error && <span style={{ color: t.fail, fontSize: 13 }}>{error}</span>}
        {runLabel && !loading && <span style={{ fontSize: 12, color: t.subtext, marginLeft: 4 }}>{runLabel}</span>}
        {sourceLakehouseName && !loading && (
          <span style={{ fontSize: 12, color: t.accent, marginLeft: 4, padding: '2px 8px', background: t.surface, border: `1px solid ${t.border}`, borderRadius: 4 }}>
            {sourceLakehouseName}
          </span>
        )}
      </div>

      {/* Historical trend */}
      {trendData.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          {panel(<>
            {sectionTitle('Historical Pass Rate', 'Click a point to view that run')}
            <ReactApexChart type="area" options={trendOptions} series={trendSeries} height={160} />
          </>)}
        </div>
      )}

      {!summary && !loading && (
        <div style={{ color: t.muted, textAlign: 'center', marginTop: 60, fontSize: 14 }}>
          Select a completed run to view results.
          <div style={{ fontSize: 12, marginTop: 8, color: t.subtext }}>Run a notebook from the Configure tab first.</div>
        </div>
      )}

      {summary && results.length > 0 && (
        <>
          {/* KPI cards */}
          <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
            {card('Total Checks',      totalRules,                     t.accent)}
            {card('Passed',            passedRules,                    t.pass)}
            {card('Failed',            failedRules,                    failedRules > 0 ? t.fail : t.pass)}
            {card('Tables',            tablesHit,                      t.accent)}
            {card('Records Evaluated', totalRowsEval.toLocaleString(), t.accent)}
          </div>

          {/* Gauge + Bar side by side */}
          <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
            <div style={{ flex: '0 0 220px', background: t.surface, border: `1px solid ${t.border}`, borderRadius: 8, padding: 12 }}>
              <ReactApexChart type="radialBar" options={gaugeOptions} series={[Math.round(gaugePassRate * 100)]} height={220} />
            </div>
            <div style={{ flex: 1, minWidth: 280, background: t.surface, border: `1px solid ${t.border}`, borderRadius: 8, padding: 12 }}>
              {sectionTitle('Pass Rate by Dimension')}
              <ReactApexChart type="bar" options={barOptions} series={barSeries} height={200} />
            </div>
          </div>

          {/* Heatmap */}
          {heatmapData.length > 0 && heatmapData[0].data.length > 0 && (
            panel(<>
              {sectionTitle('Pass Rate Heatmap', 'Table × Dimension')}
              <ReactApexChart type="heatmap" options={heatOptions} series={heatmapData} height={Math.max(150, heatmapData.length * 45 + 60)} />
            </>)
          )}
        </>
      )}
    </div>
  );
};
