import { Router } from 'express';
import { validateToken } from '../middleware/auth.js';
import type { AuthenticatedRequest } from '../types/auth.js';
import { getConfig } from '../config.js';
import { AuthService } from '../services/AuthService.js';
import { FabricService } from '../services/FabricService.js';

const FABRIC_SCOPE = 'https://api.fabric.microsoft.com/.default';

const router = Router();

router.get('/domains', validateToken, async (req, res, next) => {
  try {
    const { tenantId } = req as AuthenticatedRequest;
    const config = await getConfig();
    const userToken = req.headers.authorization!.slice(7);

    const authService = new AuthService(config.clientId, config.clientSecret, tenantId);
    const oboToken = await authService.getOboToken(userToken, [FABRIC_SCOPE]);
    const fabricService = new FabricService(oboToken);

    const result = await fabricService.listDomains();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.patch('/domains/:domainId', validateToken, async (req, res, next) => {
  try {
    const { tenantId } = req as AuthenticatedRequest;
    const config = await getConfig();
    const userToken = req.headers.authorization!.slice(7);
    const { domainId } = req.params;
    const { labelId } = req.body as { labelId: string | null };

    const authService = new AuthService(config.clientId, config.clientSecret, tenantId);
    const oboToken = await authService.getOboToken(userToken, [FABRIC_SCOPE]);
    const fabricService = new FabricService(oboToken);

    await fabricService.updateDomainLabel(domainId, labelId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
