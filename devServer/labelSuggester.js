/**
 * Label Suggester
 *
 * Queries the provisioned Fabric Data Agent via its OpenAI-compatible
 * Assistants API to suggest sensitivity labels for workspace items.
 */

const https = require('https');
const crypto = require('crypto');
const { fetchLakehouseTables, getOneLakeToken } = require('./dataAgentProvisioner');

const FABRIC_API = 'https://api.fabric.microsoft.com/v1';
const AGENT_NAME = 'Governly Data Agent';
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_MS = 300_000; // 5 minutes

// ── Minimal HTTPS client (same pattern as dataAgentProvisioner) ───────────────

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

// ── Find the Data Agent and its published URL ─────────────────────────────────

async function findDataAgent(token, workspaceId) {
  const resp = await httpRequest(
    `${FABRIC_API}/workspaces/${workspaceId}/dataAgents`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!resp.ok) {
    throw new Error(`Failed to list Data Agents (${resp.status}): ${resp.body.slice(0, 200)}`);
  }
  const agents = JSON.parse(resp.body).value ?? [];
  const agent = agents.find(a => a.displayName === AGENT_NAME);
  if (!agent) {
    throw new Error('Data Agent not provisioned. Click "Create Data Agent" first.');
  }
  return agent;
}

async function getPublishedUrl(token, workspaceId, agentId) {
  // Fabric Data Agent exposes OpenAI Assistants API at this path
  return `https://api.fabric.microsoft.com/v1/workspaces/${workspaceId}/dataagents/${agentId}/aiassistant/openai`;
}

// ── OpenAI Assistants API helpers ─────────────────────────────────────────────

function assistantRequest(baseUrl, path, token, body, method) {
  const url = `${baseUrl}${path}${path.includes('?') ? '&' : '?'}api-version=2024-05-01-preview`;
  const opts = {
    method: method || (body ? 'POST' : 'GET'),
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ActivityId: crypto.randomUUID(),
    },
  };
  if (body) {
    const bodyStr = JSON.stringify(body);
    opts.body = bodyStr;
    opts.headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
  }
  return httpRequest(url, opts);
}

// ── Pre-fetch table schemas for all lakehouses ────────────────────────────────

async function fetchAllTableSchemas(token, workspaceId, items) {
  const lakehouses = items.filter(i => i.type === 'Lakehouse');
  const schemaMap = {}; // { itemId: [{ name, schema }] }

  for (const lh of lakehouses) {
    try {
      const tables = await fetchLakehouseTables(token, workspaceId, lh.id);
      schemaMap[lh.id] = tables;
      console.log(`[LabelSuggester] ${lh.displayName}: ${tables.length} table(s) — ${tables.map(t => `${t.schema}.${t.name}`).join(', ')}`);
    } catch (e) {
      console.warn(`[LabelSuggester] Failed to fetch tables for ${lh.displayName}: ${e.message}`);
      schemaMap[lh.id] = [];
    }
  }
  return schemaMap;
}

// ── Build the structured prompt ───────────────────────────────────────────────

