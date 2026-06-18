import http from 'node:http';

import { createMediaProxyHandler } from './mediaProxyServer.mjs';
import { createNewApiProxyHandler } from './newApiProxyCore.mjs';
import { createProjectStoreHandler, initializeProjectStore } from './projectStoreServer.mjs';

const PORT = Number.parseInt(process.env.BIGBANANA_BACKEND_PORT || process.env.PORT || '8790', 10);
const HOST = process.env.BIGBANANA_BACKEND_HOST || '0.0.0.0';

const writeJson = (res, statusCode, payload) => {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
};

const mediaProxyHandler = createMediaProxyHandler();
const newApiProxyHandler = createNewApiProxyHandler();
const projectStoreHandler = createProjectStoreHandler();

const route = async (req, res) => {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = requestUrl.pathname;

  if (pathname === '/healthz' || pathname === '/api/backend/healthz') {
    writeJson(res, 200, {
      ok: true,
      service: 'bigbanana-backend',
      services: ['media-proxy', 'new-api-proxy', 'project-store'],
    });
    return;
  }

  if (pathname === '/api/media-proxy') {
    await mediaProxyHandler(req, res);
    return;
  }

  if (pathname === '/api/new-api/image-tasks' || pathname.startsWith('/api/new-api/image-tasks/')) {
    await projectStoreHandler(req, res);
    return;
  }

  if (pathname.startsWith('/api/new-api')) {
    await newApiProxyHandler(req, res);
    return;
  }

  if (pathname.startsWith('/api/project-store/')) {
    await projectStoreHandler(req, res);
    return;
  }

  writeJson(res, 404, { ok: false, message: 'Not found.' });
};

await initializeProjectStore();

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    console.error('[bigbanana-backend] request failed', error);
    if (!res.headersSent) {
      writeJson(res, 500, { ok: false, message: 'Internal server error.' });
    } else {
      res.end();
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[bigbanana-backend] listening on http://${HOST}:${PORT}`);
});
