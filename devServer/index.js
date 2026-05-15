/**
 * DevServer APIs index file
 * Exports manifest API and dev server components registration
 */

const manifestApi = require('./manifestApi');
const workloadApi = require('./workloadApi');
const governlyProxy = require('./governlyProxy');
const spProvisioning = require('./spProvisioning');
const { provisionDataAgent, httpRequest } = require('./dataAgentProvisioner');
const { suggestLabels } = require('./labelSuggester');
const { registerDqRoutes } = require('./dqRoutes');
const accessManagement = require('./accessManagement');

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
      const resp = await httpRequest(
        `https://api.fabric.microsoft.com/v1/workspaces/${workspaceId}/dataAgents`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!resp.ok) {
        console.log(`[DataAgentStatus] Fabric API returned ${resp.status}: ${resp.body.slice(0, 300)}`);
        return res.json({ exists: false });
      }
      const agents = JSON.parse(resp.body).value ?? [];
      console.log(`[DataAgentStatus] Found ${agents.length} agent(s): ${JSON.stringify(agents.map(a => ({ id: a.id, name: a.displayName })))}`);
      const agent = agents.find(a => a.displayName === 'Governly Data Agent');
      if (agent) {
        res.json({ exists: true, agentId: agent.id, agentName: agent.displayName });
      } else {
        res.json({ exists: false });
      }
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

  app.get('/api/sp-status', async (_req, res) => {
    try {
      const status = await spProvisioning.getSpStatus();
      res.json(status);
    } catch (err) {
      console.error('[SpStatus] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/sp-consent-url', (_req, res) => {
    try {
      res.json(spProvisioning.getConsentUrl());
    } catch (err) {
      console.error('[SpConsentUrl] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/sp-setup', async (_req, res) => {
    try {
      const status = await spProvisioning.provisionSp();
      res.json(status);
    } catch (err) {
      console.error('[SpSetup] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/access/roles', async (req, res) => {
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'Query param "workspaceId" is required.' });
    try {
      const report = await accessManagement.buildAccessReport(workspaceId);
      res.json(report);
    } catch (err) {
      console.error('[AccessRoles] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/access/group-member', async (req, res) => {
    const { groupId, memberId } = req.query;
    if (!groupId || !memberId) return res.status(400).json({ error: 'Query params "groupId" and "memberId" are required.' });
    try {
      await accessManagement.removeMemberFromGroup(groupId, memberId);
      res.status(204).end();
    } catch (err) {
      console.error('[AccessRevoke] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  console.log('*** Mounting Governly DQ Routes ***');
  registerDqRoutes(app);

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
