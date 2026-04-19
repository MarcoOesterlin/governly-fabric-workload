/**
 * Label Suggester
 *
 * Queries the provisioned Fabric Data Agent via its OpenAI-compatible
 * Assistants API to suggest sensitivity labels for workspace items.
 */

const https = require('https');
const crypto = require('crypto');

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

// ── Build the structured prompt ───────────────────────────────────────────────

function buildPrompt(items, labels) {
  const labelLines = labels
    .sort((a, b) => (a.sensitivity ?? 0) - (b.sensitivity ?? 0))
    .map(l => `  - "${l.name}" (id: ${l.id}) — ${l.description || 'No description'} [sensitivity: ${l.sensitivity ?? 0}]`)
    .join('\n');

  const dataItems = items.filter(i =>
    ['Lakehouse', 'Warehouse', 'KQLDatabase', 'SQLDatabase', 'SemanticModel'].includes(i.type)
  );
  const otherItems = items.filter(i =>
    !['Lakehouse', 'Warehouse', 'KQLDatabase', 'SQLDatabase', 'SemanticModel'].includes(i.type)
  );

  const dataItemLines = dataItems.map(i => `  - "${i.displayName}" (type: ${i.type}, id: ${i.id})`).join('\n');
  const otherItemLines = otherItems.map(i => `  - "${i.displayName}" (type: ${i.type}, id: ${i.id})`).join('\n');

  return `You are a data governance classifier. Your task is to suggest the MOST APPROPRIATE sensitivity label for each workspace item listed below.

STEP 1 — QUERY DATA SOURCES:
For EACH data item below, run "SELECT TOP 5 * FROM <table>" on every table in that source. Examine the column names AND the actual row values returned.

Data items to inspect:
${dataItemLines}

STEP 2 — CLASSIFY BASED ON EVIDENCE:
Use these rules strictly (apply the HIGHEST matching label):

  If ANY table contains columns or values resembling personal identifiers (names, emails, phone numbers, SSNs, national IDs, addresses, dates of birth, IP addresses, health records, biometric data):
    → Use the HIGHEST sensitivity label available.

  If tables contain financial data (revenue, pricing, salary, transactions, costs, bank details, invoices) or proprietary business logic:
    → Use the second-highest sensitivity label (Confidential tier).

  If tables contain only internal operational data (logs, configs, metrics, schedules) with NO personal or financial data:
    → Use a mid-level label (General/Internal tier).

  If tables contain only public reference data (country codes, currency lists, public holidays, zip codes):
    → Use the LOWEST sensitivity label.

Available sensitivity labels (ordered lowest → highest):
${labelLines}

STEP 3 — CLASSIFY NON-DATA ITEMS:
For items that don't store data directly, classify based on what data they likely process given their name:
${otherItemLines}

IMPORTANT:
- Do NOT default everything to the same label. Different data sources contain different data — differentiate.
- When in doubt, classify UP (more sensitive), not down.
- You MUST query the tables before classifying. Do not guess from names alone for data items.

Respond with ONLY a JSON array (no markdown, no explanation outside the array):
[{"itemId": "<item id>", "suggestedLabelId": "<label id>", "reason": "<what columns/data you found that drove your decision>"}]`;
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
    const prompt = buildPrompt(items, labels);
    console.log(`[LabelSuggester] Prompt length: ${prompt.length} chars`);
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
