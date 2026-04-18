/**
 * Workload Backend API Stub
 * 
 * Handles Fabric workload CRUD callbacks that come through the Dev Gateway relay.
 * When HostingType="Remote", Fabric calls these endpoints for item lifecycle events.
 * This stub returns success responses so that item creation/deletion works in dev mode.
 * 
 * Request pattern from Dev Gateway:
 *   POST|DELETE|GET /workload/workspaces/{workspaceId}/items/{itemType}/{itemId}?api-version=...
 */

const express = require('express');
const router = express.Router();

// Log all requests hitting the workload API
router.use((req, res, next) => {
  console.log(`\x1b[36m[Backend Stub] ${req.method} ${req.originalUrl}\x1b[0m`);
  if (req.body && Object.keys(req.body).length > 0) {
    console.log(`\x1b[90m  Body: ${JSON.stringify(req.body).substring(0, 200)}\x1b[0m`);
  }
  next();
});

// CORS preflight for workload endpoints
router.options('/{*path}', (req, res) => {
  res.header({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, ActivityId, RequestId',
    'Access-Control-Max-Age': '86400'
  });
  res.sendStatus(204);
});

// CreateItem / item lifecycle notification
// POST /workload/workspaces/:workspaceId/items/:itemType/:itemId
router.post('/workspaces/:workspaceId/items/:itemType/:itemId', (req, res) => {
  const { workspaceId, itemType, itemId } = req.params;
  console.log(`\x1b[32m[Backend Stub] ✅ CreateItem: type=${itemType} id=${itemId}\x1b[0m`);
  if (req.body && Object.keys(req.body).length > 0) {
    console.log(`\x1b[90m  Request body: ${JSON.stringify(req.body).substring(0, 500)}\x1b[0m`);
  }
  res.status(200).json({});
});

// DeleteItem
// DELETE /workload/workspaces/:workspaceId/items/:itemType/:itemId
router.delete('/workspaces/:workspaceId/items/:itemType/:itemId', (req, res) => {
  const { workspaceId, itemType, itemId } = req.params;
  console.log(`\x1b[33m[Backend Stub] 🗑️ DeleteItem: type=${itemType} id=${itemId}\x1b[0m`);
  res.status(200).json({});
});

// GetItem
// GET /workload/workspaces/:workspaceId/items/:itemType/:itemId
router.get('/workspaces/:workspaceId/items/:itemType/:itemId', (req, res) => {
  const { workspaceId, itemType, itemId } = req.params;
  console.log(`\x1b[34m[Backend Stub] 📖 GetItem: type=${itemType} id=${itemId}\x1b[0m`);
  res.status(200).json({});
});

// UpdateItem
// PUT/PATCH /workload/workspaces/:workspaceId/items/:itemType/:itemId
router.put('/workspaces/:workspaceId/items/:itemType/:itemId', (req, res) => {
  const { workspaceId, itemType, itemId } = req.params;
  console.log(`\x1b[35m[Backend Stub] ✏️ UpdateItem: type=${itemType} id=${itemId}\x1b[0m`);
  res.status(200).json({});
});
router.patch('/workspaces/:workspaceId/items/:itemType/:itemId', (req, res) => {
  const { workspaceId, itemType, itemId } = req.params;
  console.log(`\x1b[35m[Backend Stub] ✏️ PatchItem: type=${itemType} id=${itemId}\x1b[0m`);
  res.status(200).json({});
});

// Execute item action (jobs, etc.)
router.post('/workspaces/:workspaceId/items/:itemType/:itemId/:action', (req, res) => {
  const { workspaceId, itemType, itemId, action } = req.params;
  console.log(`\x1b[35m[Backend Stub] ⚡ Action: ${action} on type=${itemType} id=${itemId}\x1b[0m`);
  res.status(200).json({});
});

// Catch-all for any other workload API calls
router.all('/{*path}', (req, res) => {
  console.log(`\x1b[33m[Backend Stub] ⚠️ Unhandled: ${req.method} ${req.originalUrl}\x1b[0m`);
  res.status(200).json({});
});

module.exports = router;
