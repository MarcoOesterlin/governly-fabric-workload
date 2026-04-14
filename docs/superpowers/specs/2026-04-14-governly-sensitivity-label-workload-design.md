# Governly — Fabric Sensitivity Label Workload

## Problem

Organizations using Microsoft Fabric need a centralized tool to bulk-apply Microsoft Purview sensitivity labels across their Fabric estate — domains, items (reports, lakehouses, notebooks, etc.), and lakehouse tables. Today this requires manual per-item labeling or custom scripts. Governly provides an enterprise-grade workload embedded directly inside the Fabric portal for governance teams to browse, select, and label Fabric assets in bulk.

## Approach

A true **Microsoft Fabric Workload** built with the Workload Development Kit (WDK):

- **Frontend**: React app using `@ms-fabric/workload-client` SDK + Fluent UI React v9, running inside Fabric's sandboxed iframe
- **Backend**: Node.js/Express (TypeScript) API service handling business logic, token exchange (OBO), and Fabric/Graph API calls
- **Authentication**: Seamless — the user is already logged into Fabric; the Fabric SDK provides `acquireAccessToken()` which gives the user's delegated token; the backend uses On-Behalf-Of (OBO) flow to call Fabric Admin and Graph APIs
- **No separate login page** — users interact with Governly directly from their Fabric workspace

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Microsoft Fabric Portal (user already authenticated)        │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Sandboxed <iframe>                                    │  │
│  │                                                        │  │
│  │  ┌──────────────────────────────────────────────────┐  │  │
│  │  │  Governly Frontend (React)                       │  │  │
│  │  │  • @ms-fabric/workload-client SDK                │  │  │
│  │  │  • Fluent UI React v9 components                 │  │  │
│  │  │  • Item editor for Governly workload items       │  │  │
│  │  │                                                  │  │  │
│  │  │  workloadClient.auth.acquireAccessToken()        │  │  │
│  │  │  → user's delegated token (automatic)            │  │  │
│  │  └───────────────────┬──────────────────────────────┘  │  │
│  └──────────────────────┼─────────────────────────────────┘  │
│                         │ Bearer token                       │
└─────────────────────────┼────────────────────────────────────┘
                          ▼
               ┌───────────────────────────┐       ┌────────────────────┐
               │  Governly Backend         │       │  Microsoft         │
               │  (Node.js/Express + TS)   │──OBO─▶│  Entra ID          │
               │                           │       └────────────────────┘
               │  1. Validate bearer token │              │
               │  2. OBO → Fabric API token│              │ OBO tokens
               │  3. OBO → Graph API token │              │
               │  4. Call Fabric Admin APIs │◀─────────────┘
               │  5. Call Graph APIs        │
               └────────────┬──────────────┘
                            │
                ┌───────────┼───────────┐
                ▼           ▼           ▼
         Fabric Admin   Fabric REST  MS Graph
         Labels API     Domains API  Labels API
```

## Authentication

### How It Works (No Login Required)

1. The user is already signed into the Fabric portal
2. When the Governly workload loads in the iframe, it calls `workloadClient.auth.acquireAccessToken()` from the Fabric SDK
3. This returns a delegated token scoped to Governly's app registration — no popup, no redirect
4. The frontend sends this token as a Bearer header to the Governly backend
5. The backend validates the token, then uses **On-Behalf-Of (OBO) flow** to exchange it for:
   - A Fabric Admin API token (scope: `https://api.fabric.microsoft.com/.default`)
   - A Graph API token (scope: `https://graph.microsoft.com/.default`)
6. The backend calls the Fabric/Graph APIs with these OBO tokens on behalf of the user

### Tenant Discovery

No `TENANTID` is needed in the environment. The `tid` claim from the user's token (received from the Fabric SDK) identifies the tenant. The backend extracts it and uses the tenant-specific authority for OBO token acquisition.

### Configuration & Secrets Management

**Production: Azure Key Vault** (required for deployed environments)

All secrets are stored in Azure Key Vault and retrieved at startup via `@azure/identity` + `@azure/keyvault-secrets`. The backend uses **DefaultAzureCredential**, which automatically works with:
- Managed Identity (when deployed to Azure App Service / Container Apps)
- Azure CLI credentials (when developing locally)

