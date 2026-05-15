import React, { useEffect, useState, useCallback } from 'react';
import { Spinner } from '@fluentui/react-components';
import { ShieldCheckmark24Regular } from '@fluentui/react-icons';
import { GovernlyApiClient, SpStatus } from '../../../clients/GovernlyApiClient';
import { WorkloadClientAPI } from '@ms-fabric/workload-client';
import { SpProvisionModal } from './SpProvisionModal';

interface SpStatusBadgeProps {
  apiClient: GovernlyApiClient;
  workloadClient: WorkloadClientAPI;
}

type Color = 'green' | 'amber' | 'red' | 'gray';

function statusColor(s: SpStatus | null): Color {
  if (!s) return 'gray';
  if (!s.bootstrapGranted) return 'red';
  if (s.daysRemaining == null) return 'red';
  if (s.daysRemaining <= 0) return 'red';
  if (s.daysRemaining <= 14) return 'amber';
  return 'green';
}

const COLOR_HEX: Record<Color, string> = {
  green: '#107c10',
  amber: '#ca5010',
  red: '#c4314b',
  gray: '#605e5c',
};

export const SpStatusBadge: React.FC<SpStatusBadgeProps> = ({ apiClient, workloadClient }) => {
  const [status, setStatus] = useState<SpStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await apiClient.getSpStatus());
    } catch (e: unknown) {
      console.error('[SpStatusBadge] getSpStatus failed:', e);
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [apiClient]);

  useEffect(() => { refresh(); }, [refresh]);

  const color = statusColor(status);
  const label = (() => {
    if (loading) return 'Service Principal';
    if (!status) return 'SP error';
    if (!status.bootstrapGranted) return 'SP setup required';
    if (status.daysRemaining == null) return 'SP not configured';
    if (status.daysRemaining <= 0) return 'SP expired';
    if (status.daysRemaining <= 14) return `SP expires in ${status.daysRemaining}d`;
    return 'Service Principal';
  })();

  const title = (() => {
    if (!status) return 'Click to set up the service principal';
    if (!status.bootstrapGranted) return 'A Global Admin must consent to Application.ReadWrite.OwnedBy';
    if (status.secretExpiry) return `Secret expires ${new Date(status.secretExpiry).toLocaleDateString()}`;
    return 'No client secret in Key Vault';
  })();

  const handleStatusChange = useCallback((s: SpStatus) => setStatus(s), []);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={title}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '5px 14px', borderRadius: 6, border: '1px solid transparent',
          cursor: 'pointer', fontSize: 13, fontWeight: 600,
          color: '#323130', background: 'rgba(0,120,212,0.08)',
          transition: 'background 0.15s',
        }}
      >
        {loading
          ? <Spinner size="extra-tiny" />
          : <ShieldCheckmark24Regular style={{ fontSize: 16, color: '#0078d4' }} />}
        <span
          aria-hidden="true"
          style={{
            display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
            background: COLOR_HEX[color],
          }}
        />
        {label}
      </button>
      <SpProvisionModal
        open={open}
        apiClient={apiClient}
        workloadClient={workloadClient}
        initialStatus={status}
        onClose={() => setOpen(false)}
        onStatusChange={handleStatusChange}
      />
    </>
  );
};
