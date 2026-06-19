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
const MODEL_CONFIG_FILE = process.env.PROJECT_STORE_MODEL_CONFIG_FILE || 'model-config.json';
const MAX_BODY_BYTES = Number.parseInt(process.env.PROJECT_STORE_MAX_BODY_BYTES || `${200 * 1024 * 1024}`, 10);
const CORS_ORIGIN = process.env.PROJECT_STORE_CORS_ORIGIN || '*';
const IMAGE_TASK_WORKERS = Math.max(1, Number.parseInt(process.env.PROJECT_STORE_IMAGE_TASK_WORKERS || '1', 10));
const IMAGE_TASK_TIMEOUT_MS = Math.max(1000, Number.parseInt(process.env.PROJECT_STORE_IMAGE_TASK_TIMEOUT_MS || '600000', 10));
const IMAGE_TASK_TIMEOUT_MESSAGE = 'Image task timed out after 10 minutes.';
const NEW_API_CHANNEL_ID = process.env.PROJECT_STORE_NEW_API_CHANNEL_ID || 'custom';
const NEW_API_PROVIDER_ID = `newapi-${NEW_API_CHANNEL_ID}`;
const DEFAULT_IMAGE_MODEL_ID = process.env.PROJECT_STORE_DEFAULT_IMAGE_MODEL_ID || 'newapi-gpt-image-2';

const DEFAULT_NEW_API_IMAGE_MODELS = [
  {
    id: 'newapi-gpt-image-2',
    name: 'GPT Image 2',
    apiModel: 'gpt-image-2',
    requestFormat: 'openai-image',
    responseFormat: 'openai-image',
    endpoint: '/v1/images/generations',
  },
  {
    id: 'newapi-gemini-3-1-flash-image',
    name: 'Gemini 3.1 Flash Image',
    apiModel: 'gemini-3.1-flash-image',
    requestFormat: 'openai-chat-image',
    responseFormat: 'openai-chat-image',
    endpoint: '/v1/chat/completions',
  },
];

const IMAGE_FALLBACK_MODEL_ID = process.env.PROJECT_STORE_IMAGE_FALLBACK_MODEL_ID || 'newapi-gemini-3-1-flash-image';

const backupPath = path.join(DATA_DIR, BACKUP_FILE);
const imageTasksPath = path.join(DATA_DIR, IMAGE_TASKS_FILE);
const modelConfigPath = path.join(DATA_DIR, MODEL_CONFIG_FILE);
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

const contentTypeFor = (filePath, bytes) => {
  if (bytes && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes && bytes.subarray(0, 4).toString('ascii') === 'RIFF') return 'image/webp';
  if (bytes && bytes.subarray(4, 8).toString('ascii') === 'ftyp') return 'video/mp4';

  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.ogv') return 'video/ogg';
  return 'image/jpeg';
};

const extensionForMime = (mimeType) => {
  const normalized = String(mimeType || '').toLowerCase().split(';')[0].trim();
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/webp') return 'webp';
  if (normalized === 'image/gif') return 'gif';
  if (normalized === 'image/svg+xml') return 'svg';
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'jpg';
  if (normalized === 'video/mp4') return 'mp4';
  if (normalized === 'video/webm') return 'webm';
  if (normalized === 'video/quicktime') return 'mov';
  if (normalized === 'video/ogg') return 'ogv';
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

const normalizeBackupImageStates = (payload) => {
  if (!payload || typeof payload !== 'object') return { payload, changed: false };

  let changed = false;
  const activeTaskIds = new Set(
    Array.from(imageTasks.values())
      .filter((task) => task && (task.status === 'queued' || task.status === 'running'))
      .map((task) => task.id)
  );
  const staleMessage = 'stale generating state without active server image task';

  visitObjects(payload, (item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return;
    const status = String(item.status || '').toLowerCase();
    if (!['generating', 'queued', 'generating_image', 'generating_panels'].includes(status)) return;

    const taskId = String(item.serverImageTaskId || item.imageTaskId || item.recoveredImageTaskId || '').trim();
    if (taskId && activeTaskIds.has(taskId)) return;

    if (hasImageUrl(item)) {
      item.status = 'completed';
      item.imageTaskResolvedAt = item.imageTaskResolvedAt || Date.now();
      delete item.error;
      delete item.failureReason;
      delete item.lastTransientFailure;
    } else {
      item.status = 'failed';
      item.imageTaskResolvedAt = item.imageTaskResolvedAt || Date.now();
      item.error = item.error || staleMessage;
      item.lastTransientFailure = item.lastTransientFailure || staleMessage;
      delete item.failureReason;
    }
    changed = true;
  });

  if (changed) {
    payload.serverPersistedAt = Date.now();
    payload.imageStateNormalizedAt = Date.now();
  }

  return { payload, changed };
};

const readBackup = async ({ persistNormalized = false } = {}) => {
  const text = await readFile(backupPath, 'utf8');
  const payload = JSON.parse(text);
  const normalized = normalizeBackupImageStates(payload);
  if (persistNormalized && normalized.changed) {
    await writeBackup(normalized.payload);
  }
  return normalized.payload;
};

const emptyModelConfig = () => ({
  version: 1,
  providers: [],
  models: [],
  activeModels: {
    chat: '',
    image: '',
    video: '',
    audio: '',
  },
  activeModelChains: {
    chat: [],
    image: [],
    video: [],
    audio: [],
  },
  updatedAt: null,
});

const normalizeModelConfigPayload = (payload) => {
  const source = payload && typeof payload === 'object' && payload.config && typeof payload.config === 'object'
    ? payload.config
    : payload;

  if (!source || typeof source !== 'object') {
    throw new Error('Invalid model config payload.');
  }

  const providers = Array.isArray(source.providers)
    ? source.providers.map((provider) => ({
        ...provider,
        id: String(provider?.id || '').trim(),
        name: String(provider?.name || provider?.id || '').trim(),
        baseUrl: String(provider?.baseUrl || '').trim().replace(/\/+$/, ''),
        apiKey: typeof provider?.apiKey === 'string' && provider.apiKey.trim()
          ? provider.apiKey.trim()
          : undefined,
        isBuiltIn: false,
        isDefault: Boolean(provider?.isDefault),
      })).filter((provider) => provider.id && provider.baseUrl)
    : [];

  const modelTypes = new Set(['chat', 'image', 'video', 'audio']);
  const inferApiModelName = (model) => {
    const explicit = String(model?.apiModel || model?.model || '').trim();
    if (explicit) return explicit;
    const id = String(model?.id || '').trim();
    const type = String(model?.type || '').trim();
    const typedPrefix = `${type}:`;
    if (type && id.startsWith(typedPrefix)) {
      return id.slice(typedPrefix.length).trim();
    }
    const prefixIndex = id.indexOf(':');
    if (prefixIndex > 0 && modelTypes.has(id.slice(0, prefixIndex))) {
      return id.slice(prefixIndex + 1).trim();
    }
    return id;
  };

  const models = Array.isArray(source.models)
    ? source.models.map((model) => ({
        ...model,
        id: String(model?.id || '').trim(),
        apiModel: inferApiModelName(model),
        name: String(model?.name || inferApiModelName(model) || model?.id || '').trim(),
        type: String(model?.type || '').trim(),
        providerId: String(model?.providerId || '').trim(),
        endpoint: String(model?.endpoint || '').trim(),
        isBuiltIn: false,
        isEnabled: model?.isEnabled !== false,
      })).filter((model) => model.id && model.apiModel && model.type && model.providerId)
    : [];

  const activeModels = {
    chat: String(source.activeModels?.chat || '').trim(),
    image: String(source.activeModels?.image || '').trim(),
    video: String(source.activeModels?.video || '').trim(),
    audio: String(source.activeModels?.audio || '').trim(),
  };
  const activeModelChains = {
    chat: Array.isArray(source.activeModelChains?.chat) ? source.activeModelChains.chat.map(item => String(item || '').trim()).filter(Boolean) : [],
    image: Array.isArray(source.activeModelChains?.image) ? source.activeModelChains.image.map(item => String(item || '').trim()).filter(Boolean) : [],
    video: Array.isArray(source.activeModelChains?.video) ? source.activeModelChains.video.map(item => String(item || '').trim()).filter(Boolean) : [],
    audio: Array.isArray(source.activeModelChains?.audio) ? source.activeModelChains.audio.map(item => String(item || '').trim()).filter(Boolean) : [],
  };

  Object.keys(activeModels).forEach((type) => {
    if (!activeModels[type] && activeModelChains[type]?.[0]) {
      activeModels[type] = activeModelChains[type][0];
    }
    if (activeModels[type] && !activeModelChains[type].includes(activeModels[type])) {
      activeModelChains[type] = [activeModels[type], ...activeModelChains[type]];
    }
  });

  return {
    version: 1,
    providers,
    models,
    activeModels,
    activeModelChains,
    updatedAt: Date.now(),
  };
};

const readModelConfig = async () => {
  try {
    return normalizeModelConfigPayload(JSON.parse(await readFile(modelConfigPath, 'utf8')));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return emptyModelConfig();
    }
    throw error;
  }
};