| Key Vault Secret | Purpose |
|---|---|
| `GovernlyClientId` | App registration client ID |
| `GovernlyClientSecret` | App registration client secret |
| `GovernlyAudience` | Application ID URI from app registration |

| Environment Variable (non-secret) | Purpose |
|---|---|
| `KEYVAULT_URL` | Key Vault URL, e.g. `https://governly-kv.vault.azure.net` |
| `WORKLOAD_NAME` | `Org.Governly` |
| `BACKEND_PORT` | Server port (default: `5000`) |
| `PUBLISHER_TENANT_ID` | Tenant ID for workload registration |

**Local development fallback: `.env` file** (optional, gitignored)

For local development convenience only, the backend falls back to a `.env` file if `KEYVAULT_URL` is not set:

```
# LOCAL DEV ONLY — do not use in production
CLIENTID=<app-registration-client-id>
CLIENTSECRET=<app-registration-client-secret>
WORKLOAD_NAME=Org.Governly
BACKEND_PORT=5000
PUBLISHER_TENANT_ID=<your-tenant-id>
AUDIENCE=<application-id-uri-from-script>
```

The backend config loader checks in this order:
1. If `KEYVAULT_URL` is set → fetch secrets from Key Vault
2. Otherwise → read from `.env` (local dev mode)

> **Note:** `TENANTID` for API calls is always extracted from the user's token `tid` claim at runtime — never stored in configuration.
> Run `scripts/CreateGovernlyApp.ps1` to generate the app registration and output all values for either Key Vault or `.env`.

### Required Entra ID App Registration Permissions

These are set automatically by `scripts/CreateGovernlyApp.ps1`:

**Power BI Service / Fabric (delegated)**
| Permission | Purpose |
|---|---|
| `Fabric.Extend` | Required for all Fabric workloads |
| `Workspace.Read.All` | List workspaces |
| `Item.Read.All` | Read Fabric items |
| `Item.ReadWrite.All` | Write Fabric items |
| `Lakehouse.Read.All` | List lakehouse tables |

**Microsoft Graph (delegated)**
| Permission | Purpose |
|---|---|
| `User.Read` | Read signed-in user profile |
| `InformationProtectionPolicy.Read` | List available sensitivity labels |

**Azure Storage (delegated)**
| Permission | Purpose |
|---|---|
| `user_impersonation` | Access lakehouse storage |

**Exposed scopes (on the app itself)**
| Scope | Purpose |
|---|---|
| `FabricWorkloadControl` | Fabric ↔ backend communication |
| `LabelPolicy.Read.All` | Read Governly items |
| `LabelPolicy.ReadWrite.All` | Read/write Governly items |

> **Note:** The Fabric Admin APIs (`/v1/admin/items/bulkSetLabels`, `/v1/admin/domains`) are gated by the user's **Fabric Administrator role**, not by OAuth scopes. The OBO token carries the user's identity — Fabric checks their admin role server-side.

### Multi-User Support

- **No sessions or cookies needed** — Fabric manages the user's session
- **Per-user permissions** — each user's OBO token carries their own Fabric RBAC permissions
- **Fabric enforces authorization** — non-admin users cannot perform admin-only operations (e.g., bulkSetLabels returns `InsufficientUsageRights`)

## Fabric APIs Used

### 1. List Tenant Items
```
GET https://api.fabric.microsoft.com/v1/admin/items
GET https://api.fabric.microsoft.com/v1/admin/items?workspaceId={id}&type={type}
```
- Paginated (10,000 per page with `continuationToken`)
- Supports filtering by workspace, capacity, type, state
- Rate limit: 200 requests/hour

### 2. Bulk Set Labels on Items
```
POST https://api.fabric.microsoft.com/v1/admin/items/bulkSetLabels
Body: { items: [{id, type}], labelId, assignmentMethod }
```
- Up to 2,000 items per request
- 25 requests/hour rate limit
- User must be Fabric Administrator with label in their policy
- Requires delegated user token (via OBO)

