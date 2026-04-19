import React from 'react';
import { Combobox, Option, OptionGroup } from '@fluentui/react-components';
import { SensitivityLabel } from '../../../clients/GovernlyApiClient';

interface LabelPickerProps {
  labels: SensitivityLabel[];
  value: string | undefined;
  onChange: (labelId: string) => void;
  placeholder?: string;
}

const ColorSwatch: React.FC<{ color?: string }> = ({ color }) => (
  <span
    style={{
      display: 'inline-block',
      width: 10,
      height: 10,
      backgroundColor: color || '#ccc',
      borderRadius: 2,
      marginRight: 6,
      flexShrink: 0,
      border: '1px solid rgba(0,0,0,0.15)',
    }}
  />
);

export const LabelPicker: React.FC<LabelPickerProps> = ({
  labels,
  value,
  onChange,
  placeholder = 'Select a label…',
}) => {
  const selectedLabel = labels.find(l => l.id === value);
  const displayValue = selectedLabel ? selectedLabel.name : '';

  // Group labels by parent
  const parentLabels = labels.filter(l => !l.parent);
  const childLabels = labels.filter(l => !!l.parent);
  const parentIds = new Set(parentLabels.map(l => l.id));
  const childrenByParent: Record<string, SensitivityLabel[]> = {};
  childLabels.forEach(l => {
    if (l.parent) {
      if (!childrenByParent[l.parent.id]) childrenByParent[l.parent.id] = [];
      childrenByParent[l.parent.id].push(l);
    }
  });
  const standaloneLabels = labels.filter(l => !l.parent && !parentIds.has(l.id));
  const groupedParents = parentLabels.filter(p => childrenByParent[p.id]?.length > 0);

  const renderLabel = (label: SensitivityLabel) => (
    <Option key={label.id} value={label.id} text={label.name}>
      <span style={{ display: 'flex', flexDirection: 'column' }}>
        <span style={{ display: 'flex', alignItems: 'center' }}>
          <ColorSwatch color={label.color} />
          <span>{label.name}</span>
          <span style={{ marginLeft: 8, fontSize: 11, color: '#888' }}>Level {label.sensitivity}</span>
        </span>
        {label.description && (
          <span style={{ fontSize: 11, color: '#888', marginLeft: 16, marginTop: 1 }}>
            {label.description}
          </span>
        )}
      </span>
    </Option>
  );

  return (
    <Combobox
      placeholder={placeholder}
      value={displayValue}
      onOptionSelect={(_, data) => {
        if (data.optionValue) onChange(data.optionValue);
      }}
      style={{ minWidth: 240 }}
    >
      {groupedParents.length > 0 ? (
        <>
          {standaloneLabels.map(renderLabel)}
          {groupedParents.map(parent => (
            <OptionGroup key={parent.id} label={parent.name}>
              {renderLabel(parent)}
              {(childrenByParent[parent.id] || []).map(renderLabel)}
            </OptionGroup>
          ))}
        </>
      ) : (
        labels.map(renderLabel)
      )}
    </Combobox>
  );
};
