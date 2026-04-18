import { WorkloadClientAPI } from '@ms-fabric/workload-client';
import { FabricAuthenticationService } from './FabricAuthenticationService';

const FABRIC_API = 'https://api.fabric.microsoft.com/v1';
const GRAPH_API = 'https://graph.microsoft.com/beta';
const FABRIC_SCOPE = 'https://api.fabric.microsoft.com/.default';
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

// Fabric bulkSetLabels / bulkRemoveLabels accept up to 2,000 items per request.
const BATCH_SIZE = 2000;

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

  private async request<T>(baseUrl: string, scope: string, path: string, options?: RequestInit): Promise<T> {
    const { token } = await this.authService.acquireAccessToken(scope);
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(options?.headers ?? {}),
      },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API ${response.status}: ${text}`);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (response.status === 204 || !contentType.includes('application/json')) {
      return undefined as unknown as T;
    }
    return response.json() as Promise<T>;
  }

  private fabric<T>(path: string, options?: RequestInit): Promise<T> {
    return this.request<T>(FABRIC_API, FABRIC_SCOPE, path, options);
  }

  private graph<T>(path: string, options?: RequestInit): Promise<T> {
    return this.request<T>(GRAPH_API, GRAPH_SCOPE, path, options);
  }

  async listWorkspaceItems(workspaceId: string): Promise<FabricItem[]> {
    const all: FabricItem[] = [];
    let continuationUri: string | undefined =
      `${FABRIC_API}/workspaces/${workspaceId}/items`;

    while (continuationUri) {
      const { token } = await this.authService.acquireAccessToken(FABRIC_SCOPE);
      const response = await fetch(continuationUri, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Fabric API ${response.status}: ${text}`);
      }
      const data: { value: any[]; continuationUri?: string } = await response.json();
      for (const i of data.value ?? []) {
        all.push({
          id: i.id,
          type: i.type,
          displayName: i.displayName,
          workspaceId: i.workspaceId ?? workspaceId,
        });
      }
      continuationUri = data.continuationUri;
    }
    return all;
  }

  async listItems(params?: {
    workspaceId?: string;
    type?: string;
    continuationToken?: string;
  }): Promise<FabricItemsPage> {
    const q = new URLSearchParams();
    if (params?.workspaceId) q.set('workspaceId', params.workspaceId);
    if (params?.type) q.set('type', params.type);
    if (params?.continuationToken) q.set('continuationToken', params.continuationToken);
    const qs = q.toString() ? `?${q.toString()}` : '';
    const data = await this.fabric<{ itemEntities: any[]; continuationToken?: string }>(
      `/admin/items${qs}`
    );
    return {
      items: (data.itemEntities ?? []).map(i => ({
        id: i.id,
        type: i.type,
        displayName: i.displayName,
        workspaceId: i.workspaceId,
        sensitivity: i.sensitivity
          ? { labelId: i.sensitivity.labelId, labelName: i.sensitivity.labelDisplayName }
          : undefined,
      })),
      continuationToken: data.continuationToken,
    };
  }

  async listWorkspaces(): Promise<Workspace[]> {
    const data = await this.fabric<{ workspaces: any[] }>('/admin/workspaces');
    return (data.workspaces ?? []).map(w => ({ id: w.id, displayName: w.displayName }));
  }

  async listDomains(): Promise<Domain[]> {
    const data = await this.fabric<{ domains: any[] }>('/admin/domains');
    return (data.domains ?? []).map(d => ({
      id: d.id,
      displayName: d.displayName,
      description: d.description,
      parentDomainId: d.parentDomainId,
    }));
  }

  async listLakehouses(workspaceId: string): Promise<Lakehouse[]> {
    const data = await this.fabric<{ value: any[] }>(`/workspaces/${workspaceId}/lakehouses`);
    return (data.value ?? []).map(l => ({ id: l.id, displayName: l.displayName }));
  }

  async listLakehouseTables(workspaceId: string, lakehouseId: string): Promise<LakehouseTable[]> {
    const data = await this.fabric<{ data: any[] }>(
      `/workspaces/${workspaceId}/lakehouses/${lakehouseId}/tables`
    );
    return (data.data ?? []).map(t => ({ name: t.name, type: t.type, format: t.format ?? '' }));
  }

  async listSensitivityLabels(): Promise<SensitivityLabel[]> {
    const data = await this.graph<{ value: any[] }>(
      '/security/informationProtection/sensitivityLabels'
    );
    return (data.value ?? []).map(l => ({
      id: l.id,
      name: l.name,
      description: l.description,
      color: l.color,
      sensitivity: l.sensitivity ?? 0,
      isActive: l.isActive ?? true,
      isAppliable: l.isAppliable ?? true,
      parent: l.parent,
    }));
  }

  async bulkSetLabels(
    items: Array<{ id: string; type: string }>,
    labelId: string
  ): Promise<BulkOperationResult> {
    const result: BulkOperationResult = { successCount: 0, failureCount: 0, failures: [] };
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);
      try {
        const res = await this.fabric<{ failedItems?: any[] }>('/admin/items/bulkSetLabels', {
          method: 'POST',
          body: JSON.stringify({
            items: batch,
            updateDetails: { sensitivityLabelId: labelId },
          }),
        });
        const failed = res?.failedItems ?? [];
        result.failureCount += failed.length;
        result.successCount += batch.length - failed.length;
        result.failures.push(
          ...failed.map((f: any) => ({ itemId: f.id, errorMessage: f.error?.message ?? 'Unknown error' }))
        );
      } catch (e: any) {
        result.failureCount += batch.length;
        result.failures.push({ itemId: 'batch', errorMessage: e.message });
      }
    }
    return result;
  }

  async bulkRemoveLabels(
    items: Array<{ id: string; type: string }>
  ): Promise<BulkOperationResult> {
    const result: BulkOperationResult = { successCount: 0, failureCount: 0, failures: [] };
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);
      try {
        const res = await this.fabric<{ failedItems?: any[] }>('/admin/items/bulkRemoveLabels', {
          method: 'POST',
          body: JSON.stringify({ items: batch }),
        });
        const failed = res?.failedItems ?? [];
        result.failureCount += failed.length;
        result.successCount += batch.length - failed.length;
        result.failures.push(
          ...failed.map((f: any) => ({ itemId: f.id, errorMessage: f.error?.message ?? 'Unknown error' }))
        );
      } catch (e: any) {
        result.failureCount += batch.length;
        result.failures.push({ itemId: 'batch', errorMessage: e.message });
      }
    }
    return result;
  }

  // Applies a label (or removes if labelId is null) to every item in every
  // workspace belonging to the given domain.
  async updateDomainLabel(domainId: string, labelId: string | null): Promise<void> {
    const wsData = await this.fabric<{ workspaces: any[] }>(
      `/admin/domains/${domainId}/workspaces`
    );
    const workspaces: Workspace[] = (wsData.workspaces ?? []).map(w => ({
      id: w.id,
      displayName: w.displayName,
    }));

    const allItems: Array<{ id: string; type: string }> = [];
    for (const ws of workspaces) {
      let token: string | undefined;
      do {
        const page = await this.listItems({ workspaceId: ws.id, continuationToken: token });
        allItems.push(...page.items.map(item => ({ id: item.id, type: item.type })));
        token = page.continuationToken;
      } while (token);
    }

    if (allItems.length === 0) return;
    if (labelId) {
      await this.bulkSetLabels(allItems, labelId);
    } else {
      await this.bulkRemoveLabels(allItems);
    }
  }
}
