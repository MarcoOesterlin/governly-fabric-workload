'use strict';

/**
 * DQ Routes — registered into the Express app by devServer/index.js
 *
 * GET  /api/dq-schema        ?workspaceId=&lakehouseId=&tableName=
 * POST /api/dq-notebook       { runId, workspaceId, lakehouseId, lakehouseName, tables, dimensions }
 *   → auto-provisions "Governly_DQ" lakehouse; returns { id, webUrl, dqLakehouseId }
 * GET  /api/dq-runs           ?workspaceId=  (reads from Governly_DQ lakehouse)
 * GET  /api/dq-run-summary    ?workspaceId=&runId=  (no source lakehouseId needed)
 * GET  /api/dq-failed-rows    ?workspaceId=&runId=&page=&pageSize=
 */

const { execSync } = require('child_process');
const https = require('https');
const { buildDqNotebook } = require('./dqNotebookTemplate');

const FABRIC_API = 'https://api.fabric.microsoft.com/v1';
const ONELAKE_DFS = 'https://onelake.dfs.fabric.microsoft.com';

// ── Token helpers ─────────────────────────────────────────────────────────────

function getFabricToken() {
  const out = execSync('az account get-access-token --resource https://api.fabric.microsoft.com --query accessToken -o tsv', { encoding: 'utf8', timeout: 20000 });
  return out.trim();
}

function getOneLakeToken() {
  const out = execSync('az account get-access-token --resource https://storage.azure.com --query accessToken -o tsv', { encoding: 'utf8', timeout: 20000 });
  return out.trim();
}

// ── Minimal HTTPS client ──────────────────────────────────────────────────────

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, port: u.port || 443,
      path: u.pathname + (u.search || ''),
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ── LRO polling ───────────────────────────────────────────────────────────────

async function pollOperation(token, operationId, maxWaitMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 3000));
    const resp = await httpRequest(`${FABRIC_API}/operations/${operationId}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) throw new Error(`Poll failed (${resp.status}): ${resp.body.slice(0, 200)}`);
    const data = JSON.parse(resp.body);
    if (data.status === 'Succeeded') return data;
    if (data.status === 'Failed') throw new Error(`Operation failed: ${JSON.stringify(data.error ?? data).slice(0, 300)}`);
  }
  throw new Error('Operation timed out');
}

async function getOperationResult(token, operationId) {
  const resp = await httpRequest(`${FABRIC_API}/operations/${operationId}/result`, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`Get result failed (${resp.status}): ${resp.body.slice(0, 200)}`);
  return JSON.parse(resp.body);
}

// ── Dedicated DQ lakehouse provisioning ──────────────────────────────────────

const DQ_LAKEHOUSE_NAME = 'Governly_DQ';

/** Find the Governly_DQ lakehouse for a workspace; returns its ID or null. */
async function findDqLakehouse(workspaceId, token) {
  const resp = await httpRequest(`${FABRIC_API}/workspaces/${workspaceId}/lakehouses`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) return null;
  const lakehouses = JSON.parse(resp.body).value ?? [];
  return lakehouses.find(l => l.displayName === DQ_LAKEHOUSE_NAME)?.id ?? null;
}

/** Find or create the Governly_DQ lakehouse; returns its ID. */
async function ensureDqLakehouse(workspaceId, token) {
  const existing = await findDqLakehouse(workspaceId, token);
  if (existing) {
    console.log(`[DQ] Using existing "${DQ_LAKEHOUSE_NAME}" lakehouse: ${existing}`);
    return existing;
  }

  console.log(`[DQ] Creating "${DQ_LAKEHOUSE_NAME}" lakehouse in workspace ${workspaceId}…`);
  const body = JSON.stringify({
    displayName: DQ_LAKEHOUSE_NAME,
    description: 'Governly Data Quality results — stores DQ check results across all workspace lakehouses.',
  });
  const createResp = await httpRequest(`${FABRIC_API}/workspaces/${workspaceId}/lakehouses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body)),
    },
    body,
  });

  if (createResp.status === 201) {
    const lh = JSON.parse(createResp.body);
    console.log(`[DQ] Created "${DQ_LAKEHOUSE_NAME}" lakehouse: ${lh.id}`);
    return lh.id;
  }

  if (createResp.status === 202) {
    const opLocation = createResp.headers['operation-location'] ?? createResp.headers['location'] ?? '';
    const operationId = opLocation.split('/operations/')[1]?.split('?')[0];
    if (!operationId) throw new Error('No operationId in 202 response for DQ lakehouse creation');
    await pollOperation(token, operationId);
    const result = await getOperationResult(token, operationId);
    console.log(`[DQ] Created "${DQ_LAKEHOUSE_NAME}" lakehouse (LRO): ${result.id}`);
    return result.id;
  }

  throw new Error(`Failed to create DQ lakehouse (${createResp.status}): ${createResp.body.slice(0, 200)}`);
}

