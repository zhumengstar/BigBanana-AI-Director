import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const PORT = Number.parseInt(process.env.MEDIA_PROXY_PORT || process.env.PORT || '8787', 10);
const HOST = process.env.MEDIA_PROXY_HOST || '0.0.0.0';
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.MEDIA_PROXY_TIMEOUT_MS || '120000', 10);
const MAX_URL_LENGTH = Number.parseInt(process.env.MEDIA_PROXY_MAX_URL_LENGTH || '4096', 10);
const CORS_ORIGIN = process.env.MEDIA_PROXY_CORS_ORIGIN || '*';

const allowedHostSuffixes = (process.env.MEDIA_PROXY_ALLOWED_HOSTS || 'volces.com')
  .split(',')
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);

const allowedProtocols = (process.env.MEDIA_PROXY_ALLOWED_PROTOCOLS || 'https')
  .split(',')
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);

const passThroughResponseHeaders = new Set([
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'cache-control',
  'etag',
  'last-modified',
  'expires',
]);

const setCorsHeaders = (res) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Range');
};

const writeJson = (res, statusCode, payload) => {
  setCorsHeaders(res);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
};

const decodeTargetUrl = (rawValue) => {
  let value = String(rawValue || '').trim();
  if (!value) return '';

  // Support already-encoded inputs like https%3A%2F%2F...
  for (let i = 0; i < 2; i += 1) {
    if (!/%[0-9a-f]{2}/i.test(value)) break;
    try {
      const decoded = decodeURIComponent(value);
      if (decoded === value) break;
      value = decoded;
    } catch {
      break;
    }
  }
  return value;
};

const isAllowedTarget = (target) => {
  if (!allowedProtocols.includes(target.protocol.replace(':', '').toLowerCase())) {
    return false;
  }

  const hostname = target.hostname.toLowerCase();
  return allowedHostSuffixes.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`)
  );
};

const buildUpstreamHeaders = (req) => {
  const headers = {};
  if (req.headers.range) headers.range = String(req.headers.range);
  if (req.headers['if-range']) headers['if-range'] = String(req.headers['if-range']);
  if (req.headers['if-none-match']) headers['if-none-match'] = String(req.headers['if-none-match']);
  if (req.headers['if-modified-since']) {
    headers['if-modified-since'] = String(req.headers['if-modified-since']);
  }
  return headers;
};

const handleProxyRequest = async (req, res, requestUrl) => {
  const rawTarget = requestUrl.searchParams.get('url');
  if (!rawTarget) {
    writeJson(res, 400, { error: 'Missing url query parameter.' });
    return;
  }

  if (rawTarget.length > MAX_URL_LENGTH) {
    writeJson(res, 400, { error: 'Target URL is too long.' });
    return;
  }

  const decodedTarget = decodeTargetUrl(rawTarget);
  let target;
  try {
    target = new URL(decodedTarget);
  } catch {
    writeJson(res, 400, { error: 'Invalid target URL.' });
    return;
  }

  if (!isAllowedTarget(target)) {
    writeJson(res, 403, { error: 'Target URL is not allowed.' });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const upstream = await fetch(target.toString(), {
      method: 'GET',
      headers: buildUpstreamHeaders(req),
      redirect: 'follow',
      signal: controller.signal,
    });

    setCorsHeaders(res);
    res.statusCode = upstream.status;

    passThroughResponseHeaders.forEach((headerName) => {
      const headerValue = upstream.headers.get(headerName);
      if (headerValue) {
        res.setHeader(headerName, headerValue);
      }
    });

    if (!upstream.body) {
      res.end();
      return;
    }

    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (error) {
    const message =
      error && typeof error === 'object' && 'name' in error && error.name === 'AbortError'
        ? `Upstream request timed out (${REQUEST_TIMEOUT_MS}ms).`
        : 'Proxy request failed.';
    writeJson(res, 502, { error: message });
  } finally {
    clearTimeout(timeout);
  }
};

export const createMediaProxyHandler = () => async (req, res, next) => {
  try {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = requestUrl.pathname;

    if (pathname !== '/healthz' && pathname !== '/api/media-proxy') {
      if (typeof next === 'function') {
        next();
        return;
      }
      writeJson(res, 404, { error: 'Not found.' });
      return;
    }

    if (req.method === 'OPTIONS') {
      setCorsHeaders(res);
      res.statusCode = 204;
      res.end();
      return;
    }

    if (pathname === '/healthz') {
      writeJson(res, 200, {
        ok: true,
        service: 'media-proxy',
        allowedHostSuffixes,
        allowedProtocols,
      });
      return;
    }

    if (pathname === '/api/media-proxy') {
      await handleProxyRequest(req, res, requestUrl);
      return;
    }

    writeJson(res, 404, { error: 'Not found.' });
  } catch {
    writeJson(res, 500, { error: 'Internal server error.' });
  }
};

export const startMediaProxyServer = () => {
  const server = http.createServer(createMediaProxyHandler());
  server.listen(PORT, HOST, () => {
    console.log(
      `[media-proxy] listening on http://${HOST}:${PORT} | allowed hosts: ${allowedHostSuffixes.join(', ')}`
    );
  });
  return server;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startMediaProxyServer();
}