### 3. Bulk Remove Labels from Items
```
POST https://api.fabric.microsoft.com/v1/admin/items/bulkRemoveLabels
Body: { items: [{id, type}] }
```
- Same constraints as bulk set

### 4. List Domains
```
GET https://api.fabric.microsoft.com/v1/admin/domains?preview=false
```
- Returns all domains with `id`, `displayName`, `description`, `parentDomainId`, `defaultLabelId`

### 5. Update Domain (Set Default Label)
```
PATCH https://api.fabric.microsoft.com/v1/admin/domains/{domainId}?preview=false
Body: { defaultLabelId: "<label-uuid>" }
```
- Set `defaultLabelId` to `"00000000-0000-0000-0000-000000000000"` to remove

### 6. List Lakehouse Tables
```
GET https://api.fabric.microsoft.com/v1/workspaces/{workspaceId}/lakehouses/{lakehouseId}/tables
```
- Returns table name, type (Managed/External), format, location
- Paginated with `continuationToken`

### 7. List Available Sensitivity Labels (Microsoft Graph)
```
GET https://graph.microsoft.com/beta/security/informationProtection/sensitivityLabels
```
- Returns label id, name, description, color, sensitivity level, parent hierarchy
- Permission: `InformationProtectionPolicy.Read`

## Workload Frontend (React + Fabric SDK)

### Bootstrap & Initialization

The frontend follows the WDK pattern with two initialization modes:

- **UI mode**: Visible iframe rendering the Governly editor and pages
- **Worker mode**: Invisible iframe handling Fabric-initiated actions (e.g., "Create Governly Item")

```typescript
// index.ts
bootstrap({
  initializeWorker: (params) => import('./index.worker').then(({ initialize }) => initialize(params)),
  initializeUI: (params) => import('./index.ui').then(({ initialize }) => initialize(params)),
});
```

### Frontend Manifest

The frontend manifest (`Product.json`) defines how Governly appears in Fabric:

- Workload name: `Org.Governly`
- Item type: `Org.Governly.LabelPolicy` (a Governly labeling configuration)
- Create Hub entry: "Governly Label Policy" card under a "Governance" category
- Item editor: The main Governly UI for browsing and labeling

### Pages (rendered as item editor tabs/views)

#### 1. Dashboard (default view)
- Summary cards: total domains, total items, items without labels, items by label
- Quick-action buttons to jump to labeling workflows

#### 2. Domains Tab
- Table listing all domains with columns: Name, Description, Parent, Current Default Label
- Inline dropdown to select/change the default sensitivity label per domain
- Bulk select + "Set Label" action bar for multi-domain updates
- Confirmation dialog before applying changes

#### 3. Items Tab
- Filterable table: filter by workspace, item type, current label status
- Columns: Name, Type, Workspace, Last Updated, Current Label
- Multi-select checkboxes with "Select All" support
- Action bar: "Apply Label" (opens label picker), "Remove Label"
- Batch progress indicator showing success/failure per item
- Pagination controls (API returns up to 10,000 per page)

#### 4. Lakehouse Explorer Tab
- Two-panel layout:
  - Left: workspace selector → lakehouse selector (cascading dropdowns)
  - Right: table list for the selected lakehouse
- Table columns: Name, Type (Managed/External), Format
- Read-only view for v1 (column-level labeling deferred)

#### 5. Labels Reference Tab
- Read-only view of all available sensitivity labels in the tenant
- Shows hierarchy (parent/child), color, sensitivity level, description
- Used as a reference when deciding which label to apply

### Shared Components

- **LabelPicker**: Fluent UI `Combobox` or `Dropdown` populated from Graph API, showing label hierarchy
- **BulkActionBar**: Sticky bottom bar appearing when items are selected, showing count + action buttons
- **BatchProgressDialog**: Modal showing real-time progress of bulk operations (success/fail per item)
- **ConfirmationDialog**: Shown before any destructive or bulk operation

## Workload Backend (Node.js/Express + TypeScript)

### Responsibilities

