import { Router } from 'express';
import { validateToken } from '../middleware/auth.js';
import type { AuthenticatedRequest } from '../types/auth.js';
import { getConfig } from '../config.js';
import { AuthService } from '../services/AuthService.js';
import { FabricService } from '../services/FabricService.js';

const FABRIC_SCOPE = 'https://api.fabric.microsoft.com/.default';

const router = Router();

router.get('/lakehouses/:workspaceId', validateToken, async (req, res, next) => {
  try {
    const { tenantId } = req as AuthenticatedRequest;
    const config = await getConfig();
    const userToken = req.headers.authorization!.slice(7);
    const { workspaceId } = req.params;

    const authService = new AuthService(config.clientId, config.clientSecret, tenantId);
    const oboToken = await authService.getOboToken(userToken, [FABRIC_SCOPE]);
    const fabricService = new FabricService(oboToken);

    const result = await fabricService.listLakehouses(workspaceId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/lakehouses/:workspaceId/:lakehouseId/tables', validateToken, async (req, res, next) => {
  try {
    const { tenantId } = req as AuthenticatedRequest;
    const config = await getConfig();
    const userToken = req.headers.authorization!.slice(7);
    const { workspaceId, lakehouseId } = req.params;

    const authService = new AuthService(config.clientId, config.clientSecret, tenantId);
    const oboToken = await authService.getOboToken(userToken, [FABRIC_SCOPE]);
    const fabricService = new FabricService(oboToken);

    const result = await fabricService.listLakehouseTables(workspaceId, lakehouseId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
