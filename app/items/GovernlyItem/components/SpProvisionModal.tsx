import React, { useState, useCallback } from 'react';
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Button, Spinner, Badge, MessageBar, MessageBarBody,
} from '@fluentui/react-components';
import {
  CheckmarkCircle24Filled, ErrorCircle24Filled,
  ShieldCheckmark24Regular, Open24Regular, Info24Regular, ClipboardLink24Regular,
} from '@fluentui/react-icons';
import { GovernlyApiClient, SpStatus } from '../../../clients/GovernlyApiClient';
import { WorkloadClientAPI } from '@ms-fabric/workload-client';

interface SpProvisionModalProps {
  open: boolean;
  apiClient: GovernlyApiClient;
  workloadClient: WorkloadClientAPI;
  initialStatus: SpStatus | null;
  onClose: () => void;
  onStatusChange: (status: SpStatus) => void;
}

type Phase = 'idle' | 'running' | 'done' | 'error';
type ConsentMode = 'url' | 'manual';

const ALL_PERMISSIONS = [
  { name: 'Application.ReadWrite.OwnedBy', type: 'Application', note: 'Bootstrap — required first' },
  { name: 'Group.Read.All',                type: 'Application', note: 'Read AD groups and membership' },
  { name: 'GroupMember.Read.All',          type: 'Application', note: 'Expand group members' },
  { name: 'AuditLog.Read.All',             type: 'Application', note: 'Purview / audit logs' },
  { name: 'Directory.Read.All',            type: 'Application', note: 'Resolve users and objects' },
  { name: 'User.Read.All',                 type: 'Application', note: 'Read user profiles' },
];