1. **Token validation**: Validate bearer tokens from the frontend (issuer, audience, signature, lifetime)
2. **OBO token exchange**: Exchange the user's workload token for Fabric API / Graph API tokens using MSAL Node `ConfidentialClientApplication.acquireTokenOnBehalfOf()`
3. **Fabric API proxy**: Call Fabric Admin APIs (items, labels, domains) on behalf of the user
4. **Graph API proxy**: Call MS Graph for available sensitivity labels
5. **Rate limit management**: Queue and batch bulk operations, respect `Retry-After` headers
6. **Workload control plane**: Handle Fabric lifecycle events (create/read/update/delete workload items) via SubjectAndAppToken validation

### API Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/items` | List Fabric items (proxied with OBO token) |
| GET | `/api/domains` | List Fabric domains |
| PATCH | `/api/domains/:domainId` | Update domain default label |
| POST | `/api/labels/set` | Bulk set labels on items |
| POST | `/api/labels/remove` | Bulk remove labels from items |
| GET | `/api/labels` | List available sensitivity labels (Graph API) |
| GET | `/api/workspaces` | List workspaces |
| GET | `/api/lakehouses/:workspaceId/:lakehouseId/tables` | List lakehouse tables |
| POST | `/api/workload/create` | Fabric control plane: create item |
| GET | `/api/workload/:itemId` | Fabric control plane: read item |
| DELETE | `/api/workload/:itemId` | Fabric control plane: delete item |

## Rate Limit Handling

The Fabric Admin APIs have strict rate limits:
- `bulkSetLabels` / `bulkRemoveLabels`: 25 requests/hour, 2,000 items/request → max 50,000 items/hour
- `listItems`: 200 requests/hour

Strategy:
- Queue bulk operations and process in batches
- Show estimated time for large operations
- Respect `Retry-After` headers from 429 responses
- Display a progress bar with batch status

## Project Structure

```
governly-fabric-workload/
├── .env                              # Backend environment config
├── package.json                      # Monorepo root (workspaces)
├── tsconfig.base.json                # Shared TypeScript config
│
├── frontend/                         # Fabric Workload Frontend
│   ├── package.json
│   ├── tsconfig.json
│   ├── webpack.config.js             # Dev server on port 60006
│   ├── Package/                      # Workload manifest files
│   │   ├── Product.json              # Workload definition (name, icons, item types)
│   │   ├── Item.json                 # Item type definition (Org.Governly.LabelPolicy)
│   │   └── assets/                   # Icons and images
│   └── src/
│       ├── index.ts                  # Bootstrap (UI + Worker modes)
│       ├── index.ui.tsx              # UI mode initialization (React render)
│       ├── index.worker.ts           # Worker mode (action handlers)
│       ├── App.tsx                   # Route → component mapping
│       ├── controller/
│       │   ├── GovernlyController.ts # SDK + backend API orchestration
│       │   └── AuthController.ts     # acquireAccessToken wrapper
│       ├── components/
│       │   ├── editor/
│       │   │   └── GovernlyEditor.tsx    # Main item editor (tabbed UI)
│       │   ├── dashboard/
│       │   │   └── Dashboard.tsx
│       │   ├── domains/
│       │   │   └── DomainTable.tsx
│       │   ├── items/
│       │   │   └── ItemTable.tsx
│       │   ├── lakehouses/
│       │   │   └── TableList.tsx
│       │   ├── labels/
│       │   │   └── LabelsReference.tsx
│       │   └── shared/
│       │       ├── LabelPicker.tsx
│       │       ├── BulkActionBar.tsx
│       │       ├── BatchProgressDialog.tsx
│       │       └── ConfirmationDialog.tsx
│       ├── models/
│       │   ├── FabricTypes.ts        # Fabric API type definitions
│       │   └── GraphTypes.ts         # Graph API type definitions
│       └── hooks/
│           ├── useFabricItems.ts
│           ├── useDomains.ts
│           ├── useLabels.ts
│           └── useBulkOperation.ts
│
├── backend/                          # Workload Backend API
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts                  # Express server entry point
│       ├── config.ts                 # Config loader (Key Vault → .env fallback)
│       ├── middleware/
│       │   ├── auth.ts               # Token validation middleware
│       │   └── errorHandler.ts       # Global error handler
│       ├── services/
│       │   ├── AuthService.ts        # OBO token exchange via MSAL Node
│       │   ├── FabricService.ts      # Fabric Admin API client
│       │   ├── GraphService.ts       # Graph API client (sensitivity labels)
│       │   ├── LabelService.ts       # Bulk label operations with batching
│       │   └── WorkloadService.ts    # Fabric control plane handlers
│       ├── routes/
│       │   ├── items.ts
│       │   ├── domains.ts
│       │   ├── labels.ts
│       │   ├── lakehouses.ts
│       │   └── workload.ts           # Fabric control plane routes
│       └── types/
│           ├── fabric.ts
│           └── auth.ts
│
└── docs/
    └── superpowers/
        └── specs/
            └── 2026-04-14-governly-sensitivity-label-workload-design.md
```

