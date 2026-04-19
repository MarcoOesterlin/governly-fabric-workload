# Data Agent Label Suggestions — Design Spec

## Problem

Workspace items in Governly need sensitivity labels applied manually. The Fabric Data Agent already has access to the workspace's data sources (lakehouses, warehouses) and can query their contents via NL2SQL. We want the Data Agent to examine the actual data and suggest appropriate sensitivity labels for each item, which the user can review and apply.

## Approach

Use the existing provisioned Fabric Data Agent's OpenAI-compatible Assistants API to send a structured prompt containing workspace items and available labels. The agent queries the data sources, analyzes content, and returns a JSON array of label suggestions. These suggestions are staged as pending changes in the existing ItemsView UI.

## Components

### 1. Updated Data Agent Instructions (`aiInstructions`)

Replace the current generic instructions in `devServer/dataAgentProvisioner.js` with governance-focused instructions:

```
You are a data governance assistant for the Governly platform.
Your primary role is to help classify workspace items by examining their data
and suggesting appropriate Microsoft Purview sensitivity labels.

When asked to suggest labels:
1. Query the available data sources to understand what data they contain
2. Look for indicators of sensitivity: personal information (names, emails, SSNs,
   addresses), financial data (transactions, revenue, pricing), health data,
   proprietary business logic, or public reference data
3. Consider the data source name and context as additional signals
4. Always respond with valid JSON when asked for structured output

Classification principles:
- Items containing PII or health data → highest sensitivity labels
- Items with financial/business data → confidential labels
- Items with internal operational data → general/internal labels
- Items with public reference data → lowest sensitivity labels
- Non-data items (notebooks, pipelines) → classify based on what data they process
```

### 2. Auto-Publish During Provisioning

Add a publish step after creating/updating the Data Agent:

- After the agent is created/updated, call the Fabric publish API (or verify published stage files make the agent queryable)
- Retrieve and store the published URL from `GET /workspaces/{wsId}/dataAgents/{agentId}` properties
- Return `publishedUrl` alongside `agentId` in the provision response

File: `devServer/dataAgentProvisioner.js`

### 3. Backend Endpoint: `/api/suggest-labels`

New Express route in `devServer/webpack.dev.js` → handler in new file `devServer/labelSuggester.js`.

**Request:**
```json
{
  "workspaceId": "uuid",
  "items": [{ "id": "uuid", "displayName": "string", "type": "string" }],
  "labels": [{ "id": "uuid", "name": "string", "description": "string", "sensitivity": 0 }]
}
```

**Flow:**
1. Get Fabric token (Azure CLI)
2. Find the "Governly Data Agent" in the workspace
3. Get the agent's published URL
4. Construct the structured prompt (see below)
5. Query via OpenAI Assistants protocol:
   - `POST /assistants` → create assistant
   - `POST /threads` → create thread
   - `POST /threads/{threadId}/messages` → post prompt
   - `POST /threads/{threadId}/runs` → start run
   - Poll `GET /threads/{threadId}/runs/{runId}` until complete
   - `GET /threads/{threadId}/messages` → get response
   - `DELETE /threads/{threadId}` → cleanup
6. Parse JSON from response text
7. Return suggestions

**Response:**
```json
{
  "suggestions": [
    { "itemId": "uuid", "suggestedLabelId": "uuid", "reason": "Contains PII (customer names, emails)" }
  ]
}
```

**Timeout:** 5 minutes max polling. Return partial results or error if exceeded.

### 4. Structured Prompt

```
I need you to suggest sensitivity labels for workspace items.
Examine the data in available sources to understand what they contain.

Available sensitivity labels (ordered by sensitivity, lowest to highest):
{{#each labels}}
- "{{name}}" (id: {{id}}) — {{description}} [sensitivity: {{sensitivity}}]
{{/each}}

Workspace items to classify:
{{#each items}}
- "{{displayName}}" (type: {{type}}, id: {{id}})
{{/each}}

For data items (Lakehouse, Warehouse, KQL Database), query the actual tables
to understand what data they contain before suggesting a label.
For non-data items (Notebook, Pipeline, Report), suggest based on the item name
and type context.

Respond ONLY with a JSON array, no other text:
[{"itemId": "<item id>", "suggestedLabelId": "<label id>", "reason": "<brief explanation>"}]
```

### 5. Frontend: `GovernlyApiClient.suggestLabels()`

New method in `app/clients/GovernlyApiClient.ts`:

```typescript
interface LabelSuggestion {
  itemId: string;
  suggestedLabelId: string;
  reason: string;
}

async suggestLabels(
  workspaceId: string,
  items: FabricItem[],
  labels: SensitivityLabel[]
): Promise<LabelSuggestion[]>
```

Calls `POST /api/suggest-labels`.

### 6. Frontend: "Suggest Labels" Button in ItemsView

Location: `app/items/ClassifierItem/views/ItemsView.tsx`

- Add a "Suggest Labels" button in the toolbar (next to Apply/Discard)
- Uses `Sparkle24Regular` icon from Fluent
- Loading state: "Analyzing workspace data…" with spinner
- On success:
  - Stage each suggestion as a pending change via existing `stageChange()` 
  - Show a summary MessageBar: "Suggested labels for X items. Review and click Apply."
- On error: show error MessageBar
- Button disabled while loading or if no labels/items available

### 7. "Suggested" Column (Optional Enhancement)

Add a "Suggested" column to the DataGrid showing the reason from the Data Agent. This helps the user understand why a label was suggested before deciding to apply it. Shows the reason text or a tooltip on the staged change indicator.

## Data Flow

```
User clicks "Suggest Labels"
  → Frontend sends items + labels to POST /api/suggest-labels
  → Dev server finds Data Agent, gets published URL
  → Dev server sends prompt via Assistants API
  → Data Agent queries lakehouses/warehouses via NL2SQL
  → Data Agent returns JSON suggestions
  → Dev server parses and returns to frontend
  → Frontend stages suggestions as pending changes
  → User reviews in "Change Label" dropdowns
  → User clicks "Apply" to write labels to Fabric
```

## Error Handling

- **Agent not found**: Show error "Data Agent not provisioned. Click Create Data Agent first."
- **Agent not published**: Attempt auto-publish; if fails, show error with instructions
- **Query timeout**: Show "Analysis timed out. Try again or suggest labels manually."
- **Malformed response**: Show warning "Could not parse suggestions. The agent may need more data."
- **Partial results**: If agent returns suggestions for only some items, stage those and note the rest

## Files Changed

| File | Change |
|------|--------|
| `devServer/dataAgentProvisioner.js` | Update `aiInstructions`, add auto-publish step |
| `devServer/labelSuggester.js` | **New** — Data Agent query logic via Assistants API |
| `devServer/webpack.dev.js` | Mount `/api/suggest-labels` route |
| `app/clients/GovernlyApiClient.ts` | Add `LabelSuggestion` interface + `suggestLabels()` method |
| `app/items/ClassifierItem/views/ItemsView.tsx` | Add "Suggest Labels" button, staging logic, summary bar |
