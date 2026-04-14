import { Router } from 'express';
import { validateToken } from '../middleware/auth.js';
import type { AuthenticatedRequest } from '../types/auth.js';
import { getConfig } from '../config.js';
import { AuthService } from '../services/AuthService.js';
import { FabricService } from '../services/FabricService.js';
import { GraphService } from '../services/GraphService.js';

const FABRIC_SCOPE = 'https://api.fabric.microsoft.com/.default';
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

const router = Router();

router.get('/labels', validateToken, async (req, res, next) => {
  try {
    const { tenantId } = req as AuthenticatedRequest;
    const config = await getConfig();
    const userToken = req.headers.authorization!.slice(7);

    const authService = new AuthService(config.clientId, config.clientSecret, tenantId);
    const oboToken = await authService.getOboToken(userToken, [GRAPH_SCOPE]);
    const graphService = new GraphService(oboToken);

    const result = await graphService.listSensitivityLabels();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/labels/set', validateToken, async (req, res, next) => {
  try {
    const { tenantId } = req as AuthenticatedRequest;
    const config = await getConfig();
    const userToken = req.headers.authorization!.slice(7);
    const { items, labelId, assignmentMethod } = req.body as {
      items: Array<{ id: string; type: string }>;
      labelId: string;
      assignmentMethod?: string;
    };

    const authService = new AuthService(config.clientId, config.clientSecret, tenantId);
    const oboToken = await authService.getOboToken(userToken, [FABRIC_SCOPE]);
    const fabricService = new FabricService(oboToken);

    const result = await fabricService.bulkSetLabels(items, labelId, assignmentMethod);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/labels/remove', validateToken, async (req, res, next) => {
  try {
    const { tenantId } = req as AuthenticatedRequest;
    const config = await getConfig();
    const userToken = req.headers.authorization!.slice(7);
    const { items } = req.body as { items: Array<{ id: string; type: string }> };

    const authService = new AuthService(config.clientId, config.clientSecret, tenantId);
    const oboToken = await authService.getOboToken(userToken, [FABRIC_SCOPE]);
    const fabricService = new FabricService(oboToken);

    const result = await fabricService.bulkRemoveLabels(items);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