// ── Schema discovery via Delta log ────────────────────────────────────────────

async function getTableSchema(workspaceId, lakehouseId, tableName) {
  const token = getOneLakeToken();
  // schema-enabled lakehouses use "schema.table" — map to "schema/table" OneLake path
  const tablePath = tableName.replace('.', '/');
  const logUrl = `${ONELAKE_DFS}/${workspaceId}/${lakehouseId}/Tables/${tablePath}/_delta_log/?resource=filesystem&recursive=false`;
  const resp = await httpRequest(logUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`Delta log listing failed (${resp.status}): ${resp.body.slice(0, 200)}`);

  const paths = JSON.parse(resp.body).paths ?? [];
  const jsonFiles = paths.filter(p => p.name && p.name.endsWith('.json')).map(p => p.name).sort().reverse();
  if (jsonFiles.length === 0) throw new Error('No delta log entries found');

  // p.name is relative to workspace root (includes lakehouseId prefix)
  const logFile = jsonFiles[0];
  const fileUrl = `${ONELAKE_DFS}/${workspaceId}/${logFile}`;
  const fileResp = await httpRequest(fileUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!fileResp.ok) throw new Error(`Delta log read failed (${fileResp.status})`);

  // Parse NDJSON lines, find metaData action
  const lines = fileResp.body.split('\n').filter(Boolean);
  let schemaString = null;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.metaData?.schemaString) { schemaString = entry.metaData.schemaString; break; }
    } catch {}
  }

  if (!schemaString) {
    // Fall back to checkpoint if needed — try 00000000000000000000.json
    const checkpointUrl = `${ONELAKE_DFS}/${workspaceId}/${lakehouseId}/Tables/${tablePath}/_delta_log/00000000000000000000.json`;
    const ckResp = await httpRequest(checkpointUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (ckResp.ok) {
      const ckLines = ckResp.body.split('\n').filter(Boolean);
      for (const line of ckLines) {
        try {
          const entry = JSON.parse(line);
          if (entry.metaData?.schemaString) { schemaString = entry.metaData.schemaString; break; }
        } catch {}
      }
    }
  }
  if (!schemaString) throw new Error('Could not find schemaString in delta log');

  const schema = JSON.parse(schemaString);
  return (schema.fields ?? []).map(f => ({ name: f.name, dataType: typeof f.type === 'string' ? f.type : f.type?.typeName ?? 'string' }));
}

// ── List lakehouse tables via OneLake DFS (works for schema-enabled lakehouses) ──

async function listOnelakeTables(workspaceId, lakehouseId) {
  const token = getOneLakeToken();

  // List top-level Tables/ directory — finds schema dirs OR direct delta table dirs
  const url = `${ONELAKE_DFS}/${workspaceId}/${lakehouseId}/Tables/?resource=filesystem&recursive=false`;
  const resp = await httpRequest(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) return [];

  const topLevel = JSON.parse(resp.body).paths ?? [];
  const tables = [];

  for (const item of topLevel) {
    const isDir = item.isDirectory === true || item.isDirectory === 'true';
    if (!isDir) continue;
    const itemName = item.name.split('/').pop();
    if (!itemName || itemName.startsWith('_') || itemName.startsWith('.') || itemName.startsWith('governly_')) continue;

    // Peek inside: if it contains _delta_log it's a direct table; otherwise it's a schema dir
    const subUrl = `${ONELAKE_DFS}/${workspaceId}/${lakehouseId}/Tables/${itemName}/?resource=filesystem&recursive=false`;
    const subResp = await httpRequest(subUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!subResp.ok) continue;

    const subItems = JSON.parse(subResp.body).paths ?? [];
    const hasDeltaLog = subItems.some(p => p.name && p.name.split('/').pop() === '_delta_log');

    if (hasDeltaLog) {
      tables.push({ name: itemName, type: 'Managed', format: 'delta' });
    } else {
      // Schema directory — each subdirectory is a table
      for (const sub of subItems) {
        const isSubDir = sub.isDirectory === true || sub.isDirectory === 'true';
        if (!isSubDir) continue;
        const tableName = sub.name.split('/').pop();
        if (!tableName || tableName.startsWith('_') || tableName.startsWith('.')) continue;
        tables.push({ name: `${itemName}.${tableName}`, type: 'Managed', format: 'delta' });
      }
    }
  }

  return tables;
}

