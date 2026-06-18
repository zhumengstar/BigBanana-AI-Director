import http from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PORT = Number.parseInt(process.env.PROJECT_STORE_PORT || process.env.PORT || '8790', 10);
const HOST = process.env.PROJECT_STORE_HOST || '0.0.0.0';
const DATA_DIR = process.env.PROJECT_STORE_DATA_DIR || path.resolve(process.cwd(), 'data');
const BACKUP_FILE = process.env.PROJECT_STORE_BACKUP_FILE || 'project-store-backup.json';
const IMAGE_TASKS_FILE = process.env.PROJECT_STORE_IMAGE_TASKS_FILE || 'image-tasks.json';
const MAX_BODY_BYTES = Number.parseInt(process.env.PROJECT_STORE_MAX_BODY_BYTES || `${200 * 1024 * 1024}`, 10);
const CORS_ORIGIN = process.env.PROJECT_STORE_CORS_ORIGIN || '*';
const IMAGE_TASK_WORKERS = Math.max(1, Number.parseInt(process.env.PROJECT_STORE_IMAGE_TASK_WORKERS || '1', 10));

const backupPath = path.join(DATA_DIR, BACKUP_FILE);
const imageTasksPath = path.join(DATA_DIR, IMAGE_TASKS_FILE);
const mediaRoot = path.join(DATA_DIR, 'media');

const MEDIA_URL_PREFIX = '/api/project-store/media/';

const setCorsHeaders = (res) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
};

const writeJson = (res, statusCode, payload) => {
  setCorsHeaders(res);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
};

