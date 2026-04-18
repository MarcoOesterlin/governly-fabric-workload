/**
 * Standalone Workload Backend Server
 * 
 * Runs on port 5500 — NO webpack middleware, NO compression, NO static files.
 * This is a pure Express server that handles ONLY the Fabric workload API callbacks.
 * 
 * The Dev Gateway should point to http://127.0.0.1:5500/workload
 */

const express = require('express');
const app = express();
const PORT = 5500;

// JSON body parser
app.use(express.json());

// Log ALL requests with full details
app.use((req, res, next) => {
  console.log(`\n[${new Date().toISOString()}] ${req.method} ${req.url}`);
  console.log(`  Headers: ${JSON.stringify({
    'content-type': req.headers['content-type'],
    'authorization': req.headers['authorization'] ? '(present, length=' + req.headers['authorization'].length + ')' : '(missing)',
    'activityid': req.headers['activityid'],
    'requestid': req.headers['requestid'],
    'x-ms-client-tenant-id': req.headers['x-ms-client-tenant-id'],
  })}`);
  if (req.body && Object.keys(req.body).length > 0) {
    console.log(`  Body: ${JSON.stringify(req.body).substring(0, 500)}`);
  }
  next();
});

// ---- Workload API routes (mounted at /workload) ----

// CreateItem
app.post('/workload/workspaces/:workspaceId/items/:itemType/:itemId', (req, res) => {
  const { workspaceId, itemType, itemId } = req.params;
  console.log(`  ✅ CreateItem: workspace=${workspaceId} type=${itemType} id=${itemId}`);
  // Return 200 with JSON body — empty body causes Azure Relay to fail silently
  res.status(200).json({});
});

// DeleteItem
app.delete('/workload/workspaces/:workspaceId/items/:itemType/:itemId', (req, res) => {
  console.log(`  🗑️ DeleteItem: ${req.params.itemType} ${req.params.itemId}`);
  res.status(200).json({});
});

// GetItem payload
app.get('/workload/workspaces/:workspaceId/items/:itemType/:itemId/payload', (req, res) => {
  console.log(`  📖 GetItemPayload: ${req.params.itemType} ${req.params.itemId}`);
  res.status(200).json({ itemPayload: {} });
});

// GetItem
app.get('/workload/workspaces/:workspaceId/items/:itemType/:itemId', (req, res) => {
  console.log(`  📖 GetItem: ${req.params.itemType} ${req.params.itemId}`);
  res.status(200).json({});
});

// UpdateItem
app.patch('/workload/workspaces/:workspaceId/items/:itemType/:itemId', (req, res) => {
  console.log(`  ✏️ UpdateItem: ${req.params.itemType} ${req.params.itemId}`);
  res.status(200).json({});
});

// Execute action (jobs, etc.)
app.post('/workload/workspaces/:workspaceId/items/:itemType/:itemId/:action', (req, res) => {
  console.log(`  ⚡ Action: ${req.params.action} on ${req.params.itemType} ${req.params.itemId}`);
  res.status(200).json({});
});

// Endpoint Resolution
app.post('/workload/resolve', (req, res) => {
  console.log(`  🔗 EndpointResolution`);
  res.status(200).json({ url: `http://127.0.0.1:${PORT}/workload`, ttlInMinutes: 60 });
});

// Catch-all for unknown workload routes
app.all('/workload/{*path}', (req, res) => {
  console.log(`  ⚠️ UNHANDLED workload route: ${req.method} ${req.url}`);
  res.status(200).json({});
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n🚀 Standalone Workload Backend running on http://127.0.0.1:${PORT}/workload`);
  console.log(`   No webpack, no compression, no static files.`);
  console.log(`   Point DevGateway to: http://127.0.0.1:${PORT}/workload\n`);
});
