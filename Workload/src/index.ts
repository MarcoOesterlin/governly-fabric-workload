import express from 'express';
import cors from 'cors';
import { getConfig } from './config.js';
import { errorHandler } from './middleware/errorHandler.js';
import itemsRouter from './routes/items.js';
import domainsRouter from './routes/domains.js';
import labelsRouter from './routes/labels.js';
import lakehousesRouter from './routes/lakehouses.js';

async function main() {
  const config = await getConfig();

  const app = express();

  app.use(cors({ origin: 'http://localhost:60006' }));
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', workload: config.workloadName });
  });

  app.use('/api', itemsRouter);
  app.use('/api', domainsRouter);
  app.use('/api', labelsRouter);
  app.use('/api', lakehousesRouter);

  app.use(errorHandler);

  app.listen(config.backendPort, () => {
    console.log(`Governly backend listening on port ${config.backendPort}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