function buildPrompt(items, labels, tableSchemas) {
  const sorted = [...labels].sort((a, b) => (a.sensitivity ?? 0) - (b.sensitivity ?? 0));
  const labelLines = sorted
    .map(l => `  - "${l.name}" (id: ${l.id}) [sensitivity rank: ${l.sensitivity ?? 0}]${l.description ? ' — ' + l.description : ''}`)
    .join('\n');

  const lowest = sorted[0];
  const highest = sorted[sorted.length - 1];
  const secondHighest = sorted.length >= 3 ? sorted[sorted.length - 2] : highest;
  const midLevel = sorted.length >= 4 ? sorted[1] : lowest;

  // Build item lines with embedded table info for lakehouses
  const itemLines = items.map(i => {
    let line = `  - "${i.displayName}" (type: ${i.type}, id: ${i.id})`;
    const tables = tableSchemas[i.id];
    if (tables && tables.length > 0) {
      const tableList = tables.map(t => `${t.schema}.${t.name}`).join(', ');
      line += `\n    TABLES: [${tableList}]`;
    }
    return line;
  }).join('\n');

  return `You are a data classification engine. I have already inspected the data sources and listed their table names below. Do NOT attempt to query any data sources yourself. Classify based ONLY on the table names provided.

WORKSPACE ITEMS (table names pre-fetched from each lakehouse):
${itemLines}

SENSITIVITY LABELS (lowest → highest):
${labelLines}

CLASSIFICATION RULES — apply the FIRST matching rule per item:

RULE A → "${highest.name}" (${highest.id})
  ANY table name contains keywords suggesting personal/identifiable data:
  customer, employee, person, user, patient, member, contact, account, beneficiary,
  or prefixes like dim_customer, dimension_employee, fact_customer, etc.
  PII includes names, addresses, emails, phone numbers, dates of birth, IDs.

RULE B → "${secondHighest.name}" (${secondHighest.id})
  ANY table name contains keywords suggesting financial transactions or location tracking:
  sale, transaction, payment, invoice, order, revenue, billing, fare, trip, ride,
  tripdata, journey, route, GPS, coordinates, pickup, dropoff.

RULE C → "${midLevel.name}" (${midLevel.id})
  Tables contain only internal reference or operational data — no personal or financial info:
  dimension_date, dimension_city, stock_item, inventory, config, log, metric, audit,
  calendar, geography, product_category, warehouse.

RULE D → "${lowest.name}" (${lowest.id})
  Tables contain only publicly available reference data:
  public, holiday, country_code, currency, government, census, open_data, weather.

INSTRUCTIONS:
1. For each Lakehouse, examine the TABLES listed above and match table names to the keyword patterns in the rules.
2. If ANY table in a lakehouse matches Rule A, the ENTIRE lakehouse gets Rule A (highest wins).
3. SQLEndpoints that share a display name with a Lakehouse inherit the SAME label.
4. The Data Agent item inherits the label of the MOST sensitive data source in the workspace.
5. Each lakehouse has different tables — they will likely need different labels.
6. Do NOT try to query data sources. Use ONLY the table names I provided above.

OUTPUT — JSON array only, no other text:
[{"itemId":"<id>","suggestedLabelId":"<label id>","reason":"<which tables matched which rule>"}]`;
}

// ── Parse suggestions from agent response ─────────────────────────────────────

function parseSuggestions(text) {
  // Extract JSON array from the response (agent might wrap in markdown code blocks)
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.warn('[LabelSuggester] Could not find JSON array in response:', text.slice(0, 500));
    return [];
  }
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(s => s.itemId && s.suggestedLabelId)
      .map(s => ({
        itemId: s.itemId,
        suggestedLabelId: s.suggestedLabelId,
        reason: s.reason || '',
      }));
  } catch (e) {
    console.warn('[LabelSuggester] Failed to parse JSON:', e.message);
    return [];
  }
}

// ── Main: suggest labels via Data Agent ───────────────────────────────────────

/**
 * @param {string} token      - Fabric API Bearer token
 * @param {string} workspaceId
 * @param {Array}  items      - [{id, displayName, type}]
 * @param {Array}  labels     - [{id, name, description, sensitivity}]
 * @returns {{ suggestions: Array<{itemId, suggestedLabelId, reason}> }}
 */
