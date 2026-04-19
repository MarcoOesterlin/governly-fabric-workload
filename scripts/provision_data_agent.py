"""
Governly – Data Agent Provisioner
==================================
This script is designed to run inside a Microsoft Fabric Notebook (PySpark environment).
It creates a Fabric Data Agent and attaches all supported data sources in the workspace.

Usage:
  1. Open this notebook in a Fabric workspace.
  2. Run all cells (Run All).
  3. The Data Agent "Governly Data Agent" will be created and published.

Note: This script cannot run locally – it requires the Fabric Spark environment
      provided by Fabric notebooks. The `fabric-data-agent-sdk` only works there.
"""

# ── Cell 1: Install SDK ────────────────────────────────────────────────────────
# CELL ********************
# %pip install fabric-data-agent-sdk

# ── Cell 2: Imports & workspace context ───────────────────────────────────────
# CELL ********************
import notebookutils as nu
import requests
from fabric.dataagent.client import create_data_agent, FabricDataAgentManagement

# Get the current workspace ID from the notebook context
workspace_id = notebookutils.fabric.getWorkspaceId()
AGENT_NAME = "Governly Data Agent"

print(f"Workspace ID : {workspace_id}")
print(f"Agent name   : {AGENT_NAME}")

# ── Cell 3: Create or connect to existing Data Agent ──────────────────────────
# CELL ********************
try:
    agent = FabricDataAgentManagement(AGENT_NAME)
    print(f"Connected to existing Data Agent: {AGENT_NAME}")
except Exception:
    agent = create_data_agent(AGENT_NAME)
    print(f"Created new Data Agent: {AGENT_NAME}")

agent.update_configuration(
    instructions=(
        "You are a data analyst assistant for this Microsoft Fabric workspace. "
        "Help users understand, query, and analyze their data across all available "
        "data sources. Provide accurate, data-driven insights based on workspace data."
    )
)
print("AI instructions configured")

# ── Cell 4: List workspace items ───────────────────────────────────────────────
# CELL ********************
token = notebookutils.credentials.getToken("https://api.fabric.microsoft.com")
headers = {"Authorization": f"Bearer {token}"}

response = requests.get(
    f"https://api.fabric.microsoft.com/v1/workspaces/{workspace_id}/items",
    headers=headers,
)
response.raise_for_status()
workspace_items = response.json().get("value", [])
print(f"Found {len(workspace_items)} items in workspace")

# ── Cell 5: Add data sources ──────────────────────────────────────────────────
# CELL ********************
# Mapping from Fabric item type to Data Agent datasource type
DATASOURCE_TYPE_MAP = {
    "Lakehouse":    "lakehouse",
    "Warehouse":    "warehouse",
    "KQLDatabase":  "kqldatabase",
    "SemanticModel": "semanticmodel",
}

added = skipped = errors = 0
for item in workspace_items:
    item_type = item.get("type", "")
    item_name = item.get("displayName", "")
    ds_type = DATASOURCE_TYPE_MAP.get(item_type)

    if not ds_type:
        skipped += 1
        continue

    try:
        agent.add_datasource(item_name, type=ds_type)
        print(f"  ✓ {item_type}: {item_name}")
        added += 1
    except Exception as e:
        print(f"  ✗ {item_type} '{item_name}': {e}")
        errors += 1

print(f"\nResults: {added} added, {skipped} skipped, {errors} errors")

# ── Cell 6: Publish ────────────────────────────────────────────────────────────
# CELL ********************
agent.publish()
print(f"\n✅ Data Agent '{AGENT_NAME}' is published and ready!")
print("You can now use it in Fabric to query your data using natural language.")
