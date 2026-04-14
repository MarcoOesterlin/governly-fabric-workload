import type {
  FabricItemsPage,
  FabricDomain,
  BulkOperationResult,
  LakehouseTable,
} from '../types/fabric.js';

const FABRIC_BASE = 'https://api.fabric.microsoft.com/v1';

export class FabricService {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  private async request<T>(url: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...(options.headers as Record<string, string>),
      },
    });

    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      const error = Object.assign(new Error('Rate limited by Fabric API'), {
        status: 429,
        retryAfter: retryAfter ? parseInt(retryAfter, 10) : undefined,
      });
      throw error;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      const error = Object.assign(new Error(`Fabric API error ${response.status}: ${text}`), {
        status: response.status,
      });
      throw error;
    }

    // 204 No Content
    if (response.status === 204) return undefined as unknown as T;

    return response.json() as Promise<T>;
  }

  async listItems(params?: {
    workspaceId?: string;
    type?: string;
    continuationToken?: string;
  }): Promise<FabricItemsPage> {
    const url = new URL(`${FABRIC_BASE}/admin/items`);
    if (params?.workspaceId) url.searchParams.set('workspaceId', params.workspaceId);
    if (params?.type) url.searchParams.set('type', params.type);
    if (params?.continuationToken)
      url.searchParams.set('continuationToken', params.continuationToken);

    return this.request<FabricItemsPage>(url.toString());
  }

  async listDomains(): Promise<FabricDomain[]> {
    const data = await this.request<{ domains: FabricDomain[] }>(
      `${FABRIC_BASE}/admin/domains?preview=false`
    );
    return data.domains ?? [];
  }

  async updateDomainLabel(domainId: string, labelId: string | null): Promise<void> {
    await this.request<void>(
      `${FABRIC_BASE}/admin/domains/${domainId}?preview=false`,
      {
        method: 'PATCH',
        body: JSON.stringify({ defaultLabelId: labelId }),
      }
    );
  }

  async bulkSetLabels(
    items: Array<{ id: string; type: string }>,
    labelId: string,
    assignmentMethod?: string
  ): Promise<BulkOperationResult> {
    return this.request<BulkOperationResult>(`${FABRIC_BASE}/admin/items/bulkSetLabels`, {
      method: 'POST',
      body: JSON.stringify({ items, labelId, assignmentMethod }),
    });
  }

  async bulkRemoveLabels(
    items: Array<{ id: string; type: string }>
  ): Promise<BulkOperationResult> {
    return this.request<BulkOperationResult>(`${FABRIC_BASE}/admin/items/bulkRemoveLabels`, {
      method: 'POST',
      body: JSON.stringify({ items }),
    });
  }

  async listLakehouses(workspaceId: string): Promise<unknown[]> {
    const data = await this.request<{ value: unknown[] }>(
      `${FABRIC_BASE}/workspaces/${workspaceId}/lakehouses`
    );
    return data.value ?? [];
  }

  async listLakehouseTables(
    workspaceId: string,
    lakehouseId: string
  ): Promise<LakehouseTable[]> {
    const data = await this.request<{ data: LakehouseTable[] }>(
      `${FABRIC_BASE}/workspaces/${workspaceId}/lakehouses/${lakehouseId}/tables`
    );
    return data.data ?? [];
  }

  async listWorkspaces(): Promise<unknown[]> {
    const data = await this.request<{ value: unknown[] }>(`${FABRIC_BASE}/workspaces`);
    return data.value ?? [];
  }
}
