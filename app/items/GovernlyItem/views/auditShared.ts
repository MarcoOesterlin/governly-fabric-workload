import React from 'react';
import { tokens } from '@fluentui/react-components';

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export const DAY_OPTIONS = [7, 14, 30, 60, 90];

export const thStyle: React.CSSProperties = {
  textAlign: 'left', padding: '6px 10px',
  borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  fontSize: 12, fontWeight: 600, color: tokens.colorNeutralForeground3,
  whiteSpace: 'nowrap',
};

export const tdStyle: React.CSSProperties = {
  padding: '8px 10px', fontSize: 13,
  borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  verticalAlign: 'middle',
};
