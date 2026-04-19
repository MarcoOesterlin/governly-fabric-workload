/**
 * Data Agent Provisioner
 *
 * Creates a Fabric Data Agent directly via the Fabric REST API.
 * Discovers all workspace data sources (Lakehouses, Warehouses,
 * KQL Databases, SQL Databases), fetches their tables, and includes
 * them in the agent definition so the agent can query them immediately.
 */

const https  = require('https');
const crypto = require('crypto');

const FABRIC_API = 'https://api.fabric.microsoft.com/v1';

// ── Minimal HTTPS client ──────────────────────────────────────────────────────

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const reqOptions = {
      hostname: parsedUrl.hostname,
      port:     parsedUrl.port || 443,
      path:     parsedUrl.pathname + (parsedUrl.search || ''),
      method:   options.method || 'GET',
      headers:  options.headers || {},
    };

    const req = https.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status:  res.statusCode,
          ok:      res.statusCode >= 200 && res.statusCode < 300,
          headers: res.headers,
          body:    Buffer.concat(chunks).toString(),
        });
      });
    });

    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ── LRO helpers ───────────────────────────────────────────────────────────────

async function pollOperation(token, operationId, maxWaitMs = 120_000) {
  const start   = Date.now();
  const pollUrl = `${FABRIC_API}/operations/${operationId}`;

  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 3000));

    const resp = await httpRequest(pollUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok) {
      throw new Error(`Operation poll failed (${resp.status}): ${resp.body.slice(0, 200)}`);
    }

    const data = JSON.parse(resp.body);
    console.log(`[DataAgent] Operation ${operationId}: ${data.status}`);

    if (data.status === 'Succeeded') return data;
    if (data.status === 'Failed') {
      throw new Error(`Operation failed: ${JSON.stringify(data.error ?? data).slice(0, 300)}`);
    }
  }

  throw new Error(`Operation timed out after ${maxWaitMs / 1000}s`);
}

async function getOperationResult(token, operationId) {
  const url  = `${FABRIC_API}/operations/${operationId}/result`;
  const resp = await httpRequest(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) {
    throw new Error(`Get operation result failed (${resp.status}): ${resp.body.slice(0, 200)}`);
  }
  return JSON.parse(resp.body);
}

// ── Table / element discovery ─────────────────────────────────────────────────

/** Fetches all tables from a Lakehouse.
 *  Tries the REST API first; if the lakehouse has schemas enabled (400),
 *  falls back to OneLake DFS to enumerate table directories.
 */