## Dependencies

### Frontend
| Package | Purpose |
|---|---|
| `react`, `react-dom` | UI library |
| `@ms-fabric/workload-client` | Fabric Workload SDK (iframe bootstrap, auth, navigation) |
| `@fluentui/react-components` | Fluent UI v9 components |
| `@fluentui/react-icons` | Fluent icons |
| `webpack`, `webpack-cli`, `webpack-dev-server` | Dev server and bundling |
| `typescript`, `ts-loader` | TypeScript compilation |

### Backend
| Package | Purpose |
|---|---|
| `express` | HTTP server |
| `@azure/msal-node` | OBO token exchange (ConfidentialClientApplication) |
| `@azure/identity` | DefaultAzureCredential for Key Vault access |
| `@azure/keyvault-secrets` | Retrieve secrets from Azure Key Vault |
| `jsonwebtoken`, `jwks-rsa` | Token validation |
| `cors` | CORS for frontend ↔ backend |
| `dotenv` | Local dev fallback config |
| `typescript`, `tsx` | TypeScript runtime |

## Development Workflow

1. **Enable workload development** in Fabric Admin Portal (tenant setting)
2. **Enable Fabric Developer Mode** in user settings
3. **Start the frontend**: `cd frontend && npm start` → runs on `localhost:60006`
4. **Start the backend**: `cd backend && npm run dev` → runs on configured port
5. **Run DevGateway**: Connect local backend to Fabric workspace
6. **Open Fabric** → workspace → Create → "Governly Label Policy" → opens embedded editor

## Setup for New Organizations

When another organization wants to deploy Governly:

1. **Create an App Registration** in their Entra ID tenant
2. **Add API permissions** (delegated): Fabric `Tenant.ReadWrite.All`, `Lakehouse.Read.All`; Graph `InformationProtectionPolicy.Read`
3. **Create a client secret**
4. **Configure redirect URI** for the workload
5. **Admin consent** — tenant admin grants permissions
6. **Deploy the backend** (Azure App Service, container, etc.) with their .env values
7. **Register the workload** in their Fabric tenant via DevGateway or publish to Workload Hub
8. Users open Fabric → workspace → Create → "Governly Label Policy" → start labeling

## Deployment Guide

There are three deployment scenarios: local development, sharing with specific organizations, and publishing to all Fabric users.

### Scenario 1: Local Development (Your Own Workspace)

