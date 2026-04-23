import React from 'react';
import { DqDimension, DQ_ACTIVE_DIMENSIONS, DQ_DIMENSION_LABELS, DQ_DIMENSION_DESCRIPTIONS } from './dqTypes';

interface Props {
  selected: DqDimension[];
  onChange: (dims: DqDimension[]) => void;
}

export const DimensionPicker: React.FC<Props> = ({ selected, onChange }) => {
  const toggle = (dim: DqDimension) => {
    onChange(selected.includes(dim) ? selected.filter(d => d !== dim) : [...selected, dim]);
  };

  const allActive = DQ_ACTIVE_DIMENSIONS;

  return (
    <div>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10, color: '#333' }}>
        Data Quality Dimensions
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {allActive.map(dim => {
          const checked = selected.includes(dim);
          return (
            <label
              key={dim}
              style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', padding: '8px 10px', borderRadius: 4, background: checked ? '#e8f0fe' : '#fafafa', border: `1px solid ${checked ? '#0f6cbd' : '#e0e0e0'}`, transition: 'all 0.1s' }}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(dim)}
                style={{ marginTop: 2, accentColor: '#0f6cbd' }}
              />
              <div>
                <div style={{ fontWeight: 600, fontSize: 13, color: checked ? '#0f6cbd' : '#222' }}>
                  {DQ_DIMENSION_LABELS[dim]}
                </div>
                <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>
                  {DQ_DIMENSION_DESCRIPTIONS[dim]}
                </div>
              </div>
            </label>
          );
        })}

        {/* Accuracy — disabled, coming soon */}
        <label
          style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'not-allowed', padding: '8px 10px', borderRadius: 4, background: '#f5f5f5', border: '1px solid #e0e0e0', opacity: 0.5 }}
          title="Accuracy requires a reference table — coming in a future version"
        >
          <input type="checkbox" disabled checked={false} onChange={() => {}} style={{ marginTop: 2 }} />
          <div>
            <div style={{ fontWeight: 600, fontSize: 13, color: '#888' }}>
              Accuracy <span style={{ fontSize: 10, fontWeight: 400, background: '#e0e0e0', borderRadius: 3, padding: '1px 5px' }}>Coming soon</span>
            </div>
            <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
              {DQ_DIMENSION_DESCRIPTIONS['accuracy']}
            </div>
          </div>
        </label>
      </div>

      {selected.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 12, color: '#555' }}>
          {selected.length} dimension{selected.length > 1 ? 's' : ''} selected
        </div>
      )}
    </div>
  );
};
