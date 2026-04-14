import { Router } from 'express';
import { validateToken } from '../middleware/auth.js';
import type { AuthenticatedRequest } from '../types/auth.js';
import { getConfig } from '../config.js';
import { AuthService } from '../services/AuthService.js';
import { FabricService } from '../services/FabricService.js';

const FABRIC_SCOPE = 'https://api.fabric.microsoft.com/.default';

const router = Router();

router.get('/items', validateToken, async (req, res, next) => {
  try {
    const { tenantId } = req as AuthenticatedRequest;
    const config = await getConfig();
    const authHeader = req.headers.authorization!;
    const userToken = authHeader.slice(7);

    const authService = new AuthService(config.clientId, config.clientSecret, tenantId);
    const oboToken = await authService.getOboToken(userToken, [FABRIC_SCOPE]);
    const fabricService = new FabricService(oboToken);

    const { workspaceId, type, continuationToken } = req.query as Record<string, string | undefined>;
    const result = await fabricService.listItems({ workspaceId, type, continuationToken });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/workspaces', validateToken, async (req, res, next) => {
  try {
    const { tenantId } = req as AuthenticatedRequest;
    const config = await getConfig();
    const userToken = req.headers.authorization!.slice(7);

    const authService = new AuthService(config.clientId, config.clientSecret, tenantId);
    const oboToken = await authService.getOboToken(userToken, [FABRIC_SCOPE]);
    const fabricService = new FabricService(oboToken);

    const result = await fabricService.listWorkspaces();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