#### Prerequisites
- A Microsoft Fabric subscription with an **F or P SKU capacity** (trial capacities also work)
- **Admin permissions** on the Fabric workspace you'll develop in
- **Node.js** (v18+) and **npm** (v9+) installed
- The **DevGateway** tool downloaded from [Microsoft](https://go.microsoft.com/fwlink/?linkid=2272516) and extracted locally
- A **Global Administrator** or **Application Administrator** role in your Entra ID tenant (for app registration)

#### Step 1: Enable Workload Development in Fabric

1. Sign into [Microsoft Fabric](https://app.fabric.microsoft.com) as a **tenant admin**
2. Go to **Settings → Admin portal → Tenant settings**
3. Under **Additional workloads**, enable **"Workspace admins can develop partner workloads"**
   - Can be scoped to specific security groups if needed
4. Go to **Settings → Developer settings** and enable **"Fabric Developer Mode"**

#### Step 2: Create the Entra ID App Registration (via script)

Governly includes a PowerShell script (`scripts/CreateGovernlyApp.ps1`) based on the official WDK pattern. It automates all app registration setup in one command.

**Prerequisites:** [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) installed and on your PATH.

**Run the script:**
```powershell
cd scripts
.\CreateGovernlyApp.ps1 -tenantId "<your-tenant-id>"
```

The script will:
1. Sign you into Azure via `az login`
2. Create a multi-tenant Entra ID app registration named "Governly Workload"
3. Configure the **Application ID URI**: `api://localdevinstance/<tenantId>/Org.Governly/<random>`
4. Set the **Redirect URI**: `http://localhost:60006/close` (SPA)
5. **Expose API scopes**:
   - `FabricWorkloadControl` — for Fabric ↔ backend communication
   - `LabelPolicy.Read.All` — for reading Governly label policy items
   - `LabelPolicy.ReadWrite.All` — for reading/writing Governly label policy items
6. **Pre-authorize Fabric client apps** so users don't see extra consent prompts:
   - `871c010f-5e61-4fb1-83ac-98610a7e9110` (Fabric frontend)
   - `00000009-0000-0000-c000-000000000000` (Power BI Service / Fabric backend)
   - `d2450708-699c-41e3-8077-b0c8341509aa` (Fabric backend operations)
7. **Add API permissions** (delegated):
   - Power BI Service: `Fabric.Extend`, `Workspace.Read.All`, `Item.Read.All`, `Item.ReadWrite.All`, `Lakehouse.Read.All`
   - Microsoft Graph: `User.Read`, `InformationProtectionPolicy.Read`
   - Azure Storage: `user_impersonation`
8. Add the `idtyp` optional claim (for app-only token validation)
9. Generate a **client secret** (valid 180 days)

**Output — copy these values:**
```
ApplicationIdUri / Audience : api://localdevinstance/<tenantId>/Org.Governly/AbC
RedirectURI                 : http://localhost:60006/close
Application Id              : <guid>
Secret                      : <secret-value>
```

**Grant admin consent** (tenant admin must do this once):
The script prints a consent URL. Open it in a browser as a tenant admin:
```
https://login.microsoftonline.com/<tenantId>/adminconsent?client_id=<applicationId>
```

#### Step 3: Configure Governly

1. Clone the Governly repository:
   ```bash
   git clone https://github.com/<your-org>/governly-fabric-workload.git
   cd governly-fabric-workload
   ```

2. Create the `.env` file in the project root using the script's output (for local dev only):
   ```
   CLIENTID=<Application Id from script>
   CLIENTSECRET=<Client Secret from script>
   WORKLOAD_NAME=Org.Governly
   BACKEND_PORT=5000
   PUBLISHER_TENANT_ID=<your-tenant-id>
   AUDIENCE=<ApplicationIdUri from script>
   ```

   The `CreateGovernlyApp.ps1` script prints the exact `.env` block — just copy and paste it.

   > For production deployment, store `CLIENTID`, `CLIENTSECRET`, and `AUDIENCE` in Azure Key Vault instead. See the Deployment Guide Scenario 2.

#### Step 4: Run Governly Locally

You need **three terminal windows** running simultaneously:

**Terminal 1 — Frontend** (serves the workload UI at `localhost:60006`):
```bash
cd frontend
npm install
npm start
```
Verify: open `http://localhost:60006/manifests` — you should see the workload manifest JSON.

**Terminal 2 — Backend** (serves the API):
```bash
cd backend
npm install
npm run dev
```
Verify: the backend starts on the configured port (default 5000).

**Terminal 3 — DevGateway** (bridges your local machine to Fabric):

1. Create `workload-dev-mode.json`:
   ```json
   {
     "WorkspaceGuid": "<your-fabric-workspace-id>",
     "ManifestPackageFilePath": "<path-to-generated-manifest-package>"
   }
   ```
2. Run:
   ```bash
   .\Microsoft.Fabric.Workload.DevGateway.exe
   ```
   Wait for the message: `info: DevGateway started`.

#### Step 5: Use Governly in Fabric

1. Open [Microsoft Fabric](https://app.fabric.microsoft.com)
2. Navigate to your development workspace
3. Click **+ New item**
4. Under the Governly section, select **"Governly Label Policy"**
5. The Governly editor opens inside Fabric — browse items, domains, and apply labels

---

### Scenario 2: Share With Specific Organizations (Preview Audience)

Once Governly works locally, you can share it with up to 10 other Fabric tenants for testing.

#### Step 1: Register Your Workload

1. Fill out the [Workload Registration Form](https://aka.ms/fabric_workload_registration) with:
   - **Publisher tenant**: Your production Fabric tenant ID
   - **Workload ID**: `Org.Governly` (this cannot be changed later)
2. Wait for Microsoft to approve the registration

#### Step 2: Host the Backend

Deploy the Governly backend to a publicly accessible endpoint:

- **Azure App Service** (recommended): Deploy the Node.js/Express app
- **Azure Container Apps**: Deploy as a Docker container
- **Any cloud provider**: As long as it's HTTPS and accessible from Fabric

**Secrets configuration:**
1. Create an Azure Key Vault (e.g. `governly-kv`)
2. Store the app registration secrets: `GovernlyClientId`, `GovernlyClientSecret`, `GovernlyAudience`
3. Enable **Managed Identity** on the App Service / Container App
4. Grant the managed identity `Key Vault Secrets User` role on the Key Vault
5. Set the `KEYVAULT_URL` environment variable in the hosting platform (e.g. `https://governly-kv.vault.azure.net`)

Update the workload manifest to point to the production backend URL instead of `localhost`.

#### Step 3: Upload the Workload Manifest

1. Build the manifest NuGet package (includes frontend manifests + backend manifest)
2. Upload it via the Fabric Admin Portal → **Manage workloads**

#### Step 4: Add Preview Tenants

1. In the Fabric Admin Portal, add up to **10 tenant IDs** to the preview audience
2. Each target tenant's admin must enable the workload in their **Tenant settings → Additional workloads**
3. Users in those tenants can now find Governly in their workspace's **+ New item** menu

#### What Each Target Organization Needs to Do

The target organization does **NOT** need to:
- ❌ Clone the Governly repo
- ❌ Run any code locally
- ❌ Create their own app registration (your app registration handles multi-tenant auth)

The target organization **DOES** need to:
- ✅ Have a Fabric tenant with F or P SKU capacity
- ✅ Have their tenant admin enable the Governly workload in tenant settings
- ✅ Have their tenant admin grant consent to the Governly app (one-time popup)
- ✅ Users must be Fabric Administrators to use bulk label operations

---

### Scenario 3: Publish to All Fabric Users (Workload Hub)

This makes Governly available to every Fabric customer worldwide.

1. Ensure Governly meets the [Workload Publishing Requirements](https://learn.microsoft.com/en-us/fabric/workload-development-kit/publish-workload-requirements)
2. Submit the [Publishing Request Form](https://aka.ms/fabric_workload_publishing)
3. Microsoft validates your workload against their certification requirements
4. Once approved, Governly appears in the **Workload Hub** for all Fabric tenants
5. Users can browse, trial, and add Governly from the hub

---

### Multi-Tenant App Registration (for Scenarios 2 & 3)

When sharing beyond your own tenant, update the app registration:

1. Change **Supported account types** to "Accounts in any organizational directory" (multi-tenant)
2. The `AUDIENCE` URI changes from `api://localdevinstance/...` to a production URI:
   ```
   api://<your-domain>/Org.Governly
   ```
3. Update redirect URIs to your production frontend URL
4. Each organization's admin will see a consent popup on first use — no manual setup required

## Deferred (Out of Scope for v1)

- Column-level sensitivity labels on lakehouse tables (requires Purview Data Map or future Fabric API)
- Audit logging / operation history
- Scheduled/automated label application
- Role-based access within Governly itself
- Publishing to Fabric Workload Hub (requires Microsoft certification)