// ── List DQ runs from Governly_DQ lakehouse Files ────────────────────────────

async function listDqRuns(workspaceId, dqLakehouseId) {
  const token = getOneLakeToken();
  const url = `${ONELAKE_DFS}/${workspaceId}/${dqLakehouseId}/Files/governly_dq?resource=filesystem&recursive=true`;
  const resp = await httpRequest(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) return [];
  const paths = JSON.parse(resp.body).paths ?? [];

  const runs = [];
  for (const p of paths) {
    if (!p.name || !p.name.endsWith('/summary.json')) continue;
    const match = p.name.match(/year=(\d+)\/month=(\d+)\/day=(\d+)\/run_id=(\d{6})\/summary\.json$/);
    if (!match) continue;
    const [, year, month, day, runId] = match;
    const hh = runId.slice(0, 2), mm = runId.slice(2, 4), ss = runId.slice(4, 6);
    const run_timestamp = `${year}-${month}-${day}T${hh}:${mm}:${ss}Z`;
    runs.push({ run_id: runId, run_timestamp, lakehouse_id: dqLakehouseId, year, month, day });
  }

  return runs.sort((a, b) => b.run_timestamp.localeCompare(a.run_timestamp));
}

// ── Read JSON files from OneLake Files ───────────────────────────────────────

async function readOneLakeFile(workspaceId, lakehouseId, filePath) {
  const token = getOneLakeToken();
  const url = `${ONELAKE_DFS}/${workspaceId}/${lakehouseId}/Files/${filePath}`;
  const resp = await httpRequest(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`OneLake read failed (${resp.status}): ${resp.body.slice(0, 200)}`);
  return JSON.parse(resp.body);
}

// ── Trigger notebook run ──────────────────────────────────────────────────────

async function triggerNotebookRun(token, workspaceId, notebookId) {
  // Brief delay to let Fabric fully provision the newly-created notebook
  await new Promise(r => setTimeout(r, 3000));

  const url = `${FABRIC_API}/workspaces/${workspaceId}/notebooks/${notebookId}/jobs/instances?jobType=RunNotebook`;
  const body = '{}';
  const resp = await httpRequest(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body)),
    },
    body,
  });

  if (resp.status === 202) {
    const location = resp.headers['location'] ?? '';
    const jobInstanceId = location.split('/jobInstances/')[1]?.split('?')[0] ?? '';
    console.log(`[DQ-Notebook] Run triggered (202) for ${notebookId}${jobInstanceId ? `, jobInstanceId=${jobInstanceId}` : ''}`);
    return jobInstanceId;
  }

  // 429 = capacity throttled — log but don't throw
  if (resp.status === 429) {
    console.warn(`[DQ-Notebook] Trigger throttled (429) — Spark capacity busy. Notebook ${notebookId} queued.`);
    return null;
  }

  console.warn(`[DQ-Notebook] Trigger failed (${resp.status}): ${resp.body.slice(0, 300)}`);
  throw new Error(`Notebook trigger failed (${resp.status}): ${resp.body.slice(0, 200)}`);
}

// ── In-memory preload cache (5-minute TTL per workspace) ─────────────────────

const preloadCache = new Map(); // workspaceId → { data, expiry }
const PRELOAD_CACHE_TTL = 5 * 60 * 1000;

// ── Route registration ────────────────────────────────────────────────────────