const writeModelConfig = async (payload) => {
  const config = normalizeModelConfigPayload(payload);
  await mkdir(DATA_DIR, { recursive: true });
  const tmpPath = `${modelConfigPath}.${Date.now()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await rename(tmpPath, modelConfigPath);
  return config;
};

const modelsEndpointForBaseUrl = (baseUrl) => {
  const clean = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!clean) throw new Error('Missing API base URL.');
  return clean.endsWith('/v1') ? `${clean}/models` : `${clean}/v1/models`;
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
const imageTaskControllers = new Map();
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
  fallbackUpstreams: Array.isArray(task.fallbackUpstreams)
    ? task.fallbackUpstreams.map((upstream) => ({
        ...upstream,
        headers: sanitizeHeadersForDisk(upstream.headers),
      }))
    : task.fallbackUpstreams,
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

  if (pathname.startsWith('/api/new-api')) {
    const baseUrl = process.env.PROJECT_STORE_NEW_API_BASE_URL || 'http://new-api-proxy:8788';
    return `${baseUrl.replace(/\/+$/, '')}${pathname.slice('/api/new-api'.length) || '/'}${search}`;
  }

  if (input.protocol === 'http:' || input.protocol === 'https:') {
    return input.toString();
  }

  throw new Error('Unsupported upstream URL.');
};

const bearerAuthorization = (value) => {
  const authorization = String(value || '').trim();
  if (!authorization) return undefined;
  return /^Bearer\s+\S+/i.test(authorization) ? authorization : `Bearer ${authorization}`;
};

const parsedUrlOrNull = (rawUrl) => {
  try {
    return new URL(String(rawUrl || ''), 'http://local.bigbanana');
  } catch {
    return null;
  }
};

const urlsShareBase = (rawUrl, rawBaseUrl) => {
  const input = parsedUrlOrNull(rawUrl);
  const base = parsedUrlOrNull(rawBaseUrl);
  if (!input || !base) return false;
  if ((input.protocol !== 'http:' && input.protocol !== 'https:')
    || (base.protocol !== 'http:' && base.protocol !== 'https:')) {
    return false;
  }
  if (input.origin !== base.origin) return false;
  const basePath = base.pathname.replace(/\/+$/, '');
  return !basePath
    || basePath === '/'
    || input.pathname === basePath
    || input.pathname.startsWith(`${basePath}/`);
};

const readModelConfigSafely = async () => {
  try {
    return await readModelConfig();
  } catch (error) {
    console.warn('[project-store] failed to read model config for image task authorization', {
      error: error instanceof Error ? error.message : String(error),
    });
    return emptyModelConfig();
  }
};

const flattenModelConfigProviders = (config) => Array.isArray(config?.providers) ? config.providers : [];

const flattenModelConfigModels = (config) => Array.isArray(config?.models) ? config.models : [];

const modelNameOf = (value) => String(value || '').trim().toLowerCase();

const findProviderById = (config, providerId) => {
  const id = String(providerId || '').trim();
  if (!id) return null;
  return flattenModelConfigProviders(config).find((provider) => provider.id === id) || null;
};

const findModelByCandidate = (config, candidates) => {
  const normalized = new Set(candidates.map(modelNameOf).filter(Boolean));
  if (!normalized.size) return null;
  return flattenModelConfigModels(config).find((model) => normalized.has(modelNameOf(model.id))
    || normalized.has(modelNameOf(model.apiModel))) || null;
};

const authorizationForTaskUpstream = async ({
  rawUrl,
  providedAuthorization,
  metadata,
  imageModel,
}) => {
  const config = await readModelConfigSafely();
  const providerCandidates = [
    metadata?.activeImageModel?.providerId,
    metadata?.resolvedImageModel?.providerId,
    metadata?.completedImageModel?.providerId,
    imageModel?.providerId,
  ].filter(Boolean);

  for (const providerId of providerCandidates) {
    const provider = findProviderById(config, providerId);
    const authorization = bearerAuthorization(provider?.apiKey);
    if (authorization) return authorization;
  }

  const configuredModel = findModelByCandidate(config, [
    metadata?.activeImageModel?.id,
    metadata?.activeImageModel?.apiModel,
    metadata?.resolvedImageModel?.id,
    metadata?.resolvedImageModel?.apiModel,
    imageModel?.id,
    imageModel?.apiModel,
  ]);
  const modelProviderAuthorization = bearerAuthorization(
    findProviderById(config, configuredModel?.providerId)?.apiKey,
  );
  if (modelProviderAuthorization) return modelProviderAuthorization;

  const providerByUrl = flattenModelConfigProviders(config)
    .find((provider) => provider?.apiKey && urlsShareBase(rawUrl, provider.baseUrl));
  const urlAuthorization = bearerAuthorization(providerByUrl?.apiKey);
  if (urlAuthorization) return urlAuthorization;

  return bearerAuthorization(providedAuthorization);
};

const endpointBaseUrlForImageTask = async ({
  providedEndpoint,
  sourceBody,
  metadata,
  imageModel,
}) => {
  const explicitEndpoint = String(providedEndpoint || '').trim().replace(/\/+$/, '');
  if (explicitEndpoint) return explicitEndpoint;

  const config = await readModelConfigSafely();
  const configuredModel = findModelByCandidate(config, [
    sourceBody?.model,
    metadata?.activeImageModel?.id,
    metadata?.activeImageModel?.apiModel,
    metadata?.resolvedImageModel?.id,
    metadata?.resolvedImageModel?.apiModel,
    imageModel?.id,
    imageModel?.apiModel,
  ]);

  const provider = findProviderById(config, configuredModel?.providerId)
    || findProviderById(config, metadata?.activeImageModel?.providerId)
    || findProviderById(config, imageModel?.providerId);

  return String(provider?.baseUrl || '').trim().replace(/\/+$/, '');
};

const headersForTaskUpstream = async (task, upstream, imageModel) => {
  const headers = sanitizeHeaders(upstream?.headers || {});
  const providedAuthorization = headers.Authorization || headers.authorization;
  delete headers.authorization;
  const authorization = await authorizationForTaskUpstream({
    rawUrl: upstream?.upstreamPublicUrl || upstream?.url || task?.upstreamPublicUrl,
    providedAuthorization,
    metadata: task?.metadata,
    imageModel,
  });
  if (authorization) headers.Authorization = authorization;
  return headers;
};

const parseConfiguredImageModels = () => {
  const raw = process.env.PROJECT_STORE_IMAGE_MODELS_JSON;
  if (!raw || !raw.trim()) return DEFAULT_NEW_API_IMAGE_MODELS;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch (error) {
    console.warn('[project-store] invalid PROJECT_STORE_IMAGE_MODELS_JSON, using defaults', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return DEFAULT_NEW_API_IMAGE_MODELS;
};

const configuredImageModels = parseConfiguredImageModels().map((model) => {
  const apiModel = String(model.apiModel || model.model || model.id || '').trim();
  const requestFormat = String(model.requestFormat || model.params?.requestFormat || (
    apiModel === 'gemini-3.1-flash-image' ? 'openai-chat-image' : 'openai-image'
  ));
  return {
    id: String(model.id || `newapi-${apiModel}`).trim(),
    name: String(model.name || apiModel).trim(),
    apiModel,
    type: 'image',
    providerId: NEW_API_PROVIDER_ID,
    endpoint: String(model.endpoint || (
      requestFormat === 'openai-chat-image' ? '/v1/chat/completions' : '/v1/images/generations'
    )),
    requestFormat,
    responseFormat: String(model.responseFormat || requestFormat),
    isBuiltIn: false,
    isEnabled: model.isEnabled !== false,
    params: {
      apiFormat: requestFormat === 'openai-chat-image' ? 'openai-chat' : 'openai-image',
      requestFormat,
      responseFormat: String(model.responseFormat || requestFormat),
      defaultAspectRatio: '9:16',
      supportedAspectRatios: ['16:9', '9:16', '1:1'],
      outputImageCount: 1,
      resultSelectionMode: 'first',
      size: '1024x1024',
      aspectRatioSizeMap: {
        '16:9': '1024x1024',
        '9:16': '1024x1024',
        '1:1': '1024x1024',
      },
      ...(model.params && typeof model.params === 'object' ? model.params : {}),
    },
  };
}).filter((model) => model.id && model.apiModel);

const parseObjectBody = (sourceBody) => {
  const body = typeof sourceBody === 'string' ? (() => {
    try {
      return JSON.parse(sourceBody);
    } catch {
      return {};
    }
  })() : (sourceBody || {});
  return body && typeof body === 'object' ? body : {};
};

const inferImageRequestFormat = (model) => {
  const apiModel = modelNameOf(model?.apiModel || model?.model || model?.id);
  const endpoint = String(model?.endpoint || '').toLowerCase();
  if (endpoint.includes('/v1/chat/completions')) return 'openai-chat-image';
  if (/gemini.*(image|flash)|flash[-_ ]?image/.test(apiModel)) return 'openai-chat-image';
  return 'openai-image';
};

const imageRouteFromModelConfigModel = (model) => {
  if (!model || model.type !== 'image' || model.isEnabled === false) return null;
  const apiModel = String(model.apiModel || model.model || model.id || '').trim();
  if (!apiModel) return null;
  const requestFormat = inferImageRequestFormat({ ...model, apiModel });
  return {
    id: String(model.id || apiModel).trim(),
    name: String(model.name || apiModel).trim(),
    apiModel,
    type: 'image',
    providerId: String(model.providerId || '').trim(),
    endpoint: String(model.endpoint || (
      requestFormat === 'openai-chat-image' ? '/v1/chat/completions' : '/v1/images/generations'
    )),
    requestFormat,
    responseFormat: String(model.responseFormat || model.params?.responseFormat || requestFormat),
    isBuiltIn: false,
    isEnabled: model.isEnabled !== false,
    params: {
      ...(model.params && typeof model.params === 'object' ? model.params : {}),
      requestFormat,
      responseFormat: String(model.responseFormat || model.params?.responseFormat || requestFormat),
    },
  };
};

const imageRouteMatchesCandidate = (route, candidate) => {
  const normalized = modelNameOf(candidate);
  if (!normalized || !route) return false;
  return normalized === modelNameOf(route.id) || normalized === modelNameOf(route.apiModel);
};

const uniqueImageRoutes = (routes) => {
  const seen = new Set();
  return routes.filter((route) => {
    if (!route?.apiModel) return false;
    const key = `${modelNameOf(route.providerId)}:${modelNameOf(route.apiModel)}:${modelNameOf(route.endpoint)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const resolveImageModelRoutes = async (sourceBody, metadata) => {
  const body = parseObjectBody(sourceBody);
  const config = await readModelConfigSafely();
  const configuredRoutes = flattenModelConfigModels(config)
    .map(imageRouteFromModelConfigModel)
    .filter(Boolean);
  const routePool = [...configuredRoutes, ...configuredImageModels];
  const activeChainIds = Array.isArray(config?.activeModelChains?.image)
    ? config.activeModelChains.image
    : [];
  const activeChainRoutes = activeChainIds
    .map(id => routePool.find(route => imageRouteMatchesCandidate(route, id)))
    .filter(Boolean);
  const candidates = [
    body?.model,
    metadata?.activeImageModel?.apiModel,
    metadata?.activeImageModel?.id,
    metadata?.resolvedImageModel?.apiModel,
    metadata?.resolvedImageModel?.id,
    config?.activeModels?.image,
    DEFAULT_IMAGE_MODEL_ID,
  ].filter(Boolean);

  const explicitRoute = candidates
    .map(candidate => routePool.find(route => imageRouteMatchesCandidate(route, candidate)))
    .find(Boolean);
  const defaultRoute = routePool.find(route => imageRouteMatchesCandidate(route, DEFAULT_IMAGE_MODEL_ID))
    || configuredImageModels[0];
  const fallbackRoute = routePool.find(route => imageRouteMatchesCandidate(route, IMAGE_FALLBACK_MODEL_ID));

  if (activeChainRoutes.length > 0) {
    const explicitIsInActiveChain = explicitRoute
      && activeChainRoutes.some(route => imageRouteMatchesCandidate(route, explicitRoute.id)
        || imageRouteMatchesCandidate(route, explicitRoute.apiModel));

    return uniqueImageRoutes([
      explicitIsInActiveChain ? explicitRoute : null,
      ...activeChainRoutes,
    ].filter(Boolean));
  }

  return uniqueImageRoutes([
    explicitRoute,
    ...configuredRoutes,
    defaultRoute,
    fallbackRoute,
  ].filter(Boolean));
};

const findImageModelRoute = async (sourceBody, metadata) => {
  const routes = await resolveImageModelRoutes(sourceBody, metadata);
  return routes[0] || configuredImageModels[0] || DEFAULT_NEW_API_IMAGE_MODELS[0];
};

const imageRoutePublicView = (route) => route ? {
  id: route.id,
  apiModel: route.apiModel,
  providerId: route.providerId,
  endpoint: route.endpoint,
  requestFormat: route.requestFormat,
  responseFormat: route.responseFormat,
} : null;

const buildImageTaskUpstreamForRoute = async ({
  route,
  payload,
  sourcePayload,
  taskPath,
}) => {
  const endpoint = await endpointBaseUrlForImageTask({
    providedEndpoint: payload?.endpoint,
    sourceBody: sourcePayload,
    metadata: payload?.metadata,
    imageModel: route,
  });
  if (!endpoint) {
    throw new Error(`Missing image task endpoint for model ${route?.apiModel || route?.id || ''}.`);
  }

  const upstreamUrl = `${endpoint}${route?.endpoint || taskPath}`;
  const authorization = await authorizationForTaskUpstream({
    rawUrl: upstreamUrl,
    providedAuthorization: payload?.authorization,
    metadata: payload?.metadata,
    imageModel: route,
  });

  return {
    url: normalizeUpstreamUrl(upstreamUrl),
    method: 'POST',
    headers: {
      Accept: '*/*',
      'Content-Type': 'application/json',
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: route ? buildImageBodyForRoute(sourcePayload, route) : JSON.stringify(sourcePayload),
    upstreamPublicUrl: upstreamUrl,
    responseFormat: route?.responseFormat || route?.requestFormat || 'openai-image',
    imageModel: imageRoutePublicView(route),
  };
};

const buildOpenAiImageBody = (sourceBody, route) => {
  const parsed = typeof sourceBody === 'string' ? (() => {
    try {
      return JSON.parse(sourceBody);
    } catch {
      return {};
    }
  })() : (sourceBody || {});
  const prompt = extractPromptFromUpstreamBody(parsed);
  if (!prompt) {
    throw new Error('Missing image prompt.');
  }

  return JSON.stringify({
    ...parsed,
    model: route.apiModel || parsed.model || 'gpt-image-2',
    prompt,
    n: Number(parsed.n || route.params?.n || 1) || 1,
    size: parsed.size || route.params?.size || '1024x1024',
  });
};

const buildChatImageBody = (sourceBody, route) => {
  const prompt = extractPromptFromUpstreamBody(sourceBody);
  if (!prompt) {
    throw new Error('Missing image prompt.');
  }

  return JSON.stringify({
    model: route.apiModel || 'gemini-3.1-flash-image',
    messages: [{
      role: 'user',
      content: prompt,
    }],
  });
};

const buildImageBodyForRoute = (sourceBody, route) => (
  route.requestFormat === 'openai-chat-image'
    ? buildChatImageBody(sourceBody, route)
    : buildOpenAiImageBody(sourceBody, route)
);

const fallbackReasonFromError = (error) => {
  const message = String(error?.message || error || 'Image task attempt failed.');
  return message.slice(0, 1000);
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

  const choices = Array.isArray(json?.choices) ? json.choices : [];
  for (const choice of choices) {
    const images = Array.isArray(choice?.message?.images) ? choice.message.images : [];
    for (const image of images) {
      const url = image?.image_url?.url || image?.url;
      if (typeof url !== 'string' || !url.trim()) continue;
      if (url.startsWith('data:')) {
        return {
          dataUrl: url,
          responseFormat: 'openai-chat-image',
        };
      }
      return {
        remoteUrl: url,
        responseFormat: 'openai-chat-image',
      };
    }
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

const summarizeProviderErrorResponse = (status, responseText) => {
  const raw = String(responseText || '').trim();
  if (!raw) {
    return `Provider request failed with HTTP ${status}.`;
  }

  try {
    const json = JSON.parse(raw);
    const message = json?.error?.message || json?.message || json?.error || json?.detail;
    if (message) {
      const normalized = typeof message === 'string'
        ? message
        : JSON.stringify(message);
      return `Provider request failed with HTTP ${status}: ${normalized.trim()}`;
    }
  } catch {
    // Non-JSON provider errors are commonly HTML gateway pages. Compact them below.
  }

  const titleMatch = raw.match(/<title[^>]*>([^<]+)<\/title>/i);
  const headingMatch = raw.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  const htmlSummary = (titleMatch?.[1] || headingMatch?.[1] || '').replace(/\s+/g, ' ').trim();
  if (htmlSummary) {
    return `Provider request failed with HTTP ${status}: ${htmlSummary}`;
  }

  const compact = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return `Provider request failed with HTTP ${status}: ${compact.slice(0, 500)}`;
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

const extractPromptFromUpstreamBody = (body) => {
  let parsed;
  try {
    parsed = typeof body === 'string' ? JSON.parse(body) : body;
  } catch {
    return '';
  }

  if (typeof parsed?.prompt === 'string' && parsed.prompt.trim()) {
    return parsed.prompt.trim();
  }

  const texts = [];
  (parsed?.contents || []).forEach((content) => {
    (content?.parts || []).forEach((part) => {
      if (typeof part?.text === 'string' && part.text.trim()) {
        texts.push(part.text.trim());
      }
    });
  });

  (parsed?.messages || []).forEach((message) => {
    if (typeof message?.content === 'string' && message.content.trim()) {
      texts.push(message.content.trim());
      return;
    }
    if (Array.isArray(message?.content)) {
      message.content.forEach((part) => {
        if (typeof part?.text === 'string' && part.text.trim()) {
          texts.push(part.text.trim());
        }
      });
    }
  });

  return texts.join('\n\n').trim();
};

const normalizeText = (value) => String(value || '')
  .toLowerCase()
  .replace(/\s+/g, ' ')
  .trim();

const jsonSafeObject = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
};

const visitObjects = (root, visitor) => {
  const seen = new WeakSet();
  const walk = (value, pathParts) => {
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    visitor(value, pathParts);
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, [...pathParts, index]));
      return;
    }
    Object.entries(value).forEach(([key, item]) => walk(item, [...pathParts, key]));
  };
  walk(root, []);
};

const hasImageUrl = (item) => Boolean(item?.imageUrl || item?.referenceImage || item?.generatedImage);

const imageCandidateScore = (item, task) => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return 0;

  const taskPrompt = normalizeText(task.prompt || extractPromptFromUpstreamBody(task.upstream?.body));
  const target = task.target || task.metadata?.target || {};
  let score = 0;

  if (target.id && item.id && String(item.id) === String(target.id)) score += 1000;
  if (target.assetId && item.id && String(item.id) === String(target.assetId)) score += 1000;
  if (task.id && (item.serverImageTaskId === task.id || item.imageTaskId === task.id)) score += 900;

  const promptFields = [
    item.visualPrompt,
    item.prompt,
    item.imagePrompt,
    item.description,
    item.negativePrompt ? `${item.visualPrompt || item.prompt || ''}\n\n${item.negativePrompt}` : '',
  ].map(normalizeText).filter(Boolean);

  for (const field of promptFields) {
    if (!taskPrompt || !field) continue;
    if (field === taskPrompt) score += 500;
    else if (field.length > 30 && taskPrompt.includes(field)) score += 260;
    else if (taskPrompt.length > 30 && field.includes(taskPrompt)) score += 220;
  }

  const nameFields = [item.name, item.title].map(normalizeText).filter(Boolean);
  for (const field of nameFields) {
    if (field && taskPrompt.includes(field)) score += 120;
  }

  if (['pending', 'generating', 'failed', 'queued'].includes(String(item.status || '').toLowerCase())) score += 50;
  if (!hasImageUrl(item)) score += 40;
  if (hasImageUrl(item) && item.serverImageTaskId !== task.id && item.imageTaskId !== task.id) score -= 80;

  return score;
};

const applyImageTaskToProjectStore = async (task) => {
  if (!task || task.status !== 'completed' || !task.imageUrl) return false;

  let backup;
  try {
    backup = await readBackup();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }

  let best = null;
  visitObjects(backup, (item, pathParts) => {
    const score = imageCandidateScore(item, task);
    if (score <= 0) return;
    if (!best || score > best.score) {
      best = { item, pathParts, score };
    }
  });

  if (!best || best.score < 120) {
    task.projectStoreAppliedAt = task.projectStoreAppliedAt || null;
    task.projectStoreApplyError = 'No matching project-store image asset found.';
    return false;
  }

  best.item.status = 'completed';
  best.item.imageUrl = task.imageUrl;
  best.item.referenceImage = task.imageUrl;
  best.item.generatedImage = task.imageUrl;
  best.item.serverImageTaskId = task.id;
  best.item.imageTaskId = task.id;
  best.item.updatedAt = best.item.updatedAt || Date.now();
  delete best.item.lastTransientFailure;

  await writeBackup({
    ...backup,
    serverPersistedAt: Date.now(),
    imageTaskAppliedAt: Date.now(),
  });

  task.projectStoreAppliedAt = Date.now();
  task.projectStoreTargetPath = best.pathParts.join('.');
  task.projectStoreTargetId = best.item.id || null;
  delete task.projectStoreApplyError;

  console.log('[project-store] image task applied to project store', {
    id: task.id,
    targetId: task.projectStoreTargetId,
    targetPath: task.projectStoreTargetPath,
    score: best.score,
  });

  return true;
};

const reconcileCompletedImageTasksWithBackup = async () => {
  let changed = false;
  for (const task of imageTasks.values()) {
    if (!task || task.status !== 'completed' || !task.imageUrl || task.projectStoreAppliedAt) continue;
    try {
      changed = await applyImageTaskToProjectStore(task) || changed;
    } catch (error) {
      task.projectStoreApplyError = error instanceof Error ? error.message : String(error);
      console.error('[project-store] failed to reconcile image task with project store', {
        id: task.id,
        error: task.projectStoreApplyError,
      });
    }
  }
  if (changed) await persistImageTasks();
};

const runImageTask = async (task) => {
  if (task.status === 'canceled') return;

  task.status = 'running';
  task.startedAt = Date.now();
  task.updatedAt = Date.now();
  task.attempts = Array.isArray(task.attempts) ? task.attempts : [];
  await persistImageTasks();
  console.log('[project-store] image task running', {
    id: task.id,
    responseFormat: task.responseFormat || null,
    upstreamUrl: task.upstreamPublicUrl || task.upstream.url,
  });

  const controller = new AbortController();
  let didTimeout = false;
  const timeoutId = setTimeout(() => {
    didTimeout = true;
    controller.abort(new Error(IMAGE_TASK_TIMEOUT_MESSAGE));
  }, IMAGE_TASK_TIMEOUT_MS);
  imageTaskControllers.set(task.id, controller);

  try {
    const attemptUpstreams = [
      {
        kind: 'primary',
        upstreamPublicUrl: task.upstreamPublicUrl,
        upstream: task.upstream,
        responseFormat: task.responseFormat,
        imageModel: task.metadata?.resolvedImageModel || null,
      },
      ...(Array.isArray(task.fallbackUpstreams) ? task.fallbackUpstreams.map((fallback) => ({
        kind: 'fallback',
        upstreamPublicUrl: fallback.upstreamPublicUrl,
        upstream: fallback,
        responseFormat: fallback.responseFormat,
        imageModel: fallback.imageModel || null,
      })) : []),
    ];

    let extracted;
    let completedAttempt = null;
    let lastError = null;

    for (let index = 0; index < attemptUpstreams.length; index += 1) {
      const attemptConfig = attemptUpstreams[index];
      const startedAt = Date.now();
      const attempt = {
        index,
        kind: attemptConfig.kind,
        status: 'running',
        startedAt,
        upstreamUrl: attemptConfig.upstreamPublicUrl || attemptConfig.upstream?.url || null,
        responseFormat: attemptConfig.responseFormat || null,
        imageModel: imageRoutePublicView(attemptConfig.imageModel),
      };
      task.attempts.push(attempt);
      task.updatedAt = startedAt;
      await persistImageTasks();
      console.log('[project-store] image task attempt running', {
        id: task.id,
        index,
        kind: attempt.kind,
        model: attempt.imageModel?.apiModel || null,
        upstreamUrl: attempt.upstreamUrl,
      });

      try {
        const attemptHeaders = await headersForTaskUpstream(
          task,
          attemptConfig.upstream,
          attemptConfig.imageModel,
        );
        const response = await fetch(attemptConfig.upstream.url, {
          method: attemptConfig.upstream.method || 'POST',
          headers: attemptHeaders,
          body: attemptConfig.upstream.body,
          signal: controller.signal,
        });
        const responseText = await response.text();
        if (!response.ok) {
          const providerError = new Error(summarizeProviderErrorResponse(response.status, responseText));
          providerError.status = response.status;
          providerError.responseText = responseText;
          throw providerError;
        }

        let responseJson;
        try {
          responseJson = JSON.parse(responseText);
        } catch {
          throw new Error('Provider returned non-JSON response.');
        }

        extracted = await extractImageFromProviderResponse(responseJson);
        completedAttempt = attemptConfig;
        attempt.status = 'completed';
        attempt.completedAt = Date.now();
        task.updatedAt = attempt.completedAt;
        task.responseFormat = attemptConfig.responseFormat || task.responseFormat || extracted.responseFormat;
        task.metadata = {
          ...(task.metadata || {}),
          completedImageModel: imageRoutePublicView(attemptConfig.imageModel),
        };
        break;
      } catch (error) {
        lastError = error;
        const endedAt = Date.now();
        const hasNextAttempt = index < attemptUpstreams.length - 1;
        const fallbackReason = !didTimeout && task.status !== 'canceled' && hasNextAttempt
          ? fallbackReasonFromError(error)
          : null;
        attempt.status = fallbackReason ? 'failed-fallback' : 'failed';
        attempt.failedAt = endedAt;
        attempt.error = error instanceof Error ? error.message : 'Image task attempt failed.';
        task.updatedAt = endedAt;
        if (fallbackReason) {
          task.metadata = {
            ...(task.metadata || {}),
            fallbackReason,
          };
          console.warn('[project-store] image task attempt failed, trying fallback', {
            id: task.id,
            index,
            model: attempt.imageModel?.apiModel || null,
            error: attempt.error,
          });
          await persistImageTasks();
          continue;
        }
        throw error;
      }
    }

    if (!extracted || !completedAttempt) {
      throw lastError || new Error('Provider response did not contain an image.');
    }

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
    try {
      await applyImageTaskToProjectStore(task);
    } catch (error) {
      task.projectStoreApplyError = error instanceof Error ? error.message : String(error);
      console.error('[project-store] failed to apply image task to project store', {
        id: task.id,
        error: task.projectStoreApplyError,
      });
    }
    console.log('[project-store] image task completed', {
      id: task.id,
      imageUrl: task.imageUrl,
      mimeType: task.mimeType,
      bytes: task.bytes,
    });
  } catch (error) {
    const wasCanceled = task.status === 'canceled' && !didTimeout;
    task.status = wasCanceled ? 'canceled' : 'failed';
    if (wasCanceled) {
      task.canceledAt = task.canceledAt || Date.now();
      task.error = task.error || 'Image task canceled.';
    } else if (didTimeout) {
      task.failedAt = Date.now();
      task.error = IMAGE_TASK_TIMEOUT_MESSAGE;
    } else {
      task.failedAt = Date.now();
      task.error = error instanceof Error ? error.message : 'Image task failed.';
    }
    task.updatedAt = Date.now();
    console.error('[project-store] image task failed', {
      id: task.id,
      upstreamUrl: task.upstreamPublicUrl || task.upstream.url,
      error: task.error,
    });
  } finally {
    clearTimeout(timeoutId);
    imageTaskControllers.delete(task.id);
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
  if (task.status === 'canceled') return;
  if (!imageTaskQueue.some((queuedTask) => queuedTask.id === task.id)) {
    imageTaskQueue.push(task);
  }
  drainImageTaskQueue();
};

const cancelImageTask = async (task, reason = 'Image task canceled by user.') => {
  if (!task) return { ok: false, changed: false, message: 'Image task not found.' };
  if (task.status === 'completed') return { ok: false, changed: false, message: 'Image task already completed.' };
  if (task.status === 'failed' || task.status === 'canceled') return { ok: true, changed: false, message: 'Image task already finished.' };

  const queuedIndex = imageTaskQueue.findIndex((queuedTask) => queuedTask?.id === task.id);
  if (queuedIndex >= 0) imageTaskQueue.splice(queuedIndex, 1);

  task.status = 'canceled';
  task.canceledAt = Date.now();
  task.updatedAt = Date.now();
  task.error = reason;

  const controller = imageTaskControllers.get(task.id);
  if (controller) controller.abort(reason);

  await persistImageTasks();
  return { ok: true, changed: true, message: 'Image task canceled.' };
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
    canceledAt: task.canceledAt,
    updatedAt: task.updatedAt,
    imageUrl: task.imageUrl || null,
    mimeType: task.mimeType || null,
    bytes: task.bytes || null,
    responseFormat: task.responseFormat || null,
    upstreamUrl: task.upstreamPublicUrl || null,
    attempts: Array.isArray(task.attempts) ? task.attempts.map((attempt) => ({
      index: attempt.index,
      kind: attempt.kind,
      status: attempt.status,
      startedAt: attempt.startedAt,
      completedAt: attempt.completedAt || null,
      failedAt: attempt.failedAt || null,
      upstreamUrl: attempt.upstreamUrl || null,
      responseFormat: attempt.responseFormat || null,
      imageModel: attempt.imageModel || null,
      error: attempt.error || null,
    })) : [],
    prompt: task.prompt || extractPromptFromUpstreamBody(task.upstream?.body) || null,
    metadata: task.metadata || null,
    target: task.target || null,
    projectStoreAppliedAt: task.projectStoreAppliedAt || null,
    projectStoreTargetId: task.projectStoreTargetId || null,
    error: task.error || null,
  };

  if (includeDataUrl && task.status === 'completed' && task.imageUrl) {
    view.dataUrl = await dataUrlFromMediaUrl(task.imageUrl);
  }

  return view;
};

const createPersistentImageTask = async ({ responseFormat, upstreamPublicUrl, upstream, metadata, target }) => {
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
    fallbackUpstreams: Array.isArray(upstream.fallbackUpstreams)
      ? upstream.fallbackUpstreams.map((fallback) => ({
          url: fallback.url,
          method: fallback.method || 'POST',
          headers: sanitizeHeaders(fallback.headers),
          body: typeof fallback.body === 'string' ? fallback.body : JSON.stringify(fallback.body || {}),
          upstreamPublicUrl: fallback.upstreamPublicUrl || null,
          responseFormat: fallback.responseFormat || null,
          imageModel: jsonSafeObject(fallback.imageModel),
        }))
      : [],
    attempts: [],
    metadata: jsonSafeObject(metadata),
    target: jsonSafeObject(target),
    error: null,
  };
  task.prompt = extractPromptFromUpstreamBody(task.upstream.body) || null;

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

  if (task.status === 'failed' || task.status === 'canceled') {
    view.error = {
      status: task.status === 'canceled' ? 499 : 500,
      message: task.error || (task.status === 'canceled' ? 'Image generation task canceled.' : 'Image generation task failed.'),
    };
  }

  return view;
};

