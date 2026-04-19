/**
 * DevServer APIs index file
 * Exports manifest API and dev server components registration
 */

const manifestApi = require('./manifestApi');
const workloadApi = require('./workloadApi');
const governlyProxy = require('./governlyProxy');
const { provisionDataAgent } = require('./dataAgentProvisioner');
const { suggestLabels } = require('./labelSuggester');

/**
 * Register dev server manifest APIs with an Express application
 * @param {object} app Express application
 */
function registerDevServerApis(app) {
  console.log('*** Mounting Manifest API ***');
  app.use('/', manifestApi);

  console.log('*** Mounting Workload Backend API Stub ***');
  app.use('/workload', workloadApi);

  // Check if Data Agent already exists
  app.get('/api/data-agent-status', async (req, res) => {
    const workspaceId = req.query.workspaceId;
    if (!workspaceId) {
      return res.status(400).json({ error: 'Query param "workspaceId" is required.' });
    }
    try {
      const token = governlyProxy.acquireFabricToken();
      const resp = await require('https').get(
        `https://api.fabric.microsoft.com/v1/workspaces/${workspaceId}/dataAgents`,
        { headers: { Authorization: `Bearer ${token}` } },
        (httpRes) => {
          const chunks = [];
          httpRes.on('data', c => chunks.push(c));
          httpRes.on('end', () => {
            const body = Buffer.concat(chunks).toString();
            if (httpRes.statusCode < 200 || httpRes.statusCode >= 300) {
              return res.json({ exists: false });
            }
            try {
              const agents = JSON.parse(body).value ?? [];
              const agent = agents.find(a => a.displayName === 'Governly Data Agent');
              if (agent) {
                res.json({ exists: true, agentId: agent.id, agentName: agent.displayName });
              } else {
                res.json({ exists: false });
              }
            } catch { res.json({ exists: false }); }
          });
        }
      );
      resp.on('error', () => res.json({ exists: false }));
    } catch (err) {
      console.error('[DataAgentStatus] Error:', err.message);
      res.json({ exists: false });
    }
  });

  // Explicit Express route — prevents middleware URL-matching issues
  app.post('/api/provision-data-agent', async (req, res) => {
    const { workspaceId, instanceName } = req.body ?? {};
    if (!workspaceId) {
      return res.status(400).json({ error: 'Request body must include "workspaceId".' });
    }
    try {
      const token = governlyProxy.acquireFabricToken();
      const result = await provisionDataAgent(token, workspaceId, instanceName ?? 'Governly');
      res.json(result);
    } catch (err) {
      console.error('[Provision] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/suggest-labels', async (req, res) => {
    const { workspaceId, items, labels } = req.body ?? {};
    if (!workspaceId || !items?.length || !labels?.length) {
      return res.status(400).json({ error: 'Request body must include "workspaceId", "items", and "labels".' });
    }
    try {
      const token = governlyProxy.acquireFabricToken();
      const result = await suggestLabels(token, workspaceId, items, labels);
      res.json(result);
    } catch (err) {
      console.error('[SuggestLabels] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  console.log('*** Mounting Governly API Proxy (Fabric/Graph via Azure CLI) ***');
  app.use('/', governlyProxy);
}

function registerDevServerComponents() {
  console.log("*********************************************************************");
  console.log('***                Mounting Dev Server Components                ***');

  // Log playground availability
  console.log('\x1b[32m🎮 Following playgrounds are enabled in development mode:\x1b[0m'); // Green
  const workloadName = process.env.WORKLOAD_NAME || 'unknown-workload';
  console.log(`\x1b[32m🌐 Client-SDK Playground:\x1b[0m \x1b[34mhttps://app.fabric.microsoft.com/workloads/${workloadName}/playground-client-sdk\x1b[0m`); // Blue
  console.log(`\x1b[32m🌐 Data Playground:\x1b[0m \x1b[34mhttps://app.fabric.microsoft.com/workloads/${workloadName}/playground-data\x1b[0m`); // Blue
  console.log("*********************************************************************");
}

module.exports = {
  manifestApi,
  registerDevServerApis,
  registerDevServerComponents
};