function registerDqRoutes(app) {
  // GET /api/dq-preload — returns runs + all summaries in one call (5-min server cache)
  app.get('/api/dq-preload', async (req, res) => {
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });

    const cached = preloadCache.get(workspaceId);
    if (cached && cached.expiry > Date.now()) {
      return res.json(cached.data);
    }

    try {
      const token = getFabricToken();
      const dqLakehouseId = await findDqLakehouse(workspaceId, token);
      if (!dqLakehouseId) return res.json({ runs: [], summaries: {} });

      const runs = await listDqRuns(workspaceId, dqLakehouseId);
      const recentRuns = runs.slice(0, 30);

      const summaryResults = await Promise.allSettled(
        recentRuns.map(run =>
          readOneLakeFile(workspaceId, dqLakehouseId,
            `governly_dq/year=${run.year}/month=${run.month}/day=${run.day}/run_id=${run.run_id}/summary.json`)
        )
      );

      const summaries = {};
      summaryResults.forEach((result, i) => {
        if (result.status === 'fulfilled') summaries[recentRuns[i].run_id] = result.value;
      });

      // Also preload failed rows for the latest run (page 1, up to 50 rows)
      let latestFailedRows = null;
      if (runs.length > 0) {
        const latest = runs[0];
        try {
          const frPath = `governly_dq/year=${latest.year}/month=${latest.month}/day=${latest.day}/run_id=${latest.run_id}/failed_rows.json`;
          const frData = await readOneLakeFile(workspaceId, dqLakehouseId, frPath);
          const all = frData.failed_rows ?? [];
          latestFailedRows = { rows: all.slice(0, 50), total: all.length };
          console.log(`[DQ-Preload] Loaded ${all.length} failed rows for run ${latest.run_id}`);
        } catch (_) { /* no failed rows file for this run */ }
      }

      const data = { runs, summaries, latestFailedRows };
      preloadCache.set(workspaceId, { data, expiry: Date.now() + PRELOAD_CACHE_TTL });
      console.log(`[DQ-Preload] Loaded ${runs.length} runs + ${Object.keys(summaries).length} summaries for workspace ${workspaceId}`);
      res.json(data);
    } catch (err) {
      console.error('[DQ-Preload]', err.message);
      res.json({ runs: [], summaries: {} });
    }
  });

  // GET /api/dq-tables  (OneLake DFS-based, works for schema-enabled lakehouses)
  app.get('/api/dq-tables', async (req, res) => {
    const { workspaceId, lakehouseId } = req.query;
    if (!workspaceId || !lakehouseId) return res.status(400).json({ error: 'workspaceId and lakehouseId required' });
    try {
      const tables = await listOnelakeTables(workspaceId, lakehouseId);
      res.json({ tables });
    } catch (err) {
      console.error('[DQ-Tables]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/dq-schema
  app.get('/api/dq-schema', async (req, res) => {
    const { workspaceId, lakehouseId, tableName } = req.query;
    if (!workspaceId || !lakehouseId || !tableName) return res.status(400).json({ error: 'workspaceId, lakehouseId and tableName required' });
    try {
      const columns = await getTableSchema(workspaceId, lakehouseId, tableName);
      res.json({ columns });
    } catch (err) {
      console.error('[DQ-Schema]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/dq-notebook
  app.post('/api/dq-notebook', async (req, res) => {
    const config = req.body;
    if (!config?.workspaceId || !config?.lakehouseId || !config?.tables?.length) {
      return res.status(400).json({ error: 'workspaceId, lakehouseId and tables required' });
    }
    try {
      const fabricToken = getFabricToken();

      // Provision the dedicated Governly_DQ lakehouse (creates if not exists)
      const dqLakehouseId = await ensureDqLakehouse(config.workspaceId, fabricToken);

      const notebookJson = buildDqNotebook({ ...config, dqLakehouseId });
      const payload = Buffer.from(notebookJson).toString('base64');

      const body = JSON.stringify({
        displayName: `Governly DQ - ${config.runId}`,
        definition: {
          format: 'ipynb',
          parts: [{ path: 'notebook-content.ipynb', payload, payloadType: 'InlineBase64' }],
        },
      });

      const createResp = await httpRequest(`${FABRIC_API}/workspaces/${config.workspaceId}/notebooks`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${fabricToken}`, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) },
        body,
      });

      if (createResp.status === 201) {
        const nb = JSON.parse(createResp.body);
        const webUrl = nb.webUrl ?? `https://app.fabric.microsoft.com/groups/${config.workspaceId}/notebooks/${nb.id}`;
        const jobInstanceId = await triggerNotebookRun(fabricToken, config.workspaceId, nb.id);
        preloadCache.delete(config.workspaceId); // invalidate so next dashboard load gets fresh data
        return res.json({ id: nb.id, webUrl, dqLakehouseId, jobInstanceId });
      }

      if (createResp.status === 202) {
        const opLocation = createResp.headers['operation-location'] ?? createResp.headers['location'] ?? '';
        const operationId = opLocation.split('/operations/')[1]?.split('?')[0];
        if (!operationId) throw new Error('No operationId in 202 response');
        await pollOperation(fabricToken, operationId);
        const result = await getOperationResult(fabricToken, operationId);
        const webUrl = result.webUrl ?? `https://app.fabric.microsoft.com/groups/${config.workspaceId}/notebooks/${result.id}`;
        const jobInstanceId = await triggerNotebookRun(fabricToken, config.workspaceId, result.id);
        preloadCache.delete(config.workspaceId); // invalidate
        return res.json({ id: result.id, webUrl, dqLakehouseId, jobInstanceId });
      }

      throw new Error(`Notebook create failed (${createResp.status}): ${createResp.body.slice(0, 300)}`);
    } catch (err) {
      console.error('[DQ-Notebook]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/dq-runs — reads from Governly_DQ lakehouse (no source lakehouseId needed)
  app.get('/api/dq-runs', async (req, res) => {
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    try {
      const token = getFabricToken();
      const dqLakehouseId = await findDqLakehouse(workspaceId, token);
      if (!dqLakehouseId) return res.json({ runs: [] });
      const runs = await listDqRuns(workspaceId, dqLakehouseId);
      res.json({ runs });
    } catch (err) {
      console.error('[DQ-Runs]', err.message);
      res.json({ runs: [] });
    }
  });

  // GET /api/dq-run-summary — reads from Governly_DQ lakehouse
  app.get('/api/dq-run-summary', async (req, res) => {
    const { workspaceId, runId, year, month, day } = req.query;
    if (!workspaceId || !runId) return res.status(400).json({ error: 'workspaceId and runId required' });
    try {
      const token = getFabricToken();
      const dqLakehouseId = await findDqLakehouse(workspaceId, token);
      if (!dqLakehouseId) return res.status(404).json({ error: 'Governly_DQ lakehouse not found' });
      const filePath = (year && month && day)
        ? `governly_dq/year=${year}/month=${month}/day=${day}/run_id=${runId}/summary.json`
        : `governly_dq/${runId}_summary.json`; // backward compat with old flat layout
      const summary = await readOneLakeFile(workspaceId, dqLakehouseId, filePath);
      res.json(summary);
    } catch (err) {
      console.error('[DQ-Summary]', err.message);
      res.status(404).json({ error: err.message });
    }
  });

  // GET /api/dq-failed-rows — reads from Governly_DQ lakehouse
  app.get('/api/dq-failed-rows', async (req, res) => {
    const { workspaceId, runId, year, month, day } = req.query;
    const page = parseInt(req.query.page ?? '1', 10);
    const pageSize = parseInt(req.query.pageSize ?? '50', 10);
    if (!workspaceId || !runId) return res.status(400).json({ error: 'workspaceId and runId required' });
    try {
      const token = getFabricToken();
      const dqLakehouseId = await findDqLakehouse(workspaceId, token);
      if (!dqLakehouseId) return res.status(404).json({ error: 'Governly_DQ lakehouse not found' });
      const filePath = (year && month && day)
        ? `governly_dq/year=${year}/month=${month}/day=${day}/run_id=${runId}/failed_rows.json`
        : `governly_dq/${runId}_failed_rows.json`; // backward compat
      const data = await readOneLakeFile(workspaceId, dqLakehouseId, filePath);
      const all = data.failed_rows ?? [];
      const total = all.length;
      const rows = all.slice((page - 1) * pageSize, page * pageSize);
      res.json({ rows, total, page, pageSize });
    } catch (err) {
      console.error('[DQ-FailedRows]', err.message);
      res.status(404).json({ error: err.message });
    }
  });
}

module.exports = { registerDqRoutes };
