export interface FabricItem {
  id: string;
  type: string;
  displayName: string;
  workspaceId: string;
  sensitivity?: {
    labelId: string;
    labelName?: string;
  };
}

export interface FabricItemsPage {
  items: FabricItem[];
  continuationToken?: string;
}

export interface FabricDomain {
  id: string;
  displayName: string;
  description?: string;
  parentDomainId?: string;
  defaultLabelId?: string;
}

export interface BulkLabelRequest {
  items: Array<{ id: string; type: string }>;
  labelId: string;
  assignmentMethod?: 'Standard' | 'Privileged';
}

export interface BulkRemoveRequest {
  items: Array<{ id: string; type: string }>;
}

export interface BulkOperationResult {
  successCount: number;
  failureCount: number;
  failures: Array<{ itemId: string; errorMessage: string }>;
}

export interface LakehouseTable {
  name: string;
  type: 'Managed' | 'External';
  format: string;
  location?: string;
}
