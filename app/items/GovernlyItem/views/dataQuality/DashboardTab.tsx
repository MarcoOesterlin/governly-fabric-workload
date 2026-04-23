import React, { useEffect, useMemo, useState } from 'react';
import ReactApexChart from 'react-apexcharts';
import { ApexOptions } from 'apexcharts';
import { GovernlyApiClient } from '../../../../clients/GovernlyApiClient';
import { DqRunMeta, DqRunSummary, DqResultRow, DQ_DIMENSION_LABELS, DqDimension, DARK_THEME, LIGHT_THEME } from './dqTypes';

interface Props {
  apiClient: GovernlyApiClient;
  workspaceId: string;
  darkMode: boolean;
  runs: DqRunMeta[];
  summaries: Record<string, DqRunSummary>;
  loading: boolean;
  error: string | null;
}

export const DashboardTab: React.FC<Props> = ({ darkMode, runs, summaries, loading, error }) => {
  const t = darkMode ? DARK_THEME : LIGHT_THEME;
  const [selectedRun, setSelectedRun] = useState<string>('');

  useEffect(() => {
    if (runs.length > 0 && !selectedRun) setSelectedRun(runs[0].run_id);
  }, [runs]); // eslint-disable-line react-hooks/exhaustive-deps

  const summary: DqRunSummary | null = summaries[selectedRun] ?? null;
  const results: DqResultRow[] = summary?.results ?? [];

  // ── Trend ──────────────────────────────────────────────────────────────────────
  const trendData = useMemo(() =>
    [...runs].reverse().map(meta => ({
      meta,
      passRate: (() => {
        const s = summaries[meta.run_id];
        if (!s || s.results.length === 0) return 0;
        return Math.round(s.results.filter(r => r.passed).length / s.results.length * 100);
      })(),
      label: `${meta.year}-${meta.month}-${meta.day} ${meta.run_id.slice(0, 2)}:${meta.run_id.slice(2, 4)}`,
    }))
  , [runs, summaries]);

  // ── Aggregations ───────────────────────────────────────────────────────────────
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

  const tableStats = useMemo(() => {
    const tables = [...new Set(results.map(r => r.table_name))];
    return tables
      .map(tbl => {
        const tr = results.filter(r => r.table_name === tbl);
        const rate = Math.round(tr.filter(r => r.passed).length / tr.length * 100);
        const totalRows = tr.reduce((s, r) => s + (r.total_rows ?? 0), 0);
        return { name: tbl, rate, totalRows };
      })
      .sort((a, b) => a.rate - b.rate);
  }, [results]);

  const topIssues = useMemo(() =>
    results.filter(r => !r.passed).sort((a, b) => a.metric_value - b.metric_value).slice(0, 8)
  , [results]);

  // ── KPI values ─────────────────────────────────────────────────────────────────
  const totalRules    = results.length;
  const passedRules   = results.filter(r => r.passed).length;
  const failedRules   = totalRules - passedRules;
  const tablesHit     = new Set(results.map(r => r.table_name)).size;
  const totalRowsEval = results.reduce((sum, r) => sum + (r.total_rows ?? 0), 0);
  const gaugePassRate = overallPassRate ?? 0;
  const gaugeColor    = gaugePassRate >= 0.95 ? t.pass : gaugePassRate >= 0.80 ? t.warn : t.fail;

  const dimKeys  = Object.keys(byDimension);
  const dimRates = dimKeys.map(d => Math.round((byDimension[d].pass / byDimension[d].total) * 100));

  const selectedMeta = runs.find(r => r.run_id === selectedRun);
  const runLabel = selectedMeta
    ? `${selectedMeta.year}-${selectedMeta.month}-${selectedMeta.day}  ${selectedMeta.run_id.slice(0, 2)}:${selectedMeta.run_id.slice(2, 4)} UTC`
    : '';
  const sourceLakehouseName = summary?.source_lakehouse_name ?? summary?.source_lakehouse_id ?? '';

  // ── Shared chart base ──────────────────────────────────────────────────────────
  const chartBase = {
    background: 'transparent',
    foreColor:  t.subtext,
    fontFamily: 'inherit',
    toolbar:    { show: false },
  };

  // ── Trend chart ────────────────────────────────────────────────────────────────
  const trendOptions: ApexOptions = {
    chart: {
      ...chartBase, type: 'area',
      events: {
        dataPointSelection: (_e: any, _ctx: any, cfg: any) => {
          const pt = trendData[cfg.dataPointIndex];
          if (pt) setSelectedRun(pt.meta.run_id);
        },
      },
    },
    theme:   { mode: darkMode ? 'dark' : 'light' },
    stroke:  { curve: 'smooth', width: 2 },
    fill:    { type: 'gradient', gradient: { shadeIntensity: 1, opacityFrom: 0.35, opacityTo: 0.03 } },
    markers: {
      size:         trendData.map(pt => pt.meta.run_id === selectedRun ? 8 : 4),
      colors:       trendData.map(pt => pt.meta.run_id === selectedRun ? t.accent : t.surface),
      strokeColors: t.accent,
      strokeWidth:  2,
    },
    colors:  [t.accent],
    xaxis:   { categories: trendData.map(d => d.label), labels: { rotate: -30, style: { fontSize: '10px', colors: t.subtext } } },
    yaxis:   { min: 0, max: 100, labels: { formatter: (v: number) => `${v}%`, style: { colors: t.subtext } } },
    tooltip: { y: { formatter: (v: number) => `${v}%` }, theme: darkMode ? 'dark' : 'light' },
    grid:    { borderColor: t.border },
    annotations: {
      yaxis: [{ y: 95, borderColor: t.pass, borderWidth: 1, strokeDashArray: 4,
        label: { text: '95% target', style: { color: t.pass, background: 'transparent', fontSize: '10px', fontWeight: 600 } },
      }],
    },
  };

  // ── Gauge ──────────────────────────────────────────────────────────────────────
  const gaugeOptions: ApexOptions = {
    chart: { ...chartBase, type: 'radialBar' },
    theme: { mode: darkMode ? 'dark' : 'light' },
    plotOptions: { radialBar: {
      startAngle: -135, endAngle: 135,
      hollow: { size: '60%' },
      track:  { background: t.border, strokeWidth: '100%' },
      dataLabels: {
        name:  { show: true, offsetY: -10, color: t.subtext, fontSize: '12px' },
        value: { fontSize: '30px', fontWeight: 700, color: gaugeColor, formatter: (v: number) => `${v}%` },
      },
    }},
    colors: [gaugeColor],
    labels: ['Overall'],
  };

  // ── Dimension bar ──────────────────────────────────────────────────────────────
  const dimBarOptions: ApexOptions = {
    chart:       { ...chartBase, type: 'bar' },
    theme:       { mode: darkMode ? 'dark' : 'light' },
    plotOptions: { bar: { borderRadius: 3, horizontal: true, barHeight: '55%', distributed: true } },
    colors:      dimRates.map(r => r >= 95 ? t.pass : r >= 80 ? t.warn : t.fail),
    legend:      { show: false },
    xaxis: {
      categories: dimKeys.map(d => DQ_DIMENSION_LABELS[d as DqDimension] ?? d),
      min: 0, max: 100,
      labels: { formatter: (v: number) => `${v}%`, style: { colors: t.subtext, fontSize: '11px' } },
    },
    yaxis:       { labels: { style: { colors: t.subtext, fontSize: '11px' } } },
    tooltip:     { y: { formatter: (v: number) => `${v}%` }, theme: darkMode ? 'dark' : 'light' },
    dataLabels:  { enabled: true, formatter: (v: number) => `${v}%`, style: { fontSize: '11px', colors: ['#fff'] } },
    grid:        { borderColor: t.border },
  };

  // ── Table Health bar chart ─────────────────────────────────────────────────────
  const tableBarOptions: ApexOptions = {
    chart:       { ...chartBase, type: 'bar' },
    theme:       { mode: darkMode ? 'dark' : 'light' },
    plotOptions: { bar: { borderRadius: 4, horizontal: true, barHeight: '60%', distributed: true } },
    colors:      tableStats.map(ts => ts.rate >= 95 ? t.pass : ts.rate >= 80 ? t.warn : t.fail),
    legend:      { show: false },
    xaxis: {
      categories: tableStats.map(ts => ts.name),
      min: 0, max: 100,
      labels: { formatter: (v: any) => `${v}%`, style: { colors: t.subtext, fontSize: '11px' } },
    },
    yaxis:      { labels: { style: { colors: t.subtext, fontSize: '11px' }, maxWidth: 160 } },
    dataLabels: { enabled: true, formatter: (v: any) => `${Math.round(v)}%`, style: { fontSize: '11px', colors: ['#fff'] } },
    tooltip:    { y: { formatter: (v: number) => `${v}%` }, theme: darkMode ? 'dark' : 'light' },
    grid:       { borderColor: t.border },
  };
  const tableBarSeries = [{ name: 'Pass Rate', data: tableStats.map(ts => ts.rate) }];

  // ── UI helpers ─────────────────────────────────────────────────────────────────
  const panel = (children: React.ReactNode, style?: React.CSSProperties) => (
    <div style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 8, padding: 16, ...style }}>
      {children}
    </div>
  );

  const panelTitle = (title: string, sub?: string) => (
    <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.8px', color: t.subtext, marginBottom: 12 }}>
      {title}
      {sub && <span style={{ fontWeight: 400, textTransform: 'none' as const, letterSpacing: 0, fontSize: 11, marginLeft: 8, opacity: 0.7 }}>{sub}</span>}
    </div>
  );

  const kpiCard = (label: string, value: string | number, color: string) => (
    <div key={label} style={{
      flex: '1 1 100px', minWidth: 90,
      background: t.surface, border: `1px solid ${t.border}`,
      borderTop: `3px solid ${color}`, borderRadius: 8, padding: '12px 14px',
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.8px', color: t.subtext, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, color, lineHeight: 1 }}>{value}</div>
    </div>
  );

  return (
    <div style={{ padding: 20, overflowY: 'auto', height: '100%', boxSizing: 'border-box', background: t.bg, color: t.text }}>

      {/* Run selector bar */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
        <select
          value={selectedRun}
          onChange={e => setSelectedRun(e.target.value)}
          disabled={runs.length === 0}
          style={{ padding: '6px 10px', borderRadius: 4, border: `1px solid ${t.border}`, fontSize: 13, background: t.surface, color: t.text, outline: 'none' }}
        >
          <option value="">Select a run</option>
          {runs.map(r => (
            <option key={r.run_id} value={r.run_id}>
              {`${r.year}-${r.month}-${r.day}  ${r.run_id.slice(0, 2)}:${r.run_id.slice(2, 4)} UTC`}
            </option>
          ))}
        </select>

        {sourceLakehouseName && !loading && (
          <span style={{ fontSize: 12, padding: '3px 10px', background: `${t.accent}22`, border: `1px solid ${t.accent}44`, borderRadius: 20, color: t.accent, fontWeight: 500 }}>
            {sourceLakehouseName}
          </span>
        )}
        {loading && <span style={{ color: t.subtext, fontSize: 13 }}>Loading...</span>}
        {error   && <span style={{ color: t.fail,    fontSize: 13 }}>{error}</span>}
        {runLabel && !loading && <span style={{ fontSize: 12, color: t.subtext, marginLeft: 'auto' }}>{runLabel}</span>}
      </div>

      {/* Trend chart */}
      {trendData.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          {panel(<>
            {panelTitle('Quality Trend', 'Click a point to inspect that run')}
            <ReactApexChart type="area" options={trendOptions} series={[{ name: 'Pass Rate', data: trendData.map(d => d.passRate) }]} height={150} />
          </>)}
        </div>
      )}

      {!summary && !loading && (
        <div style={{ color: t.subtext, textAlign: 'center', marginTop: 60, fontSize: 14 }}>
          No run selected.
          <div style={{ fontSize: 12, marginTop: 8, color: t.muted }}>Run a notebook from Configure &amp; Run first.</div>
        </div>
      )}

      {summary && results.length > 0 && (<>

        {/* KPI cards */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
          {kpiCard('Score',         `${Math.round(gaugePassRate * 100)}%`, gaugeColor)}
          {kpiCard('Checks',        totalRules,                            t.accent)}
          {kpiCard('Passed',        passedRules,                           t.pass)}
          {kpiCard('Failed',        failedRules,                           failedRules > 0 ? t.fail : t.pass)}
          {kpiCard('Tables',        tablesHit,                             t.accent)}
          {kpiCard('Rows Scanned',  totalRowsEval.toLocaleString(),        t.accent)}
        </div>

        {/* Gauge + Dimension pass rates */}
        <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
          {panel(
            <ReactApexChart type="radialBar" options={gaugeOptions} series={[Math.round(gaugePassRate * 100)]} height={220} />,
            { flex: '0 0 210px', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 8 }
          )}
          {panel(<>
            {panelTitle('Pass Rate by Dimension')}
            {dimKeys.length > 0
              ? <ReactApexChart type="bar" options={dimBarOptions} series={[{ name: 'Pass Rate', data: dimRates }]} height={Math.max(160, dimKeys.length * 38)} />
              : <div style={{ color: t.subtext, fontSize: 13 }}>No dimension data</div>
            }
          </>, { flex: 1, minWidth: 260 })}
        </div>

        {/* Table Health — horizontal bar */}
        {tableStats.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            {panel(<>
              {panelTitle('Table Health', 'Sorted worst → best')}
              <ReactApexChart
                type="bar"
                options={tableBarOptions}
                series={tableBarSeries}
                height={Math.max(180, tableStats.length * 40 + 30)}
              />
            </>)}
          </div>
        )}

        {/* Top Issues — data table */}
        <div style={{ marginBottom: 16 }}>
          {panel(<>
            {panelTitle(
              topIssues.length > 0 ? 'Top Issues' : 'No Issues',
              topIssues.length > 0 ? `${topIssues.length} failing check${topIssues.length !== 1 ? 's' : ''}` : undefined
            )}
            {topIssues.length === 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '24px 0', gap: 8 }}>
                <div style={{ fontSize: 28 }}>✓</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: t.pass }}>All checks passing</div>
                <div style={{ fontSize: 12, color: t.subtext }}>No failing rules in this run</div>
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr>
                      {['Table', 'Column', 'Dimension', 'Score', 'Threshold', 'Status'].map(h => (
                        <th key={h} style={{
                          padding: '6px 12px', textAlign: 'left', color: t.subtext,
                          fontWeight: 700, fontSize: 10, textTransform: 'uppercase' as const,
                          letterSpacing: '0.6px', borderBottom: `1px solid ${t.border}`, whiteSpace: 'nowrap' as const,
                        }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {topIssues.map((issue, i) => {
                      const score     = Math.round(issue.metric_value);
                      const threshold = Math.round(issue.threshold ?? 0);
                      const scoreColor = score >= 80 ? t.warn : t.fail;
                      return (
                        <tr key={i} style={{ borderBottom: `1px solid ${t.border}33` }}>
                          <td style={{ padding: '8px 12px', color: t.text, fontWeight: 500, whiteSpace: 'nowrap' as const, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>{issue.table_name}</td>
                          <td style={{ padding: '8px 12px', color: t.subtext, whiteSpace: 'nowrap' as const, maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis' }}>{issue.column_name ?? '—'}</td>
                          <td style={{ padding: '8px 12px', color: t.subtext, whiteSpace: 'nowrap' as const }}>{DQ_DIMENSION_LABELS[issue.dimension as DqDimension] ?? issue.dimension}</td>
                          <td style={{ padding: '8px 12px', color: scoreColor, fontWeight: 700, whiteSpace: 'nowrap' as const }}>{score}%</td>
                          <td style={{ padding: '8px 12px', color: t.subtext, whiteSpace: 'nowrap' as const }}>{threshold}%</td>
                          <td style={{ padding: '8px 12px' }}>
                            <span style={{
                              padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 700,
                              background: `${t.fail}22`, color: t.fail, border: `1px solid ${t.fail}44`,
                            }}>FAIL</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>)}
        </div>
      </>)}
    </div>
  );
};
