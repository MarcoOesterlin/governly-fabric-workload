import { WorkloadClientAPI } from '@ms-fabric/workload-client';

// Fabric constructs are batch-limited to 2,000 items per request.
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

/**
 * GovernlyApiClient
 *
 * Routes all Fabric, Graph, and PowerBI API calls through the devServer proxy
 * at /api/proxy. Graph calls acquire a token from the Fabric SDK
 * (acquireFrontendAccessToken) — the user is already authenticated in Fabric so
 * no extra login is required. The token is sent in the proxy request body and
 * used directly by the proxy, keeping the auth flow identical in dev and prod.
 */
export class GovernlyApiClient {
  constructor(_workloadClient?: WorkloadClientAPI) {
    // workloadClient reserved for future Fabric SDK calls
  }

  /**
   * Send a request through the devServer API proxy.
   * All auth (Fabric, Graph, PowerBI) is handled server-side in the proxy.
   */
  private async proxyRequest<T>(
    api: 'fabric' | 'graph' | 'powerbi',
    path: string,
    options?: { method?: string; body?: unknown }
  ): Promise<T> {
    const response = await fetch('/api/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api,
        method: options?.method ?? 'GET',
        path,
        body: options?.body,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${api} API ${response.status}: ${text}`);
    }
    if (response.status === 204) return undefined as unknown as T;

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) return undefined as unknown as T;

    return response.json() as Promise<T>;
  }

  private fabric<T>(path: string, options?: { method?: string; body?: unknown }): Promise<T> {
    return this.proxyRequest<T>('fabric', path, options);
  }

  private graph<T>(path: string, options?: { method?: string; body?: unknown }): Promise<T> {
    return this.proxyRequest<T>('graph', path, options);
  }

  async listWorkspaceItems(workspaceId: string): Promise<FabricItem[]> {
    const all: FabricItem[] = [];
    let path: string | null = `/workspaces/${workspaceId}/items`;

    while (path) {
      const data = await this.fabric<{ value: any[]; continuationUri?: string }>(path);
      for (const i of data.value ?? []) {
        // Exclude Governly's own workload items from the list
        if (typeof i.type === 'string' && i.type.startsWith('Org.Governly')) continue;
        all.push({
          id: i.id,
          type: i.type,
          displayName: i.displayName,
          workspaceId: i.workspaceId ?? workspaceId,
          sensitivity: i.sensitivityLabel?.sensitivityLabelId
            ? { labelId: i.sensitivityLabel.sensitivityLabelId.toLowerCase() }
            : undefined,
        });
      }
      // Extract path portion from continuationUri for the next proxy call
      if (data.continuationUri) {
        try {
          const u = new URL(data.continuationUri);
          path = u.pathname.replace(/^\/v1/, '') + u.search;
        } catch {
          path = null;
        }
      } else {
        path = null;
      }
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
    const entities = data.itemEntities ?? [];
    return {
      items: entities.map((i: any) => ({
        id: i.id,
        type: i.type,
        displayName: i.name ?? i.displayName ?? '(unnamed)',
        workspaceId: i.workspaceId,
        sensitivity: undefined as FabricItem['sensitivity'], // populated separately via enrichWithSensitivityLabels
      })),
      continuationToken: data.continuationToken,
    };
  }

  /** Fetch the applied sensitivity label for each item in parallel (batches of 10). */
  async enrichWithSensitivityLabels(items: FabricItem[]): Promise<FabricItem[]> {
    const BATCH = 10;
    const result: FabricItem[] = [...items];
    for (let i = 0; i < result.length; i += BATCH) {
      const batch = result.slice(i, i + BATCH);
      const labels = await Promise.all(
        batch.map(item =>
          this.fabric<any>(`/workspaces/${item.workspaceId}/items/${item.id}/sensitivityLabel`)
            .catch((_err: unknown) => null as any)
        )
      );
      labels.forEach((label, idx) => {
        if (label?.labelId) {
          result[i + idx] = {
            ...result[i + idx],
            sensitivity: {
              labelId: label.labelId.toLowerCase(),
              labelName: label.displayName ?? label.labelName,
            },
          };
        }
      });
    }
    return result;
  }

  async listWorkspaces(): Promise<Workspace[]> {
    const data = await this.fabric<{ workspaces: any[] }>('/admin/workspaces');
    return (data.workspaces ?? []).map((w) => ({ id: w.id, displayName: w.displayName }));
  }

  async listDomains(): Promise<Domain[]> {
    const data = await this.fabric<{ domains: any[] }>('/admin/domains');
    return (data.domains ?? []).map((d) => ({
      id: d.id,
      displayName: d.displayName,
      description: d.description,
      parentDomainId: d.parentDomainId,
    }));
  }

  async listLakehouses(workspaceId: string): Promise<Lakehouse[]> {
    const data = await this.fabric<{ value: any[] }>(`/workspaces/${workspaceId}/lakehouses`);
    return (data.value ?? []).map((l) => ({ id: l.id, displayName: l.displayName }));
  }

  async listLakehouseTables(workspaceId: string, lakehouseId: string): Promise<LakehouseTable[]> {
    const data = await this.fabric<{ data: any[] }>(
      `/workspaces/${workspaceId}/lakehouses/${lakehouseId}/tables`
    );
    return (data.data ?? []).map((t) => ({ name: t.name, type: t.type, format: t.format ?? '' }));
  }

  async listSensitivityLabels(): Promise<SensitivityLabel[]> {
    // /v1.0/security/informationProtection/sensitivityLabels requires SensitivityLabels.Read.All
    // (application permission) — works with the client credentials app token.
    const data = await this.graph<{ value: any[] }>(
      '/security/informationProtection/sensitivityLabels'
    );
    return (data.value ?? []).map((l) => ({
      id: l.id?.toLowerCase(),
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
          body: {
            items: batch,
            updateDetails: { sensitivityLabelId: labelId },
          },
        });
        const failed = res?.failedItems ?? [];
        result.failureCount += failed.length;
        result.successCount += batch.length - failed.length;
        result.failures.push(
          ...failed.map((f: any) => ({
            itemId: f.id,
            errorMessage: f.error?.message ?? 'Unknown error',
          }))
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
          body: { items: batch },
        });
        const failed = res?.failedItems ?? [];
        result.failureCount += failed.length;
        result.successCount += batch.length - failed.length;
        result.failures.push(
          ...failed.map((f: any) => ({
            itemId: f.id,
            errorMessage: f.error?.message ?? 'Unknown error',
          }))
        );
      } catch (e: any) {
        result.failureCount += batch.length;
        result.failures.push({ itemId: 'batch', errorMessage: e.message });
      }
    }
    return result;
  }

  /**
   * Apply or remove a label for every item in every workspace belonging to a domain.
   * Pass null as labelId to remove labels.
   */
  async updateDomainLabel(domainId: string, labelId: string | null): Promise<void> {
    const wsData = await this.fabric<{ workspaces: any[] }>(
      `/admin/domains/${domainId}/workspaces`
    );
    const workspaces: Workspace[] = (wsData.workspaces ?? []).map((w) => ({
      id: w.id,
      displayName: w.displayName,
    }));

    const allItems: Array<{ id: string; type: string }> = [];
    for (const ws of workspaces) {
      let token: string | undefined;
      do {
        const page = await this.listItems({ workspaceId: ws.id, continuationToken: token });
        allItems.push(...page.items.map((item) => ({ id: item.id, type: item.type })));
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