async function suggestLabels(token, workspaceId, items, labels) {
  console.log(`[LabelSuggester] Starting for ${items.length} items, ${labels.length} labels`);

  // 0. Pre-fetch table schemas for all lakehouses
  console.log(`[LabelSuggester] Fetching table schemas...`);
  const tableSchemas = await fetchAllTableSchemas(token, workspaceId, items);

  // 1. Find the Data Agent
  const agent = await findDataAgent(token, workspaceId);
  const agentId = agent.id;
  console.log(`[LabelSuggester] Found agent: ${agentId}`);

  // 2. Get published URL
  const baseUrl = await getPublishedUrl(token, workspaceId, agentId);
  console.log(`[LabelSuggester] Published URL: ${baseUrl}`);

  // 3. Create assistant
  const assistantResp = await assistantRequest(baseUrl, '/assistants', token, { model: 'not used' });
  if (!assistantResp.ok) {
    throw new Error(`Failed to create assistant (${assistantResp.status}): ${assistantResp.body.slice(0, 300)}`);
  }
  const assistantId = JSON.parse(assistantResp.body).id;
  console.log(`[LabelSuggester] Assistant: ${assistantId}`);

  // 4. Create thread
  const threadResp = await assistantRequest(baseUrl, '/threads', token, {});
  if (!threadResp.ok) {
    throw new Error(`Failed to create thread (${threadResp.status}): ${threadResp.body.slice(0, 300)}`);
  }
  const threadId = JSON.parse(threadResp.body).id;
  console.log(`[LabelSuggester] Thread: ${threadId}`);

  try {
    // 5. Post message
    const prompt = buildPrompt(items, labels, tableSchemas);
    console.log(`[LabelSuggester] Prompt length: ${prompt.length} chars`);
    console.log(`[LabelSuggester] Prompt preview:\n${prompt.slice(0, 800)}...`);
    const msgResp = await assistantRequest(baseUrl, `/threads/${threadId}/messages`, token, {
      role: 'user',
      content: prompt,
    });
    if (!msgResp.ok) {
      throw new Error(`Failed to create message (${msgResp.status}): ${msgResp.body.slice(0, 300)}`);
    }

    // 6. Create run
    const runResp = await assistantRequest(baseUrl, `/threads/${threadId}/runs`, token, {
      assistant_id: assistantId,
    });
    if (!runResp.ok) {
      throw new Error(`Failed to create run (${runResp.status}): ${runResp.body.slice(0, 300)}`);
    }
    const runId = JSON.parse(runResp.body).id;
    console.log(`[LabelSuggester] Run: ${runId}`);

    // 7. Poll until complete
    const terminalStates = new Set(['completed', 'failed', 'cancelled', 'requires_action']);
    const start = Date.now();
    let runStatus = '';

    while (Date.now() - start < MAX_POLL_MS) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      const pollResp = await assistantRequest(baseUrl, `/threads/${threadId}/runs/${runId}`, token);
      if (!pollResp.ok) {
        console.warn(`[LabelSuggester] Poll error (${pollResp.status}): ${pollResp.body.slice(0, 200)}`);
        continue;
      }
      const pollData = JSON.parse(pollResp.body);
      runStatus = pollData.status;
      console.log(`[LabelSuggester] Run status: ${runStatus}`);
      if (terminalStates.has(runStatus)) break;
    }

    if (runStatus !== 'completed') {
      throw new Error(`Data Agent run ended with status: ${runStatus || 'timeout'}`);
    }

    // 8. Get messages
    const msgsResp = await assistantRequest(baseUrl, `/threads/${threadId}/messages?order=asc`, token);
    if (!msgsResp.ok) {
      throw new Error(`Failed to get messages (${msgsResp.status}): ${msgsResp.body.slice(0, 300)}`);
    }
    const messages = JSON.parse(msgsResp.body).data ?? [];
    console.log(`[LabelSuggester] Got ${messages.length} messages`);

    // Find the assistant's response (last message with role=assistant)
    const assistantMsg = [...messages].reverse().find(m => m.role === 'assistant');
    if (!assistantMsg) {
      throw new Error('No response from Data Agent');
    }

    const responseText = assistantMsg.content
      ?.map(c => c.text?.value ?? '')
      .join('\n') ?? '';
    console.log(`[LabelSuggester] Response (${responseText.length} chars): ${responseText.slice(0, 500)}`);

    // 9. Parse suggestions
    const suggestions = parseSuggestions(responseText);
    console.log(`[LabelSuggester] Parsed ${suggestions.length} suggestions`);

    return { suggestions };
  } finally {
    // Cleanup: delete thread
    try {
      await assistantRequest(baseUrl, `/threads/${threadId}`, token, null, 'DELETE');
    } catch { /* ignore cleanup errors */ }
  }
}

module.exports = { suggestLabels };
