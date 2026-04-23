import React from 'react';
import { DqDimension, DQ_ACTIVE_DIMENSIONS, DQ_DIMENSION_LABELS, DQ_DIMENSION_DESCRIPTIONS, DqTheme, LIGHT_THEME } from './dqTypes';

interface Props {
  selected: DqDimension[];
  onChange: (dims: DqDimension[]) => void;
  thresholds: Record<DqDimension, number>;
  onThresholdChange: (dim: DqDimension, value: number) => void;
  theme?: DqTheme;
}

export const DimensionPicker: React.FC<Props> = ({ selected, onChange, thresholds, onThresholdChange, theme }) => {
  const t = theme ?? LIGHT_THEME;
  const toggle = (dim: DqDimension) => {
    onChange(selected.includes(dim) ? selected.filter(d => d !== dim) : [...selected, dim]);
  };

  return (
    <div>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10, color: t.text }}>
        Data Quality Dimensions
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {DQ_ACTIVE_DIMENSIONS.map(dim => {
          const checked = selected.includes(dim);
          const pct = thresholds[dim];
          const pctColor = pct >= 95 ? t.pass : pct >= 80 ? t.warn : t.fail;
          return (
            <div
              key={dim}
              style={{
                padding: '8px 10px', borderRadius: 6,
                background: checked ? `${t.accent}18` : t.surface,
                border: `1px solid ${checked ? t.accent : t.border}`,
                transition: 'all 0.1s',
              }}
            >
              {/* Checkbox row */}
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(dim)}
                  style={{ marginTop: 2, accentColor: t.accent }}
                />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: checked ? t.accent : t.text }}>
                    {DQ_DIMENSION_LABELS[dim]}
                  </div>
                  <div style={{ fontSize: 11, color: t.subtext, marginTop: 2 }}>
                    {DQ_DIMENSION_DESCRIPTIONS[dim]}
                  </div>
                </div>
              </label>

              {/* Threshold slider — only when checked */}
              {checked && (
                <div style={{ marginTop: 10, paddingLeft: 22 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <span style={{ fontSize: 11, color: t.subtext }}>Pass threshold</span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: pctColor }}>{pct}%</span>
                  </div>
                  <input
                    type="range"
                    min={50}
                    max={100}
                    step={1}
                    value={pct}
                    onChange={e => onThresholdChange(dim, Number(e.target.value))}
                    style={{ width: '100%', accentColor: t.accent, cursor: 'pointer' }}
                  />
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: t.muted, marginTop: 1 }}>
                    <span>50%</span><span>100%</span>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {/* Accuracy — disabled, coming soon */}
        <div
          style={{ padding: '8px 10px', borderRadius: 6, background: t.surface, border: `1px solid ${t.border}`, opacity: 0.45 }}
          title="Accuracy requires a reference table — coming in a future version"
        >
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'not-allowed' }}>
            <input type="checkbox" disabled checked={false} onChange={() => {}} style={{ marginTop: 2 }} />
            <div>
              <div style={{ fontWeight: 600, fontSize: 13, color: t.subtext }}>
                Accuracy <span style={{ fontSize: 10, fontWeight: 400, background: t.border, borderRadius: 3, padding: '1px 5px' }}>Coming soon</span>
              </div>
              <div style={{ fontSize: 11, color: t.subtext, marginTop: 2 }}>
                {DQ_DIMENSION_DESCRIPTIONS['accuracy']}
              </div>
            </div>
          </label>
        </div>
      </div>

      {selected.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 12, color: t.subtext }}>
          {selected.length} dimension{selected.length > 1 ? 's' : ''} selected
        </div>
      )}
    </div>
  );
};