const readBody = (req) => new Promise((resolve, reject) => {
  let total = 0;
  const chunks = [];

  req.on('data', (chunk) => {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      reject(new Error('Request body is too large.'));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

const isValidBackupPayload = (payload) => (
  payload
  && typeof payload === 'object'
  && payload.dbName === 'BigBananaDB'
  && payload.stores
  && typeof payload.stores === 'object'
);

const readBackup = async () => {
  const text = await readFile(backupPath, 'utf8');
  return JSON.parse(text);
};

const contentTypeFor = (filePath, bytes) => {
  if (bytes && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes && bytes.subarray(0, 4).toString('ascii') === 'RIFF') return 'image/webp';

  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.svg') return 'image/svg+xml';
  return 'image/jpeg';
};

const extensionForMime = (mimeType) => {
  const normalized = String(mimeType || '').toLowerCase().split(';')[0].trim();
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/webp') return 'webp';
  if (normalized === 'image/gif') return 'gif';
  if (normalized === 'image/svg+xml') return 'svg';
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'jpg';
  return 'bin';
};

const parseDataUrl = (dataUrl) => {
  const match = String(dataUrl || '').match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!match) return null;

  return {
    mimeType: match[1],
    bytes: Buffer.from(match[2].replace(/\s/g, ''), 'base64'),
  };
};

const mediaUrlForRelativePath = (relativePath) => (
  `${MEDIA_URL_PREFIX}${relativePath.split(path.sep).map(encodeURIComponent).join('/')}`
);

const mediaPathForUrl = (mediaUrl) => {
  if (typeof mediaUrl !== 'string' || !mediaUrl.startsWith(MEDIA_URL_PREFIX)) return null;
  const relativePath = decodeURIComponent(mediaUrl.slice(MEDIA_URL_PREFIX.length));
  if (!relativePath || relativePath.includes('\0')) return null;
  const resolvedPath = path.resolve(mediaRoot, relativePath);
  const mediaRootWithSep = `${path.resolve(mediaRoot)}${path.sep}`;
  if (!resolvedPath.startsWith(mediaRootWithSep)) return null;
  return resolvedPath;
};

const resolveMediaPath = (pathname) => {
  const prefix = '/api/project-store/media/';
  if (!pathname.startsWith(prefix)) return null;

  const relativePath = decodeURIComponent(pathname.slice(prefix.length));
  if (!relativePath || relativePath.includes('\0')) return null;

  const resolvedPath = path.resolve(mediaRoot, relativePath);
  const mediaRootWithSep = `${path.resolve(mediaRoot)}${path.sep}`;
  if (!resolvedPath.startsWith(mediaRootWithSep)) return null;

  return resolvedPath;
};

const writeBackup = async (payload) => {
  await mkdir(DATA_DIR, { recursive: true });
  const tmpPath = `${backupPath}.${Date.now()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await rename(tmpPath, backupPath);
};

const writeMediaBytes = async ({ bytes, mimeType, folder = 'persisted', filenamePrefix = 'image' }) => {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new Error('Invalid image bytes.');
  }

  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const safeFolder = String(folder || 'persisted').replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '') || 'persisted';
  const safePrefix = String(filenamePrefix || 'image').replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '') || 'image';
  const ext = extensionForMime(mimeType);
  const relativePath = path.join(safeFolder, day, `${safePrefix}-${hash.slice(0, 24)}.${ext}`);
  const absolutePath = path.join(mediaRoot, relativePath);

  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, bytes);

  return {
    url: mediaUrlForRelativePath(relativePath),
    relativePath,
    sha256: hash,
    bytes: bytes.length,
    mimeType,
  };
};

const writeMediaFromDataUrl = async ({ dataUrl, folder = 'persisted', filenamePrefix = 'image' }) => {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) {
    throw new Error('Invalid image data URL.');
  }

  return writeMediaBytes({
    bytes: parsed.bytes,
    mimeType: parsed.mimeType,
    folder,
    filenamePrefix,
  });
};

const imageTasks = new Map();
const imageTaskQueue = [];
let activeImageWorkers = 0;
let imageTasksSaveChain = Promise.resolve();

const nowIso = () => new Date().toISOString();

const taskId = () => `imgtask_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;

const sanitizeHeadersForDisk = (headers) => {
  const blocked = new Set([
    'authorization',
    'proxy-authorization',
    'x-api-key',
    'api-key',
  ]);
  const output = {};
  Object.entries(headers || {}).forEach(([key, value]) => {
    if (blocked.has(String(key).toLowerCase())) return;
    output[key] = value;
  });
  return output;
};

const taskDiskView = (task) => ({
  ...task,
  upstream: task.upstream
    ? {
        ...task.upstream,
        headers: sanitizeHeadersForDisk(task.upstream.headers),
      }
    : task.upstream,
});

const persistImageTasks = () => {
  const payload = {
    schemaVersion: 1,
    updatedAt: Date.now(),
    tasks: Array.from(imageTasks.values()).map(taskDiskView),
  };

  imageTasksSaveChain = imageTasksSaveChain.then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    const tmpPath = `${imageTasksPath}.${Date.now()}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await rename(tmpPath, imageTasksPath);
  }).catch((error) => {
    console.error('[project-store] failed to persist image tasks', error);
  });

  return imageTasksSaveChain;
};

const sanitizeHeaders = (headers) => {
  const blocked = new Set([
    'accept-encoding',
    'connection',
    'content-length',
    'host',
    'origin',
    'referer',
    'sec-fetch-dest',
    'sec-fetch-mode',
    'sec-fetch-site',
    'sec-ch-ua',
    'sec-ch-ua-mobile',
    'sec-ch-ua-platform',
    'te',
  ]);
  const output = {};
  Object.entries(headers || {}).forEach(([key, value]) => {
    const normalized = String(key).toLowerCase();
    if (blocked.has(normalized) || value == null) return;
    output[key] = Array.isArray(value) ? value.join(', ') : String(value);
  });
  return output;
};

const normalizeUpstreamUrl = (rawUrl) => {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new Error('Missing upstream URL.');
  }

  const input = new URL(rawUrl, 'http://local.bigbanana');
  const pathname = input.pathname;
  const search = input.search || '';

  if (pathname.startsWith('/api/ai-muling/')) {
    return `https://ai.muling.store/${pathname.slice('/api/ai-muling/'.length)}${search}`;
  }

  if (pathname.startsWith('/api/new-api')) {
    const baseUrl = process.env.PROJECT_STORE_NEW_API_BASE_URL || 'http://new-api-proxy:8788';
    return `${baseUrl.replace(/\/+$/, '')}${pathname.slice('/api/new-api'.length) || '/'}${search}`;
  }

  if (input.protocol === 'http:' || input.protocol === 'https:') {
    return input.toString();
  }

  throw new Error('Unsupported upstream URL.');
};

const dataUrlFromMediaUrl = async (mediaUrl) => {
  const filePath = mediaPathForUrl(mediaUrl);
  if (!filePath) return null;
  const bytes = await readFile(filePath);
  return `data:${contentTypeFor(filePath, bytes)};base64,${bytes.toString('base64')}`;
};

const extractImageFromProviderResponse = async (json) => {
  const geminiParts = json?.candidates?.flatMap((candidate) => candidate?.content?.parts || []) || [];
  for (const part of geminiParts) {
    if (part?.inlineData?.data) {
      return {
        dataUrl: `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`,
        responseFormat: 'gemini-image',
      };
    }
  }

  const firstData = Array.isArray(json?.data) ? json.data[0] : null;
  if (firstData?.b64_json) {
    return {
      dataUrl: `data:${firstData.mime_type || firstData.mimeType || 'image/png'};base64,${firstData.b64_json}`,
      responseFormat: 'openai-image',
    };
  }
  if (firstData?.url) {
    return {
      remoteUrl: firstData.url,
      responseFormat: 'openai-image',
    };
  }

  const outputItems = Array.isArray(json?.output) ? json.output : [];
  for (const item of outputItems) {
    const contentItems = Array.isArray(item?.content) ? item.content : [];
    for (const content of contentItems) {
      if (content?.image_base64) {
        return {
          dataUrl: `data:${content.mime_type || 'image/png'};base64,${content.image_base64}`,
          responseFormat: 'openai-image',
        };
      }
      if (content?.image_url || content?.url) {
        return {
          remoteUrl: content.image_url || content.url,
          responseFormat: 'openai-image',
        };
      }
    }
  }

  throw new Error('Provider response did not contain an image.');
};

const downloadRemoteImage = async (remoteUrl) => {
  const response = await fetch(remoteUrl);
  if (!response.ok) {
    throw new Error(`Image download failed with HTTP ${response.status}.`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const mimeType = response.headers.get('content-type') || contentTypeFor(remoteUrl, bytes);
  return { bytes, mimeType };
};

const runImageTask = async (task) => {
  task.status = 'running';
  task.startedAt = Date.now();
  task.updatedAt = Date.now();
  await persistImageTasks();
  console.log('[project-store] image task running', {
    id: task.id,
    responseFormat: task.responseFormat || null,
    upstreamUrl: task.upstreamPublicUrl || task.upstream.url,
  });

  try {
    const response = await fetch(task.upstream.url, {
      method: task.upstream.method || 'POST',
      headers: task.upstream.headers,
      body: task.upstream.body,
    });
    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`Provider request failed with HTTP ${response.status}: ${responseText.slice(0, 1000)}`);
    }

    let responseJson;
    try {
      responseJson = JSON.parse(responseText);
    } catch {
      throw new Error('Provider returned non-JSON response.');
    }

    const extracted = await extractImageFromProviderResponse(responseJson);
    let mediaResult;
    if (extracted.dataUrl) {
      mediaResult = await writeMediaFromDataUrl({
        dataUrl: extracted.dataUrl,
        folder: 'generated',
        filenamePrefix: task.id,
      });
    } else {
      const downloaded = await downloadRemoteImage(extracted.remoteUrl);
      mediaResult = await writeMediaBytes({
        bytes: downloaded.bytes,
        mimeType: downloaded.mimeType,
        folder: 'generated',
        filenamePrefix: task.id,
      });
    }

    task.status = 'completed';
    task.completedAt = Date.now();
    task.updatedAt = Date.now();
    task.imageUrl = mediaResult.url;
    task.mimeType = mediaResult.mimeType;
    task.bytes = mediaResult.bytes;
    task.responseFormat = task.responseFormat || extracted.responseFormat;
    task.error = null;
    console.log('[project-store] image task completed', {
      id: task.id,
      imageUrl: task.imageUrl,
      mimeType: task.mimeType,
      bytes: task.bytes,
    });
  } catch (error) {
    task.status = 'failed';
    task.failedAt = Date.now();
    task.updatedAt = Date.now();
    task.error = error instanceof Error ? error.message : 'Image task failed.';
    console.error('[project-store] image task failed', {
      id: task.id,
      upstreamUrl: task.upstreamPublicUrl || task.upstream.url,
      error: task.error,
    });
  } finally {
    await persistImageTasks();
  }
};

const drainImageTaskQueue = () => {
  while (activeImageWorkers < IMAGE_TASK_WORKERS && imageTaskQueue.length > 0) {
    const task = imageTaskQueue.shift();
    if (!task || task.status === 'completed') continue;
    activeImageWorkers += 1;
    runImageTask(task).finally(() => {
      activeImageWorkers -= 1;
      drainImageTaskQueue();
    });
  }
};

const enqueueImageTask = (task) => {
  if (!imageTaskQueue.some((queuedTask) => queuedTask.id === task.id)) {
    imageTaskQueue.push(task);
  }
  drainImageTaskQueue();
};

const taskPublicView = async (task, includeDataUrl = false) => {
  const view = {
    id: task.id,
    status: task.status,
    createdAt: task.createdAt,
    queuedAt: task.queuedAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    failedAt: task.failedAt,
    updatedAt: task.updatedAt,
    imageUrl: task.imageUrl || null,
    mimeType: task.mimeType || null,
    bytes: task.bytes || null,
    responseFormat: task.responseFormat || null,
    upstreamUrl: task.upstreamPublicUrl || null,
    error: task.error || null,
  };

  if (includeDataUrl && task.status === 'completed' && task.imageUrl) {
    view.dataUrl = await dataUrlFromMediaUrl(task.imageUrl);
  }

  return view;
};

const createPersistentImageTask = async ({ responseFormat, upstreamPublicUrl, upstream }) => {
  const id = taskId();
  const task = {
    id,
    status: 'queued',
    createdAt: Date.now(),
    queuedAt: Date.now(),
    updatedAt: Date.now(),
    createdAtIso: nowIso(),
    responseFormat: responseFormat || upstream.responseFormat || null,
    upstreamPublicUrl,
    upstream: {
      url: upstream.url,
      method: upstream.method || 'POST',
      headers: sanitizeHeaders(upstream.headers),
      body: typeof upstream.body === 'string' ? upstream.body : JSON.stringify(upstream.body || {}),
    },
    error: null,
  };

  imageTasks.set(id, task);
  await persistImageTasks();
  console.log('[project-store] image task queued', {
    id: task.id,
    responseFormat: task.responseFormat || null,
    upstreamUrl: task.upstreamPublicUrl || task.upstream.url,
  });
  enqueueImageTask(task);
  return task;
};

const newApiImageTaskView = async (task) => {
  const view = {
    taskId: task.id,
    status: task.status,
    createdAt: task.createdAt,
    startedAt: task.startedAt || null,
    finishedAt: task.completedAt || task.failedAt || null,
    result: null,
    error: null,
  };

  if (task.status === 'completed') {
    const dataUrl = task.imageUrl ? await dataUrlFromMediaUrl(task.imageUrl) : null;
    const parsed = dataUrl ? parseDataUrl(dataUrl) : null;
    view.result = {
      created: Math.floor((task.completedAt || Date.now()) / 1000),
      data: [{
        url: task.imageUrl || null,
        b64_json: parsed ? parsed.bytes.toString('base64') : undefined,
      }],
    };
  }

  if (task.status === 'failed') {
    view.error = {
      status: 500,
      message: task.error || 'Image generation task failed.',
    };
  }

  return view;
};

const loadImageTasks = async () => {
  try {
    const text = await readFile(imageTasksPath, 'utf8');
    const payload = JSON.parse(text);
    (payload.tasks || []).forEach((task) => {
      if (!task || !task.id) return;
      if (task.status === 'running') task.status = 'queued';
      imageTasks.set(task.id, task);
      if (task.status === 'queued') enqueueImageTask(task);
    });
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      console.error('[project-store] failed to load image tasks', error);
    }
  }
};

export const createProjectStoreHandler = () => async (req, res, next) => {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = requestUrl.pathname;
  const isNewApiImageTaskPath = pathname === '/api/new-api/image-tasks' || pathname.startsWith('/api/new-api/image-tasks/');

  try {
    if (
      pathname !== '/healthz'
      && pathname !== '/api/project-store/healthz'
      && !pathname.startsWith('/api/project-store/')
      && !isNewApiImageTaskPath
    ) {
      if (typeof next === 'function') {
        next();
        return;
      }
      writeJson(res, 404, { ok: false, message: 'Not found.' });
      return;
    }

    if (req.method === 'OPTIONS') {
      setCorsHeaders(res);
      res.statusCode = 204;
      res.end();
      return;
    }

    if (pathname === '/healthz' || pathname === '/api/project-store/healthz') {
      writeJson(res, 200, {
        ok: true,
        service: 'project-store',
        dataDir: DATA_DIR,
        backupFile: BACKUP_FILE,
      });
      return;
    }

    if (pathname === '/api/new-api/image-tasks' && req.method === 'POST') {
      const body = await readBody(req);
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        writeJson(res, 400, { success: false, message: 'Invalid JSON payload.', data: null });
        return;
      }

      try {
        const endpoint = String(payload?.endpoint || '').replace(/\/+$/, '');
        const taskPath = String(payload?.path || '/v1/images/generations');
        if (!endpoint) throw new Error('Missing image task endpoint.');
        if (!taskPath.startsWith('/')) throw new Error('Invalid image task path.');

        const task = await createPersistentImageTask({
          responseFormat: 'openai-image',
          upstreamPublicUrl: `${endpoint}${taskPath}`,
          upstream: {
            url: `${endpoint}${taskPath}`,
            method: 'POST',
            headers: {
              Accept: '*/*',
              'Content-Type': 'application/json',
              ...(payload?.authorization ? { Authorization: payload.authorization } : {}),
            },
            body: JSON.stringify(payload?.payload || {}),
          },
        });

        writeJson(res, 202, {
          success: true,
          message: '',
          data: {
            taskId: task.id,
            status: task.status,
          },
        });
      } catch (error) {
        writeJson(res, 400, {
          success: false,
          message: error instanceof Error ? error.message : 'Invalid image task payload.',
          data: null,
        });
      }
      return;
    }

    if (pathname.startsWith('/api/new-api/image-tasks/') && req.method === 'GET') {
      const id = decodeURIComponent(pathname.slice('/api/new-api/image-tasks/'.length));
      const task = imageTasks.get(id);
      if (!task) {
        writeJson(res, 404, {
          success: false,
          message: 'Image task not found or expired',
          data: null,
        });
        return;
      }

      const data = await newApiImageTaskView(task);
      writeJson(res, task.status === 'failed' ? 500 : 200, {
        success: task.status !== 'failed',
        message: task.status === 'failed' ? (task.error || 'Image generation task failed.') : '',
        data,
      });
      return;
    }

    if (pathname === '/api/project-store/backup' && req.method === 'GET') {
      try {
        const payload = await readBackup();
        writeJson(res, 200, { ok: true, payload });
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          writeJson(res, 404, { ok: false, message: 'No backup has been saved yet.' });
          return;
        }
        throw error;
      }
      return;
    }

    if (pathname === '/api/project-store/image-tasks' && req.method === 'GET') {
      const limit = Math.max(1, Math.min(200, Number.parseInt(requestUrl.searchParams.get('limit') || '50', 10)));
      const tasks = Array.from(imageTasks.values())
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        .slice(0, limit);
      writeJson(res, 200, {
        ok: true,
        tasks: await Promise.all(tasks.map((task) => taskPublicView(task, false))),
      });
      return;
    }

    if (pathname === '/api/project-store/image-tasks' && req.method === 'POST') {
      const body = await readBody(req);
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        writeJson(res, 400, { ok: false, message: 'Invalid JSON payload.' });
        return;
      }

      try {
        const upstream = payload?.upstream || {};
        const upstreamUrl = normalizeUpstreamUrl(upstream.url);
        const task = await createPersistentImageTask({
          responseFormat: payload.responseFormat || upstream.responseFormat || null,
          upstreamPublicUrl: upstream.url,
          upstream: {
            url: upstreamUrl,
            method: upstream.method || 'POST',
            headers: upstream.headers,
            body: typeof upstream.body === 'string' ? upstream.body : JSON.stringify(upstream.body || {}),
          },
        });

        writeJson(res, 202, { ok: true, task: await taskPublicView(task, false), taskId: task.id });
      } catch (error) {
        writeJson(res, 400, {
          ok: false,
          message: error instanceof Error ? error.message : 'Invalid image task payload.',
        });
      }
      return;
    }

    if (pathname.startsWith('/api/project-store/image-tasks/') && req.method === 'GET') {
      const id = decodeURIComponent(pathname.slice('/api/project-store/image-tasks/'.length));
      const task = imageTasks.get(id);
      if (!task) {
        writeJson(res, 404, { ok: false, message: 'Image task not found.' });
        return;
      }

      writeJson(res, 200, {
        ok: true,
        task: await taskPublicView(task, requestUrl.searchParams.get('includeDataUrl') === '1'),
      });
      return;
    }

    if (pathname.startsWith('/api/project-store/media/') && (req.method === 'GET' || req.method === 'HEAD')) {
      const mediaPath = resolveMediaPath(pathname);
      if (!mediaPath) {
        writeJson(res, 400, { ok: false, message: 'Invalid media path.' });
        return;
      }

      try {
        const bytes = await readFile(mediaPath);
        setCorsHeaders(res);
        res.statusCode = 200;
        res.setHeader('Content-Type', contentTypeFor(mediaPath, bytes));
        res.setHeader('Content-Length', String(bytes.length));
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.end(req.method === 'HEAD' ? undefined : bytes);
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          writeJson(res, 404, { ok: false, message: 'Media not found.' });
          return;
        }
        throw error;
      }
      return;
    }

    if (pathname === '/api/project-store/media' && req.method === 'POST') {
      const body = await readBody(req);
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        writeJson(res, 400, { ok: false, message: 'Invalid JSON payload.' });
        return;
      }

      try {
        const result = await writeMediaFromDataUrl(payload || {});
        writeJson(res, 200, { ok: true, ...result });
      } catch (error) {
        writeJson(res, 400, {
          ok: false,
          message: error instanceof Error ? error.message : 'Invalid media payload.',
        });
      }
      return;
    }

    if (pathname === '/api/project-store/backup' && req.method === 'PUT') {
      const body = await readBody(req);
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        writeJson(res, 400, { ok: false, message: 'Invalid JSON payload.' });
        return;
      }

      if (!isValidBackupPayload(payload)) {
        writeJson(res, 400, { ok: false, message: 'Invalid BigBanana backup payload.' });
        return;
      }

      await writeBackup({
        ...payload,
        serverPersistedAt: Date.now(),
      });

      writeJson(res, 200, { ok: true });
      return;
    }

    writeJson(res, 404, { ok: false, message: 'Not found.' });
  } catch (error) {
    writeJson(res, 500, {
      ok: false,
      message: error instanceof Error ? error.message : 'Internal server error.',
    });
  }
};

let imageTasksLoaded = false;
let imageTasksLoadPromise = null;

export const initializeProjectStore = async () => {
  if (imageTasksLoaded) return;
  if (!imageTasksLoadPromise) {
    imageTasksLoadPromise = loadImageTasks().then(() => {
      imageTasksLoaded = true;
    });
  }
  await imageTasksLoadPromise;
};

export const startProjectStoreServer = async () => {
  await initializeProjectStore();
  const server = http.createServer(createProjectStoreHandler());
  server.listen(PORT, HOST, () => {
    console.log(`[project-store] listening on http://${HOST}:${PORT} | data dir: ${DATA_DIR}`);
  });
  return server;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startProjectStoreServer();
}