async function fetchLakehouseTables(token, workspaceId, lakehouseId) {
  // 1) Try the standard REST API
  const restUrl = `${FABRIC_API}/workspaces/${workspaceId}/lakehouses/${lakehouseId}/tables`;
  try {
    const resp = await httpRequest(restUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (resp.ok) {
      const tables = [];
      const data = JSON.parse(resp.body);
      tables.push(...(data.data ?? []));
      let nextUrl = data.continuationUri ?? null;
      while (nextUrl) {
        const nextResp = await httpRequest(nextUrl, { headers: { Authorization: `Bearer ${token}` } });
        if (!nextResp.ok) break;
        const nextData = JSON.parse(nextResp.body);
        tables.push(...(nextData.data ?? []));
        nextUrl = nextData.continuationUri ?? null;
      }
      return tables;
    }
    console.log(`[DataAgent] REST tables API returned ${resp.status} — trying OneLake DFS fallback`);
  } catch (e) {
    console.warn(`[DataAgent] REST tables API error: ${e.message}`);
  }

  // 2) Fallback: enumerate schemas + tables via OneLake DFS (schema-enabled lakehouses)
  const tables = [];
  const storageToken = await getOneLakeToken(token);

  // First, list all schemas under Tables/
  const schemasUrl = `https://onelake.dfs.fabric.microsoft.com/${workspaceId}/${lakehouseId}/Tables?resource=filesystem&recursive=false`;
  let schemas = [];
  try {
    const schemaResp = await httpRequest(schemasUrl, { headers: { Authorization: `Bearer ${storageToken}` } });
    if (schemaResp.ok) {
      const schemaPaths = JSON.parse(schemaResp.body).paths ?? [];
      schemas = schemaPaths
        .filter(p => p.isDirectory === 'true')
        .map(p => p.name.split('/').pop());
      console.log(`[DataAgent] Discovered schemas: ${JSON.stringify(schemas)}`);
    } else {
      console.log(`[DataAgent] OneLake DFS Tables/ returned ${schemaResp.status} — defaulting to dbo`);
      schemas = ['dbo'];
    }
  } catch (e) {
    console.warn(`[DataAgent] OneLake DFS schema discovery error: ${e.message}`);
    schemas = ['dbo'];
  }

  if (schemas.length === 0) schemas = ['dbo'];

  // Then, list tables within each schema
  for (const schema of schemas) {
    const dfsUrl = `https://onelake.dfs.fabric.microsoft.com/${workspaceId}/${lakehouseId}/Tables/${schema}?resource=filesystem&recursive=false`;
    try {
      const resp = await httpRequest(dfsUrl, { headers: { Authorization: `Bearer ${storageToken}` } });
      if (!resp.ok) {
        console.log(`[DataAgent] OneLake DFS ${schema}/ returned ${resp.status}`);
        continue;
      }
      const paths = JSON.parse(resp.body).paths ?? [];
      for (const p of paths) {
        if (p.isDirectory === 'true') {
          const name = p.name.split('/').pop();
          tables.push({ name, type: 'Managed', schema });
        }
      }
      console.log(`[DataAgent] Schema "${schema}": ${paths.filter(p => p.isDirectory === 'true').length} table(s)`);
    } catch (e) {
      console.warn(`[DataAgent] OneLake DFS error for ${schema}/: ${e.message}`);
    }
  }
  return tables;
}

/** Get a storage-scoped token for OneLake DFS. Uses the same Azure CLI approach. */
async function getOneLakeToken(fabricToken) {
  // The dev server uses Azure CLI tokens — fetch one scoped to storage.azure.com
  const { execSync } = require('child_process');
  try {
    return execSync('az account get-access-token --resource https://storage.azure.com --query accessToken -o tsv', { encoding: 'utf8' }).trim();
  } catch (e) {
    console.warn(`[DataAgent] Could not get OneLake token: ${e.message}`);
    return fabricToken; // fallback (may not work for DFS)
  }
}

/**
 * Builds the `elements` array for a datasource.json.
 * Lakehouses: real table elements fetched from the API.
 * Warehouses:  a pre-selected dbo schema placeholder.
 * KQL/SQL:     no sub-elements (top-level is_selected covers them).
 */
function buildElements(fabricType, tables) {
  if (fabricType === 'Lakehouse') {
    // Group tables by schema (schema-enabled lakehouses need the schema intermediary)
    const bySchema = {};
    for (const t of tables) {
      const schema = t.schema || 'dbo';
      (bySchema[schema] ??= []).push(t);
    }

    const schemaChildren = Object.entries(bySchema).map(([schema, schemaTables]) => {
      const tableElements = schemaTables.map(t => ({
        id:           crypto.randomUUID(),
        display_name: t.name,
        type:         'lakehouse_tables.table',
        is_selected:  true,
      }));
      return {
        id:           crypto.randomUUID(),
        display_name: schema,
        type:         'lakehouse_tables.schema',
        is_selected:  true,
        children:     tableElements,
      };
    });

    // If no tables discovered, still include dbo schema placeholder
    if (schemaChildren.length === 0) {
      schemaChildren.push({
        id:           crypto.randomUUID(),
        display_name: 'dbo',
        type:         'lakehouse_tables.schema',
        is_selected:  true,
      });
    }

    return [
      {
        id:           crypto.randomUUID(),
        display_name: 'Tables',
        type:         'lakehouse_tables',
        is_selected:  true,
        children:     schemaChildren,
      },
      {
        id:           crypto.randomUUID(),
        display_name: 'Files',
        type:         'lakehouse_files',
        is_selected:  true,
      },
    ];
  }

  if (fabricType === 'Warehouse') {
    // Include a pre-selected dbo schema so the agent can see all warehouse tables
    return [{
      id:           crypto.randomUUID(),
      display_name: 'dbo',
      type:         'warehouse_tables.schema',
      is_selected:  true,
    }];
  }

  // KQL and SQL databases: no child elements needed; the top-level selection suffices
  return [];
}

// ── Data Agent definition builders ───────────────────────────────────────────

// Maps Fabric item types → Data Agent type strings and folder prefixes
const SOURCE_MAP = {
  Lakehouse:   { agentType: 'lakehouse_tables', folder: 'lakehouse' },
  Warehouse:   { agentType: 'data_warehouse',   folder: 'datawarehouse' },
  KQLDatabase: { agentType: 'kusto',            folder: 'kusto' },
  SQLDatabase: { agentType: 'mirrored_database', folder: 'sqldatabase' },
};

function b64(obj) {
  return Buffer.from(JSON.stringify(obj, null, 2)).toString('base64');
}

function buildDefinitionParts(instructions, sources) {
  const parts = [
    {
      path:        'Files/Config/data_agent.json',
      payload:     b64({ '$schema': '2.1.0' }),
      payloadType: 'InlineBase64',
    },
    {
      path:        'Files/Config/draft/stage_config.json',
      payload:     b64({ '$schema': '1.0.0', aiInstructions: instructions }),
      payloadType: 'InlineBase64',
    },
    {
      path:        'Files/Config/published/stage_config.json',
      payload:     b64({ '$schema': '1.0.0', aiInstructions: instructions }),
      payloadType: 'InlineBase64',
    },
    {
      path:        'Files/Config/publish_info.json',
      payload:     b64({ '$schema': '1.0.0', description: 'Governly Data Agent' }),
      payloadType: 'InlineBase64',
    },
  ];

  for (const src of sources) {
    const map = SOURCE_MAP[src.fabricType];
    if (!map) continue;
    const folder     = `${map.folder}-${src.displayName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    const dsPayload  = b64({
      '$schema':    '1.0.0',
      artifactId:   src.id,
      workspaceId:  src.workspaceId,
      type:         map.agentType,
      displayName:  src.displayName,
      elements:     src.elements ?? [],
    });
    const shotsPayload = b64({ '$schema': '1.0.0', fewShots: [] });

    for (const stage of ['draft', 'published']) {
      parts.push(
        { path: `Files/Config/${stage}/${folder}/datasource.json`, payload: dsPayload,    payloadType: 'InlineBase64' },
        { path: `Files/Config/${stage}/${folder}/fewshots.json`,   payload: shotsPayload, payloadType: 'InlineBase64' }
      );
    }
  }

  return parts;
}

// ── Main provisioner ──────────────────────────────────────────────────────────

/**
 * Creates a Fabric Data Agent directly via REST API (no notebook/Spark needed).
 *
 * @param {string} token          - Fabric API Bearer token
 * @param {string} workspaceId    - Target workspace ID
 * @param {string} instanceName   - Governly instance display name
 * @returns {{ agentId, agentName, agentUrl, message }}
 */
async function provisionDataAgent(token, workspaceId, instanceName) {
  const agentName = 'Governly Data Agent';
  const authHeaders = (body) => ({
    Authorization:    `Bearer ${token}`,
    'Content-Type':   'application/json',
    'Content-Length': String(Buffer.byteLength(body)),
  });

  console.log(`[DataAgent] Provisioning for workspace ${workspaceId}`);

  // ── Check if agent already exists ─────────────────────────────────────────
  const listResp = await httpRequest(
    `${FABRIC_API}/workspaces/${workspaceId}/dataAgents`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  let agentId = null;

  if (listResp.ok) {
    const agents = JSON.parse(listResp.body).value ?? [];
    console.log(`[DataAgent] Existing agents: ${JSON.stringify(agents.map(a => ({ id: a.id, name: a.displayName, type: a.type })))}`);
    const existing = agents.find(a => a.displayName === agentName);
    if (existing) {
      agentId = existing.id;
      console.log(`[DataAgent] Full existing agent object: ${JSON.stringify(existing)}`);
    }
  } else {
    console.log(`[DataAgent] List agents response ${listResp.status}: ${listResp.body.slice(0, 300)}`);
  }

  // ── Discover workspace data sources (in parallel) ─────────────────────────
  const sourceTypeConfigs = [
    { fabricType: 'Lakehouse',   endpoint: 'lakehouses'   },
    { fabricType: 'Warehouse',   endpoint: 'warehouses'   },
    { fabricType: 'KQLDatabase', endpoint: 'kqlDatabases' },
    { fabricType: 'SQLDatabase', endpoint: 'sqlDatabases' },
  ];

  const sources = (await Promise.all(
    sourceTypeConfigs.map(async ({ fabricType, endpoint }) => {
      try {
        const resp = await httpRequest(
          `${FABRIC_API}/workspaces/${workspaceId}/${endpoint}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!resp.ok) {
          console.log(`[DataAgent] ${fabricType} list returned ${resp.status} (skipped)`);
          return [];
        }
        const items = JSON.parse(resp.body).value ?? [];
        console.log(`[DataAgent] ${fabricType} list: ${items.map(i => `${i.id}|${i.displayName}`).join(', ')}`);
        return await Promise.all(items.map(async (i) => {
          const src = { fabricType, id: i.id, displayName: i.displayName, workspaceId, elements: [] };

          // Fetch tables for lakehouses so we can select them in the definition
          if (fabricType === 'Lakehouse') {
            const tables = await fetchLakehouseTables(token, workspaceId, i.id);
            console.log(`[DataAgent] Lakehouse "${i.displayName}": ${tables.length} table(s)`);
            src.elements = buildElements('Lakehouse', tables);
          } else {
            console.log(`[DataAgent] Found ${fabricType}: "${i.displayName}" (${i.id})`);
            src.elements = buildElements(fabricType, []);
          }
          return src;
        }));
      } catch (e) {
        console.warn(`[DataAgent] Failed to list ${fabricType}: ${e.message}`);
        return [];
      }
    })
  )).flat();

  console.log(`[DataAgent] Total data sources found: ${sources.length}`);
  sources.forEach(s => {
    console.log(`[DataAgent]   ${s.fabricType} "${s.displayName}": ${s.elements.length} top-level elements`);
    console.log(`[DataAgent]   Elements: ${JSON.stringify(s.elements).slice(0, 500)}`);
  });

  const instructions =
    'You are a data governance assistant for the Governly platform. ' +
    'Your primary role is to help classify workspace items by examining their data ' +
    'and suggesting appropriate Microsoft Purview sensitivity labels.\n\n' +
    'When asked to suggest labels:\n' +
    '1. Query the available data sources to understand what data they contain\n' +
    '2. Look for indicators of sensitivity: personal information (names, emails, SSNs, ' +
    'addresses), financial data (transactions, revenue, pricing), health data, ' +
    'proprietary business logic, or public reference data\n' +
    '3. Consider the data source name and context as additional signals\n' +
    '4. Always respond with valid JSON when asked for structured output\n\n' +
    'Classification principles:\n' +
    '- Items containing PII or health data → highest sensitivity labels\n' +
    '- Items with financial/business data → confidential labels\n' +
    '- Items with internal operational data → general/internal labels\n' +
    '- Items with public reference data → lowest sensitivity labels\n' +
    '- Non-data items (notebooks, pipelines) → classify based on what data they process';

  const definitionParts = buildDefinitionParts(instructions, sources);
  console.log(`[DataAgent] Definition has ${definitionParts.length} parts`);

  // ── Create or update agent ─────────────────────────────────────────────────
  if (!agentId) {
    const createBody = JSON.stringify({
      displayName: agentName,
      description: 'Governly data governance AI agent',
      definition:  { parts: definitionParts },
    });
    console.log(`[DataAgent] Creating Data Agent "${agentName}" with ${sources.length} sources...`);

    const createResp = await httpRequest(
      `${FABRIC_API}/workspaces/${workspaceId}/dataAgents`,
      { method: 'POST', headers: authHeaders(createBody), body: createBody }
    );

    console.log(`[DataAgent] Create response ${createResp.status}: ${createResp.body.slice(0, 1000)}`);

    if (createResp.status === 201) {
      agentId = JSON.parse(createResp.body).id;
    } else if (createResp.status === 202) {
      const location = createResp.headers['location'] || createResp.headers['Location'] || '';
      const opMatch  = location.match(/\/operations\/([^/?]+)/i);
      if (!opMatch) throw new Error(`Unexpected Location header: ${location}`);
      const opResult = await pollOperation(token, opMatch[1]);
      const itemResult = await getOperationResult(token, opMatch[1]);
      agentId = itemResult.id;
    } else {
      throw new Error(`Failed to create Data Agent (${createResp.status}): ${createResp.body.slice(0, 500)}`);
    }

    console.log(`[DataAgent] Created agent: ${agentId}`);
  } else {
    // Agent exists — update its definition with current sources and tables
    const defBody = JSON.stringify({ definition: { parts: definitionParts } });
    console.log(`[DataAgent] Updating definition for existing agent ${agentId}...`);
    const defResp = await httpRequest(
      `${FABRIC_API}/workspaces/${workspaceId}/dataAgents/${agentId}/updateDefinition`,
      { method: 'POST', headers: authHeaders(defBody), body: defBody }
    );
    console.log(`[DataAgent] updateDefinition response ${defResp.status}: ${defResp.body.slice(0, 500)}`);

    if (defResp.status === 202) {
      const loc = defResp.headers['location'] || defResp.headers['Location'] || '';
      const opM = loc.match(/\/operations\/([^/?]+)/i);
      if (opM) {
        await pollOperation(token, opM[1]);
        console.log(`[DataAgent] Definition update LRO completed`);
      }
    } else if (!defResp.ok) {
      throw new Error(`updateDefinition failed (${defResp.status}): ${defResp.body.slice(0, 400)}`);
    } else {
      console.log(`[DataAgent] Definition updated successfully`);
    }
  }

  // ── Wait for agent to become available, then resolve its URL ─────────────
  console.log(`[DataAgent] Waiting 30s for agent to become available in workspace...`);
  await new Promise(r => setTimeout(r, 30_000));

  // Fetch the workspace items to get the correct agent URL
  let agentUrl = `https://app.fabric.microsoft.com/groups/${workspaceId}/dataAgents/${agentId}`;
  try {
    const itemsResp = await httpRequest(
      `${FABRIC_API}/workspaces/${workspaceId}/items?type=DataAgent`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    console.log(`[DataAgent] Workspace items (DataAgent) ${itemsResp.status}: ${itemsResp.body.slice(0, 800)}`);
    if (itemsResp.ok) {
      const agentItems = JSON.parse(itemsResp.body).value ?? [];
      const match = agentItems.find(a => a.id === agentId);
      if (match) {
        console.log(`[DataAgent] Agent item fields: ${JSON.stringify(match)}`);
        if (match.workspaceUrl) agentUrl = match.workspaceUrl;
        else if (match.url) agentUrl = match.url;
      }
    }
  } catch (e) {
    console.warn(`[DataAgent] Could not resolve agent URL: ${e.message}`);
  }

  return {
    agentId,
    agentName,
    agentUrl,
    message: `Data Agent "${agentName}" is ready with ${sources.length} data source${sources.length !== 1 ? 's' : ''} attached.`,
  };
}

module.exports = { provisionDataAgent };