export const SpProvisionModal: React.FC<SpProvisionModalProps> = ({
  open, apiClient, workloadClient, initialStatus, onClose, onStatusChange,
}) => {
  const [status, setStatus] = useState<SpStatus | null>(initialStatus);
  const [phase, setPhase] = useState<Phase>('idle');
  const [errorMsg, setErrorMsg] = useState<string | undefined>();
  const [consentOpened, setConsentOpened] = useState(false);
  const [consentMode, setConsentMode] = useState<ConsentMode>('url');
  const [copied, setCopied] = useState(false);

  React.useEffect(() => { setStatus(initialStatus); }, [initialStatus]);

  React.useEffect(() => {
    if (open) {
      setPhase('idle');
      setErrorMsg(undefined);
      setConsentOpened(false);
      setConsentMode('url');
      setCopied(false);
    }
  }, [open]);

  const refreshStatus = useCallback(async () => {
    try {
      const fresh = await apiClient.getSpStatus();
      setStatus(fresh);
      onStatusChange(fresh);
      setPhase('idle');
      setErrorMsg(undefined);
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    }
  }, [apiClient, onStatusChange]);

  const runSetup = useCallback(async () => {
    setPhase('running');
    setErrorMsg(undefined);
    try {
      const fresh = await apiClient.provisionSp();
      setStatus(fresh);
      onStatusChange(fresh);
      setPhase('done');
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  }, [apiClient, onStatusChange]);

  const openConsent = useCallback(async () => {
    try {
      const urls = await apiClient.getSpConsentUrl();
      await workloadClient.navigation.openBrowserTab({ url: urls.url });
      setConsentOpened(true);
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    }
  }, [apiClient, workloadClient]);

  const handleCheckAgain = useCallback(async () => {
    setConsentOpened(false);
    await refreshStatus();
  }, [refreshStatus]);

  const copyPermissions = useCallback(() => {
    const text = ALL_PERMISSIONS.map(p => `${p.name} (${p.type})`).join('\n');
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, []);

  const renderBootstrap = () => (
    <>
      <MessageBar intent="warning">
        <MessageBarBody>
          One-time setup required: a Global Admin must grant admin consent to the required
          Microsoft Graph permissions before Governly can manage its service principal.
        </MessageBarBody>
      </MessageBar>

      {/* Mode toggle */}
      <div style={{ display: 'flex', gap: 0, marginTop: 16, borderRadius: 6, overflow: 'hidden', border: '1px solid #d1d1d1', width: 'fit-content' }}>
        <button
          onClick={() => setConsentMode('url')}
          style={{
            padding: '6px 16px', cursor: 'pointer', fontSize: 13, border: 'none',
            background: consentMode === 'url' ? '#0078d4' : '#fff',
            color: consentMode === 'url' ? '#fff' : '#323130',
          }}>
          <Open24Regular style={{ verticalAlign: 'middle', marginRight: 4, fontSize: 14 }} />
          Admin Consent URL
        </button>
        <button
          onClick={() => setConsentMode('manual')}
          style={{
            padding: '6px 16px', cursor: 'pointer', fontSize: 13, border: 'none', borderLeft: '1px solid #d1d1d1',
            background: consentMode === 'manual' ? '#0078d4' : '#fff',
            color: consentMode === 'manual' ? '#fff' : '#323130',
          }}>
          <Info24Regular style={{ verticalAlign: 'middle', marginRight: 4, fontSize: 14 }} />
          Manual Instructions
        </button>
      </div>

      {consentMode === 'url' ? (
        <>
          <p style={{ fontSize: 13, margin: '12px 0 4px', color: '#605e5c' }}>
            Click the button below to open the Microsoft admin consent page. Sign in as a
            Global Admin and accept the requested permissions.
          </p>
          {consentOpened && (
            <MessageBar intent="info" style={{ marginBottom: 12 }}>
              <MessageBarBody>
                After approving in the browser tab, come back here and click <strong>Check Again</strong>.
              </MessageBarBody>
            </MessageBar>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <Button appearance={consentOpened ? 'secondary' : 'primary'} icon={<Open24Regular />} onClick={openConsent}>
              {consentOpened ? 'Re-open Consent URL' : 'Open Admin Consent URL'}
            </Button>
            <Button appearance={consentOpened ? 'primary' : 'secondary'} onClick={handleCheckAgain}>
              Check Again
            </Button>
          </div>
        </>
      ) : (
        <>
          <p style={{ fontSize: 13, margin: '12px 0 8px', color: '#605e5c' }}>
            Ask your Global Admin to grant the following Application permissions in{' '}
            <strong>Azure Portal → App registrations → [your app] → API permissions → Add permission → Microsoft Graph → Application permissions</strong>,
            then click <strong>Grant admin consent</strong>.
          </p>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '4px 8px', background: '#f3f2f1', borderBottom: '1px solid #d1d1d1' }}>Permission</th>
                <th style={{ textAlign: 'left', padding: '4px 8px', background: '#f3f2f1', borderBottom: '1px solid #d1d1d1' }}>Type</th>
                <th style={{ textAlign: 'left', padding: '4px 8px', background: '#f3f2f1', borderBottom: '1px solid #d1d1d1' }}>Purpose</th>
              </tr>
            </thead>
            <tbody>
              {ALL_PERMISSIONS.map(p => (
                <tr key={p.name}>
                  <td style={{ padding: '5px 8px', borderBottom: '1px solid #edebe9', fontFamily: 'monospace', fontWeight: p.name === 'Application.ReadWrite.OwnedBy' ? 600 : 400 }}>{p.name}</td>
                  <td style={{ padding: '5px 8px', borderBottom: '1px solid #edebe9', color: '#605e5c' }}>{p.type}</td>
                  <td style={{ padding: '5px 8px', borderBottom: '1px solid #edebe9', color: '#605e5c' }}>{p.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <Button icon={<ClipboardLink24Regular />} onClick={copyPermissions}>
              {copied ? 'Copied!' : 'Copy permission list'}
            </Button>
            <Button appearance="primary" onClick={handleCheckAgain}>Check Again</Button>
          </div>
        </>
      )}
    </>
  );

  const renderHealthy = (s: SpStatus) => {
    const ungranted = s.permissions.filter(p => !p.granted);
    return (
      <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <CheckmarkCircle24Filled style={{ color: '#107c10' }} />
          <span>
            Service Principal active. Secret expires{' '}
            <strong>{s.secretExpiry ? new Date(s.secretExpiry).toLocaleDateString() : 'unknown'}</strong>
            {s.daysRemaining != null && <> ({s.daysRemaining} days remaining)</>}.
          </span>
        </div>
        <div style={{ marginBottom: 16 }}>
          <strong>Permissions:</strong>
          <ul style={{ marginTop: 4 }}>
            {s.permissions.map(p => (
              <li key={p.name}>
                {p.granted
                  ? <Badge color="success" appearance="tint">✓</Badge>
                  : <Badge color="danger" appearance="tint">✗</Badge>}
                {' '}{p.name}
              </li>
            ))}
          </ul>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button appearance="primary" onClick={runSetup}>Renew Now</Button>
          {ungranted.length > 0 && (
            <Button icon={<Open24Regular />} onClick={openConsent}>Grant Admin Consent</Button>
          )}
        </div>
      </>
    );
  };

  const renderRunning = () => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <Spinner size="small" />
      <span>Provisioning service principal — generating secret, writing to Key Vault, declaring permissions…</span>
    </div>
  );

  const renderError = () => (
    <>
      <MessageBar intent="error">
        <MessageBarBody>
          <ErrorCircle24Filled style={{ verticalAlign: 'middle', marginRight: 6 }} />
          {errorMsg}
        </MessageBarBody>
      </MessageBar>
      <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
        <Button appearance="primary" onClick={runSetup}>Retry</Button>
        <Button onClick={refreshStatus}>Refresh Status</Button>
      </div>
    </>
  );

  const renderInitialSetup = () => (
    <>
      <MessageBar intent="info">
        <MessageBarBody>
          No active client secret found in Key Vault <code>{status?.vaultName}</code>.
          Click below to generate a 90-day secret, store it in the vault, and declare required Graph permissions.
        </MessageBarBody>
      </MessageBar>
      <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
        <Button appearance="primary" icon={<ShieldCheckmark24Regular />} onClick={runSetup}>Run Setup</Button>
      </div>
    </>
  );

  const renderBody = () => {
    if (phase === 'running') return renderRunning();
    if (phase === 'error') return renderError();
    if (!status) return <Spinner size="small" />;
    if (!status.bootstrapGranted) return renderBootstrap();
    if (status.secretExpiry == null) return renderInitialSetup();
    return renderHealthy(status);
  };

  return (
    <Dialog open={open} onOpenChange={(_, data) => !data.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Service Principal</DialogTitle>
          <DialogContent>{renderBody()}</DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
};