const loadImageTasks = async () => {
  try {
    const text = await readFile(imageTasksPath, 'utf8');
    const payload = JSON.parse(text);
    const now = Date.now();
    const tasksToResume = [];
    let changed = false;
    (payload.tasks || []).forEach((task) => {
      if (!task || !task.id) return;
      const status = String(task.status || '').toLowerCase();
      const isActive = status === 'queued' || status === 'running';
      const activeSince = Number(task.startedAt || task.queuedAt || task.createdAt || 0);
      if (isActive && activeSince && now - activeSince >= IMAGE_TASK_TIMEOUT_MS) {
        task.status = 'failed';
        task.failedAt = task.failedAt || now;
        task.updatedAt = now;
        task.error = IMAGE_TASK_TIMEOUT_MESSAGE;
        changed = true;
      } else if (status === 'running') {
        task.status = 'queued';
        task.updatedAt = now;
        tasksToResume.push(task);
        changed = true;
      } else if (status === 'queued') {
        tasksToResume.push(task);
      }
      imageTasks.set(task.id, task);
    });
    if (changed) await persistImageTasks();
    tasksToResume.forEach((task) => enqueueImageTask(task));
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

    if (pathname === '/api/project-store/model-config' && req.method === 'GET') {
      writeJson(res, 200, {
        ok: true,
        config: await readModelConfig(),
      });
      return;
    }

    if (pathname === '/api/project-store/model-config' && req.method === 'PUT') {
      const body = await readBody(req);
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        writeJson(res, 400, { ok: false, message: 'Invalid JSON payload.' });
        return;
      }

      try {
        const config = await writeModelConfig(payload);
        writeJson(res, 200, { ok: true, config });
      } catch (error) {
        writeJson(res, 400, {
          ok: false,
          message: error instanceof Error ? error.message : 'Invalid model config payload.',
        });
      }
      return;
    }

    if (pathname === '/api/project-store/model-config/fetch-models' && req.method === 'POST') {
      const body = await readBody(req);
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        writeJson(res, 400, { ok: false, message: 'Invalid JSON payload.' });
        return;
      }

      try {
        const baseUrl = String(payload?.baseUrl || '').trim();
        const apiKey = String(payload?.apiKey || '').trim();
        if (!baseUrl || !apiKey) throw new Error('API 地址和 API Key 都不能为空。');

        const upstreamResponse = await fetch(modelsEndpointForBaseUrl(baseUrl), {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: 'application/json',
          },
        });
        const text = await upstreamResponse.text();
        let upstreamPayload = null;
        try {
          upstreamPayload = text ? JSON.parse(text) : null;
        } catch {
          upstreamPayload = text;
        }

        if (!upstreamResponse.ok) {
          const detail = upstreamPayload?.error?.message || upstreamPayload?.message || `HTTP ${upstreamResponse.status}`;
          writeJson(res, upstreamResponse.status, { ok: false, message: detail });
          return;
        }

        writeJson(res, 200, { ok: true, payload: upstreamPayload });
      } catch (error) {
        writeJson(res, 400, {
          ok: false,
          message: error instanceof Error ? error.message : 'Failed to fetch models.',
        });
      }
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
        const taskPath = String(payload?.path || '/v1/images/generations');
        if (!taskPath.startsWith('/')) throw new Error('Invalid image task path.');
        const sourcePayload = payload?.payload && typeof payload.payload === 'object'
          ? payload.payload
          : {
              model: payload?.model,
              prompt: payload?.prompt,
              messages: payload?.messages,
              input: payload?.input,
              size: payload?.size,
              n: payload?.n,
              response_format: payload?.response_format,
              quality: payload?.quality,
              style: payload?.style,
            };
        const routes = await resolveImageModelRoutes(sourcePayload, payload?.metadata);
        if (routes.length === 0) throw new Error('No image model configured.');
        const upstreams = [];
        for (const route of routes) {
          upstreams.push(await buildImageTaskUpstreamForRoute({
            route,
            payload,
            sourcePayload,
            taskPath,
          }));
        }
        const primaryUpstream = upstreams[0];
        const fallbackUpstreams = upstreams.slice(1).map((upstream) => ({
          url: upstream.url,
          method: upstream.method,
          headers: upstream.headers,
          body: upstream.body,
          upstreamPublicUrl: upstream.upstreamPublicUrl,
          responseFormat: upstream.responseFormat,
          imageModel: upstream.imageModel,
        }));

        const task = await createPersistentImageTask({
          responseFormat: primaryUpstream.responseFormat,
          upstreamPublicUrl: primaryUpstream.upstreamPublicUrl,
          metadata: {
            ...(payload?.metadata || {}),
            resolvedImageModel: primaryUpstream.imageModel,
            imageModelChain: upstreams.map(upstream => upstream.imageModel).filter(Boolean),
          },
          target: payload?.target,
          upstream: {
            url: primaryUpstream.url,
            method: primaryUpstream.method,
            headers: primaryUpstream.headers,
            body: primaryUpstream.body,
            fallbackUpstreams,
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
        const payload = await readBackup({ persistNormalized: true });
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
        const authorization = await authorizationForTaskUpstream({
          rawUrl: upstream.url || upstreamUrl,
          providedAuthorization: upstream.headers?.Authorization || upstream.headers?.authorization,
          metadata: payload?.metadata,
        });
        const headers = {
          ...(upstream.headers || {}),
        };
        delete headers.authorization;
        if (authorization) headers.Authorization = authorization;
        const task = await createPersistentImageTask({
          responseFormat: payload.responseFormat || upstream.responseFormat || null,
          upstreamPublicUrl: upstream.url,
          metadata: payload?.metadata,
          target: payload?.target,
          upstream: {
            url: upstreamUrl,
            method: upstream.method || 'POST',
            headers,
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

    if (pathname.endsWith('/cancel') && req.method === 'POST') {
      const id = decodeURIComponent(pathname.slice('/api/project-store/image-tasks/'.length, -'/cancel'.length));
      const task = imageTasks.get(id);
      if (!task) {
        writeJson(res, 404, { ok: false, message: 'Image task not found.' });
        return;
      }

      const result = await cancelImageTask(task);
      writeJson(res, result.ok ? 200 : 409, {
        ok: result.ok,
        changed: result.changed,
        message: result.message,
        task: await taskPublicView(task, false),
      });
      return;
    }

    if (pathname.startsWith('/api/project-store/image-tasks/') && req.method === 'DELETE') {
      const id = decodeURIComponent(pathname.slice('/api/project-store/image-tasks/'.length));
      const task = imageTasks.get(id);
      if (!task) {
        writeJson(res, 404, { ok: false, message: 'Image task not found.' });
        return;
      }

      const result = await cancelImageTask(task);
      writeJson(res, result.ok ? 200 : 409, {
        ok: result.ok,
        changed: result.changed,
        message: result.message,
        task: await taskPublicView(task, false),
      });
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

      const normalized = normalizeBackupImageStates({
        ...payload,
        serverPersistedAt: Date.now(),
      });
      await writeBackup(normalized.payload);

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
      return reconcileCompletedImageTasksWithBackup();
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
