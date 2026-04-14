import { WorkloadClientAPI } from '@ms-fabric/workload-client';
import { FabricAuthenticationService } from './FabricAuthenticationService';

const BACKEND_URL = process.env.BACKEND_URL || '';
const BACKEND_SCOPES = process.env.BACKEND_SCOPES || '';

export interface FabricItem {
  id: string;
  type: string;
  displayName: string;
  workspaceId: string;
  workspaceName?: string;
  sensitivity?: { labelId: string; labelName?: string };
}

export interface FabricItemsPage {
  items: FabricItem[];
  continuationToken?: string;
}

export interface Domain {
  id: string;
  displayName: string;
  description?: string;
  parentDomainId?: string;
  parentDomainName?: string;
  defaultLabelId?: string;
  defaultLabelName?: string;
}

export interface Workspace {
  id: string;
  displayName: string;
}

export interface Lakehouse {
  id: string;
  displayName: string;
}

export interface LakehouseTable {
  name: string;
  type: 'Managed' | 'External';
  format: string;
}

export interface SensitivityLabel {
  id: string;
  name: string;
  description?: string;
  color?: string;
  sensitivity: number;
  isActive: boolean;
  isAppliable: boolean;
  parent?: { id: string; name: string };
}

export interface BulkOperationResult {
  successCount: number;
  failureCount: number;
  failures: Array<{ itemId: string; errorMessage: string }>;
}

export class GovernlyApiClient {
  private authService: FabricAuthenticationService;

  constructor(workloadClient: WorkloadClientAPI) {
    this.authService = new FabricAuthenticationService(workloadClient);
  }

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const token = await this.authService.acquireAccessToken(BACKEND_SCOPES);
    const url = `${BACKEND_URL}${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token.token}`,
        ...(options?.headers || {}),
      },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API error ${response.status}: ${text}`);
    }
    if (response.status === 204) return undefined as unknown as T;
    return response.json() as Promise<T>;
  }

  async listItems(params?: {
    workspaceId?: string;
    type?: string;
    continuationToken?: string;
  }): Promise<FabricItemsPage> {
    const query = new URLSearchParams();
    if (params?.workspaceId) query.set('workspaceId', params.workspaceId);
    if (params?.type) query.set('type', params.type);
    if (params?.continuationToken) query.set('continuationToken', params.continuationToken);
    const qs = query.toString() ? `?${query.toString()}` : '';
    return this.request<FabricItemsPage>(`/api/items${qs}`);
  }

  async listDomains(): Promise<Domain[]> {
    return this.request<Domain[]>('/api/domains');
  }

  async updateDomainLabel(domainId: string, labelId: string | null): Promise<void> {
    return this.request<void>(`/api/domains/${domainId}/label`, {
      method: 'PUT',
      body: JSON.stringify({ labelId }),
    });
  }

  async listWorkspaces(): Promise<Workspace[]> {
    return this.request<Workspace[]>('/api/workspaces');
  }

  async listLakehouses(workspaceId: string): Promise<Lakehouse[]> {
    return this.request<Lakehouse[]>(`/api/workspaces/${workspaceId}/lakehouses`);
  }

  async listLakehouseTables(workspaceId: string, lakehouseId: string): Promise<LakehouseTable[]> {
    return this.request<LakehouseTable[]>(
      `/api/workspaces/${workspaceId}/lakehouses/${lakehouseId}/tables`
    );
  }

  async listSensitivityLabels(): Promise<SensitivityLabel[]> {
    return this.request<SensitivityLabel[]>('/api/labels');
  }

  async bulkSetLabels(
    items: Array<{ id: string; type: string }>,
    labelId: string
  ): Promise<BulkOperationResult> {
    return this.request<BulkOperationResult>('/api/labels/bulk-apply', {
      method: 'POST',
      body: JSON.stringify({ items, labelId }),
    });
  }

  async bulkRemoveLabels(
    items: Array<{ id: string; type: string }>
  ): Promise<BulkOperationResult> {
    return this.request<BulkOperationResult>('/api/labels/bulk-remove', {
      method: 'POST',
      body: JSON.stringify({ items }),
    });
  }
}
