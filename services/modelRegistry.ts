/**
 * 模型注册中心
 * 管理所有已注册的模型，提供 CRUD 操作
 */

import {
  ModelType,
  ModelDefinition,
  ModelProvider,
  ModelRegistryState,
  ActiveModels,
  ActiveModelChains,
  ChatModelDefinition,
  ImageModelDefinition,
  VideoModelDefinition,
  AudioModelDefinition,
  AspectRatio,
  VideoDuration,
  DEFAULT_CHAT_PARAMS,
  DEFAULT_IMAGE_PARAMS,
  DEFAULT_VIDEO_PARAMS_SORA,
} from '../types/model';

// 浏览器运行缓存键名；服务端 model-config.json 是权威来源。
const STORAGE_KEY = 'bigbanana_model_registry';
const LEGACY_API_KEY_STORAGE_KEY = 'antsk_api_key';

const EMPTY_ACTIVE_MODELS: ActiveModels = {
  chat: '',
  image: '',
  video: '',
  audio: '',
};

const EMPTY_ACTIVE_MODEL_CHAINS: ActiveModelChains = {
  chat: [],
  image: [],
  video: [],
  audio: [],
};

// 规范化 URL（去尾部斜杠、转小写）用于去重
const normalizeBaseUrl = (url: string): string => url.trim().replace(/\/+$/, '').toLowerCase();

const emptyProvider: ModelProvider = {
  id: '',
  name: '',
  baseUrl: '',
  isBuiltIn: false,
  isDefault: false,
};

const MODEL_TYPE_PROVIDER_IDS: Record<ModelType, string> = {
  chat: 'custom-chat-provider',
  image: 'custom-image-provider',
  video: 'custom-video-provider',
  audio: 'custom-audio-provider',
};

// 运行时状态缓存
let registryState: ModelRegistryState | null = null;

const uniqueStrings = (values: string[]): string[] => {
  const seen = new Set<string>();
  return values
    .map(value => String(value || '').trim())
    .filter((value) => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
};

const modelIdForType = (type: ModelType, apiModel: string): string => `${type}:${apiModel.trim()}`;

const inferStoredApiModel = (model: Partial<ModelDefinition>): string => {
  const explicit = (model as any).apiModel?.trim?.() || (model as any).model?.trim?.();
  if (explicit) return explicit;
  const id = model.id?.trim?.() || '';
  const type = model.type?.trim?.() as ModelType | undefined;
  if (type && id.startsWith(`${type}:`)) {
    return id.slice(type.length + 1).trim();
  }
  const separatorIndex = id.indexOf(':');
  const prefix = separatorIndex > 0 ? id.slice(0, separatorIndex) : '';
  if ((Object.keys(EMPTY_ACTIVE_MODELS) as string[]).includes(prefix)) {
    return id.slice(separatorIndex + 1).trim();
  }
  return id;
};

export const inferEndpointForApiModel = (type: ModelType, apiModel: string, fallbackEndpoint?: string): string => {
  if (type !== 'image') {
    return fallbackEndpoint?.trim() || defaultEndpointForType(type);
  }

  const normalized = apiModel.toLowerCase();
  if (/gemini.*(image|flash)|flash[-_ ]?image/.test(normalized)) {
    return '/v1/chat/completions';
  }
  if (/gpt[-_ ]?image|dall[-_ ]?e|image|imagen|flux|sdxl|stable[-_ ]?diffusion|midjourney/.test(normalized)) {
    return '/v1/images/generations';
  }
  return fallbackEndpoint?.trim() || defaultEndpointForType(type);
};

const normalizeActiveModelChains = (
  value: Partial<ActiveModelChains> | null | undefined,
  activeModels: ActiveModels,
  models: ModelDefinition[]
): ActiveModelChains => {
  const next: ActiveModelChains = { ...EMPTY_ACTIVE_MODEL_CHAINS };
  (Object.keys(EMPTY_ACTIVE_MODELS) as ModelType[]).forEach((type) => {
    const enabledIds = new Set(
      models
        .filter(model => model.type === type && model.isEnabled !== false)
        .map(model => model.id)
    );
    const rawChain = Array.isArray(value?.[type]) ? value?.[type] || [] : [];
    const candidates = uniqueStrings([
      activeModels[type],
      ...rawChain,
    ]);
    const filtered = candidates.filter(id => enabledIds.size === 0 || enabledIds.has(id));
    next[type] = filtered;
    activeModels[type] = filtered[0] || '';
  });
  return next;
};

const normalizeRegistryState = (value: Partial<ModelRegistryState> | null | undefined): ModelRegistryState => {
  const providers = Array.isArray(value?.providers)
    ? value.providers.filter((provider): provider is ModelProvider => Boolean(provider && provider.id && provider.baseUrl)).map(provider => ({
        ...provider,
        isBuiltIn: false,
      }))
    : [];
  const models = Array.isArray(value?.models)
    ? value.models.filter((model): model is ModelDefinition => Boolean(model && model.id && model.type && model.providerId)).map(model => ({
        ...model,
        apiModel: inferStoredApiModel(model),
        isBuiltIn: false,
        isEnabled: model.isEnabled !== false,
      }))
    : [];
  const activeModels = {
    ...EMPTY_ACTIVE_MODELS,
    ...(value?.activeModels || {}),
  };
  const activeModelChains = normalizeActiveModelChains(value?.activeModelChains, activeModels, models);
  return {
    providers,
    models,
    activeModels,
    activeModelChains,
    globalApiKey: undefined,
  };
};

const modelConfigEndpoint = '/api/project-store/model-config';

// ============================================
// 状态管理
// ============================================

/**
 * 获取默认状态
 */
const getDefaultState = (): ModelRegistryState => ({
  providers: [],
  models: [],
  activeModels: { ...EMPTY_ACTIVE_MODELS },
  activeModelChains: { ...EMPTY_ACTIVE_MODEL_CHAINS },
  globalApiKey: undefined,
});

/**
 * 从 localStorage 加载状态
 */
export const loadRegistry = (): ModelRegistryState => {
  if (registryState) {
    return registryState;
  }

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as ModelRegistryState;
      const deprecatedVideoModelIds = [
        'veo-3.1',
        'veo-r2v',
        'veo_3_0_r2v_fast_portrait',
        'veo_3_0_r2v_fast_landscape',
        'veo_3_1_t2v_fast_landscape',
        'veo_3_1_t2v_fast_portrait',
        'veo_3_1_i2v_s_fast_fl_landscape',
        'veo_3_1_i2v_s_fast_fl_portrait',
      ];
      
      parsed.providers = Array.isArray(parsed.providers) ? parsed.providers : [];
      parsed.models = Array.isArray(parsed.models) ? parsed.models : [];
      parsed.activeModels = {
        ...EMPTY_ACTIVE_MODELS,
        ...(parsed.activeModels || {}),
      };
      parsed.activeModelChains = {
        ...EMPTY_ACTIVE_MODEL_CHAINS,
        ...((parsed as any).activeModelChains || {}),
      };
      delete (parsed as any).globalApiKey;
      
      const providerCountBeforeBuiltInCleanup = parsed.providers.length;
      const modelCountBeforeBuiltInCleanup = parsed.models.length;

      // 内置模型/提供商已移除，迁移时清理历史内置项。
      parsed.providers = parsed.providers.filter(p => !p.isBuiltIn);
      parsed.models = parsed.models.filter(m => !m.isBuiltIn);
      
      // 迁移缺失的 apiModel（优先从 id 或 providerId 前缀推断）
      parsed.models = parsed.models.map(m => {
        if (m.apiModel) return m;
        if (m.providerId && m.id.startsWith(`${m.providerId}:`)) {
          return { ...m, apiModel: m.id.slice(m.providerId.length + 1) };
        }
        return { ...m, apiModel: inferStoredApiModel(m) };
      });

      // 清理旧的已废弃视频模型
      const modelCountBefore = parsed.models.length;
      parsed.models = parsed.models.filter(
        m => !(m.type === 'video' && deprecatedVideoModelIds.includes(m.id))
      );
      const modelsRemoved = modelCountBefore - parsed.models.length;

      // 迁移激活视频模型
      let activeModelMigrated = false;
      if (
        deprecatedVideoModelIds.includes(parsed.activeModels.video) ||
        parsed.activeModels.video === 'veo_3_1' ||
        parsed.activeModels.video?.startsWith('veo_3_1_')
      ) {
        parsed.activeModels.video = '';
        parsed.activeModelChains.video = parsed.activeModelChains.video.filter(
          id => !deprecatedVideoModelIds.includes(id) && id !== 'veo_3_1' && !id.startsWith('veo_3_1_')
        );
        activeModelMigrated = true;
      }
      
      if (localStorage.getItem(LEGACY_API_KEY_STORAGE_KEY)) {
        localStorage.removeItem(LEGACY_API_KEY_STORAGE_KEY);
      }
      
      registryState = normalizeRegistryState(parsed);

      // 如果发生了迁移，立即回写 localStorage，避免每次加载都重复执行
      const builtInItemsRemoved =
        providerCountBeforeBuiltInCleanup !== parsed.providers.length ||
        modelCountBeforeBuiltInCleanup !== parsed.models.length;

      if (builtInItemsRemoved || modelsRemoved > 0 || activeModelMigrated) {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(registryState));
          console.log(`🔄 模型注册中心迁移完成：清理 ${modelsRemoved} 个废弃模型`);
        } catch (e) {
          // 回写失败不影响运行，下次加载仍会重新迁移
        }
      }

      return registryState;
    }
  } catch (e) {
    console.error('加载模型注册中心失败:', e);
  }

  registryState = getDefaultState();
  return registryState;
};

/**
 * 保存状态到 localStorage
 */
export const saveRegistry = (state: ModelRegistryState): void => {
  try {
    const normalized = normalizeRegistryState(state);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    registryState = normalized;
  } catch (e) {
    console.error('保存模型注册中心失败:', e);
  }
};

/**
 * 从服务端加载模型配置。服务端是权威来源，localStorage 只作为运行缓存。
 */
export const fetchServerModelConfiguration = async (): Promise<ModelRegistryState | null> => {
  try {
    const response = await fetch(modelConfigEndpoint, { cache: 'no-store' });
    if (!response.ok) return null;
    const result = await response.json();
    if (!result?.ok || !result?.config) return null;

    const normalized = normalizeRegistryState(result.config);
    saveRegistry(normalized);
    return normalized;
  } catch (error) {
    console.warn('加载服务端模型配置失败，继续使用浏览器缓存。', error);
    return null;
  }
};

/**
 * 将当前模型配置保存到服务端，并同步浏览器缓存。
 */
export const saveServerModelConfiguration = async (state: ModelRegistryState = loadRegistry()): Promise<ModelRegistryState> => {
  const normalized = normalizeRegistryState(state);
  const response = await fetch(modelConfigEndpoint, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config: normalized }),
  });

  let result: any = null;
  try {
    result = await response.json();
  } catch {
    result = null;
  }

  if (!response.ok || !result?.ok || !result?.config) {
    throw new Error(result?.message || `服务端模型配置保存失败：HTTP ${response.status}`);
  }

  const saved = normalizeRegistryState(result.config);
  saveRegistry(saved);
  return saved;
};

/**
 * 获取当前状态
 */
export const getRegistryState = (): ModelRegistryState => {
  return loadRegistry();
};

/**
 * 重置为默认状态
 */
export const resetRegistry = (): void => {
  registryState = null;
  localStorage.removeItem(STORAGE_KEY);
  loadRegistry();
};

// ============================================
// 提供商管理
// ============================================

/**
 * 获取所有提供商
 */
export const getProviders = (): ModelProvider[] => {
  return loadRegistry().providers;
};

/**
 * 根据 ID 获取提供商
 */
export const getProviderById = (id: string): ModelProvider | undefined => {
  return getProviders().find(p => p.id === id);
};

/**
 * 获取默认提供商
 */
export const getDefaultProvider = (): ModelProvider => {
  return getProviders().find(p => p.isDefault) || getProviders()[0] || emptyProvider;
};

/**
 * 添加提供商
 */
export const addProvider = (provider: Omit<ModelProvider, 'id' | 'isBuiltIn'>): ModelProvider => {
  const state = loadRegistry();
  const normalized = normalizeBaseUrl(provider.baseUrl);
  const existing = state.providers.find(p => normalizeBaseUrl(p.baseUrl) === normalized);
  if (existing) return existing;
  const newProvider: ModelProvider = {
    ...provider,
    id: `provider_${Date.now()}`,
    isBuiltIn: false,
  };
  state.providers.push(newProvider);
  saveRegistry(state);
  return newProvider;
};

/**
 * 更新提供商
 */
export const updateProvider = (id: string, updates: Partial<ModelProvider>): boolean => {
  const state = loadRegistry();
  const index = state.providers.findIndex(p => p.id === id);
  if (index === -1) return false;

  // 内置提供商不能修改某些属性
  if (state.providers[index].isBuiltIn) {
    delete updates.id;
    delete updates.isBuiltIn;
    delete updates.baseUrl;
  }

  state.providers[index] = { ...state.providers[index], ...updates };
  saveRegistry(state);
  return true;
};

/**
 * 删除提供商
 */
export const removeProvider = (id: string): boolean => {
  const state = loadRegistry();
  const provider = state.providers.find(p => p.id === id);
  
  // 不能删除内置提供商
  if (!provider || provider.isBuiltIn) return false;
  
  // 删除该提供商的所有模型
  state.models = state.models.filter(m => m.providerId !== id);
  state.providers = state.providers.filter(p => p.id !== id);
  
  saveRegistry(state);
  return true;
};

// ============================================
// 模型管理
// ============================================

/**
 * 获取所有模型
 */
export const getModels = (type?: ModelType): ModelDefinition[] => {
  const models = loadRegistry().models;
  if (type) {
    return models.filter(m => m.type === type);
  }
  return models;
};

/**
 * 获取对话模型列表
 */
export const getChatModels = (): ChatModelDefinition[] => {
  return getModels('chat') as ChatModelDefinition[];
};

/**
 * 获取图片模型列表
 */
export const getImageModels = (): ImageModelDefinition[] => {
  return getModels('image') as ImageModelDefinition[];
};

/**
 * 获取视频模型列表
 */
export const getVideoModels = (): VideoModelDefinition[] => {
  return getModels('video') as VideoModelDefinition[];
};

/**
 * 获取音频模型列表
 */
export const getAudioModels = (): AudioModelDefinition[] => {
  return getModels('audio') as AudioModelDefinition[];
};

/**
 * 根据 ID 获取模型
 */
export const getModelById = (id: string): ModelDefinition | undefined => {
  return getModels().find(m => m.id === id);
};

/**
 * 获取当前激活的模型
 */
export const getActiveModel = (type: ModelType): ModelDefinition | undefined => {
  const state = loadRegistry();
  const activeId = state.activeModelChains[type]?.[0] || state.activeModels[type];
  return getModelById(activeId);
};

/**
 * 获取当前激活模型链。
 */
export const getActiveModelChainIds = (type: ModelType): string[] => {
  const state = loadRegistry();
  const chain = state.activeModelChains[type] || [];
  return chain.length ? chain : (state.activeModels[type] ? [state.activeModels[type]] : []);
};

export const getActiveModelChain = (type: ModelType): ModelDefinition[] => {
  const ids = getActiveModelChainIds(type);
  return ids
    .map(id => getModelById(id))
    .filter((model): model is ModelDefinition => Boolean(model && model.type === type && model.isEnabled));
};

/**
 * 获取当前激活的对话模型
 */
export const getActiveChatModel = (): ChatModelDefinition | undefined => {
  return getActiveModel('chat') as ChatModelDefinition | undefined;
};

/**
 * 获取当前激活的图片模型
 */
export const getActiveImageModel = (): ImageModelDefinition | undefined => {
  return getActiveModel('image') as ImageModelDefinition | undefined;
};

/**
 * 获取当前激活的视频模型
 */
export const getActiveVideoModel = (): VideoModelDefinition | undefined => {
  return getActiveModel('video') as VideoModelDefinition | undefined;
};

/**
 * 获取当前激活的音频模型
 */
export const getActiveAudioModel = (): AudioModelDefinition | undefined => {
  return getActiveModel('audio') as AudioModelDefinition | undefined;
};

/**
 * 设置激活的模型
 */
export const setActiveModel = (type: ModelType, modelId: string): boolean => {
  const model = getModelById(modelId);
  if (!model || model.type !== type || !model.isEnabled) return false;

  const state = loadRegistry();
  const existingChain = state.activeModelChains[type] || [];
  state.activeModelChains[type] = uniqueStrings([modelId, ...existingChain.filter(id => id !== modelId)]);
  state.activeModels[type] = modelId;
  saveRegistry(state);
  return true;
};

export const setActiveModelChain = (type: ModelType, modelIds: string[]): boolean => {
  const state = loadRegistry();
  const chain = uniqueStrings(modelIds).filter((id) => {
    const model = state.models.find(item => item.id === id);
    return Boolean(model && model.type === type && model.isEnabled !== false);
  });
  state.activeModelChains[type] = chain;
  state.activeModels[type] = chain[0] || '';
  saveRegistry(state);
  return true;
};

/**
 * 注册新模型
 * @param model - 模型定义（可包含自定义 id，不包含 isBuiltIn）
 */
export const registerModel = (model: Omit<ModelDefinition, 'id' | 'isBuiltIn'> & { id?: string }): ModelDefinition => {
  const state = loadRegistry();
  
  const providedId = (model as any).id?.trim();
  const apiModel = (model as any).apiModel?.trim();
  const baseId = providedId || (apiModel ? `${model.providerId}:${apiModel}` : `model_${Date.now()}`);
  let modelId = baseId;

  // 若未显式提供 ID，则自动生成唯一 ID（允许 API 模型名重复）
  if (!providedId) {
    let suffix = 1;
    while (state.models.some(m => m.id === modelId)) {
      modelId = `${baseId}_${suffix++}`;
    }
  } else if (state.models.some(m => m.id === modelId)) {
    throw new Error(`模型 ID "${modelId}" 已存在，请使用其他 ID`);
  }
  
  const newModel = {
    ...model,
    id: modelId,
    apiModel: apiModel || (model.providerId && modelId.startsWith(`${model.providerId}:`)
      ? modelId.slice(model.providerId.length + 1)
      : modelId),
    isBuiltIn: false,
  } as ModelDefinition;
  
  state.models.push(newModel);
  saveRegistry(state);
  return newModel;
};

/**
 * 更新模型
 */
export const updateModel = (id: string, updates: Partial<ModelDefinition>): boolean => {
  const state = loadRegistry();
  const index = state.models.findIndex(m => m.id === id);
  if (index === -1) return false;

  // 内置模型仅开放少量可编辑字段：
  // - isEnabled: 启用/禁用
  // - params: 参数偏好（比例、时长等）
  // - apiKey: 模型专属密钥（覆盖全局/Provider）
  if (state.models[index].isBuiltIn) {
    const allowedUpdates: Partial<ModelDefinition> = {};
    if (updates.isEnabled !== undefined) allowedUpdates.isEnabled = updates.isEnabled;
    if (updates.params) allowedUpdates.params = updates.params as any;
    if (updates.apiKey !== undefined) {
      allowedUpdates.apiKey = updates.apiKey?.trim() || undefined;
    }
    state.models[index] = { ...state.models[index], ...allowedUpdates } as ModelDefinition;
  } else {
    state.models[index] = { ...state.models[index], ...updates } as ModelDefinition;
  }

  saveRegistry(state);
  return true;
};

/**
 * 删除模型
 */
export const removeModel = (id: string): boolean => {
  const state = loadRegistry();
  const model = state.models.find(m => m.id === id);
  
  // 不能删除内置模型
  if (!model || model.isBuiltIn) return false;
  
  // 如果删除的是当前激活的模型，切换到同类型的第一个启用模型
  state.activeModelChains[model.type] = (state.activeModelChains[model.type] || []).filter(modelId => modelId !== id);
  if (state.activeModels[model.type] === id) {
    const fallback = state.models.find(m => m.type === model.type && m.id !== id && m.isEnabled);
    state.activeModels[model.type] = state.activeModelChains[model.type]?.[0] || fallback?.id || '';
  }
  
  state.models = state.models.filter(m => m.id !== id);
  saveRegistry(state);
  return true;
};

/**
 * 启用/禁用模型
 */
export const toggleModelEnabled = (id: string, enabled: boolean): boolean => {
  return updateModel(id, { isEnabled: enabled });
};

// ============================================
// API Key 管理
// ============================================

/**
 * 获取全局 API Key
 */
export const getGlobalApiKey = (): string | undefined => {
  return undefined;
};

/**
 * 设置全局 API Key
 */
export const setGlobalApiKey = (apiKey: string): void => {
  const state = loadRegistry();
  state.globalApiKey = undefined;
  localStorage.removeItem(LEGACY_API_KEY_STORAGE_KEY);
  saveRegistry(state);
};

/**
 * 获取模型对应的 API Key
 * 优先级：模型专属 Key > 提供商 Key > 全局 Key
 */
export const getApiKeyForModel = (modelId: string): string | undefined => {
  const model = getModelById(modelId);
  if (!model) return getGlobalApiKey();
  
  // 1. 优先使用模型专属 API Key
  if (model.apiKey) {
    return model.apiKey;
  }
  
  // 2. 其次使用提供商的 API Key
  const provider = getProviderById(model.providerId);
  if (provider?.apiKey) {
    return provider.apiKey;
  }
  
  // 3. 最后使用全局 API Key
  return undefined;
};

/**
 * 获取模型对应的 API 基础 URL
 */
export const getApiBaseUrlForModel = (modelId: string): string => {
  const model = getModelById(modelId);
  if (!model) return '';
  
  const provider = getProviderById(model.providerId);
  const baseUrl = provider?.baseUrl || '';
  return baseUrl.replace(/\/+$/, '');
};

const defaultEndpointForType = (type: ModelType): string => {
  switch (type) {
    case 'chat':
      return '/v1/chat/completions';
    case 'image':
      return '/v1/images/generations';
    case 'video':
      return '/v1/videos';
    case 'audio':
      return '/v1/audio/speech';
  }
};

const defaultParamsForType = (type: ModelType): any => {
  switch (type) {
    case 'chat':
      return { ...DEFAULT_CHAT_PARAMS };
    case 'image':
      return {
        ...DEFAULT_IMAGE_PARAMS,
        supportedAspectRatios: ['16:9', '9:16', '1:1'],
      };
    case 'video':
      return { ...DEFAULT_VIDEO_PARAMS_SORA };
    case 'audio':
      return { defaultVoice: 'alloy', outputFormat: 'mp3' };
  }
};

const displayNameForType = (type: ModelType): string => {
  switch (type) {
    case 'chat':
      return '对话模型 API';
    case 'image':
      return '图片模型 API';
    case 'video':
      return '视频模型 API';
    case 'audio':
      return '音频模型 API';
  }
};

export interface TypeModelConfigurationInput {
  type: ModelType;
  baseUrl: string;
  apiKey: string;
  apiModel: string;
  endpoint?: string;
  displayName?: string;
}

export interface TypeModelConfigurationsInput {
  type: ModelType;
  baseUrl: string;
  apiKey: string;
  apiModels: string[];
  displayNames?: Record<string, string>;
}

/**
 * 按模型类型保存一套 API 地址、API Key 和选中模型。
 */
export const saveTypeModelConfiguration = (input: TypeModelConfigurationInput): ModelDefinition => {
  const [model] = saveTypeModelConfigurations({
    type: input.type,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    apiModels: [input.apiModel],
    displayNames: input.displayName ? { [input.apiModel]: input.displayName } : undefined,
  });
  return model;
};

/**
 * 按模型类型保存一组有序模型。执行时按顺序 fallback。
 */
export const saveTypeModelConfigurations = (input: TypeModelConfigurationsInput): ModelDefinition[] => {
  const state = loadRegistry();
  const providerId = MODEL_TYPE_PROVIDER_IDS[input.type];
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
  const apiKey = input.apiKey.trim();
  const apiModels = uniqueStrings(input.apiModels);
  const now = Date.now();

  if (!baseUrl || !apiKey || apiModels.length === 0) {
    throw new Error('API 地址、API Key 和至少一个模型名称不能为空');
  }

  const providerIndex = state.providers.findIndex(p => p.id === providerId);
  const provider: ModelProvider = {
    id: providerId,
    name: displayNameForType(input.type),
    baseUrl,
    apiKey,
    isBuiltIn: false,
    isDefault: false,
  };
  if (providerIndex === -1) {
    state.providers.push(provider);
  } else {
    state.providers[providerIndex] = {
      ...state.providers[providerIndex],
      ...provider,
    };
  }

  const selectedIds = new Set(apiModels.map(apiModel => modelIdForType(input.type, apiModel)));
  state.models = state.models.filter(m => m.type !== input.type || m.providerId !== providerId || selectedIds.has(m.id));

  const savedModels = apiModels.map((apiModel) => {
    const modelId = modelIdForType(input.type, apiModel);
    const model: ModelDefinition = {
      id: modelId,
      apiModel,
      name: input.displayNames?.[apiModel]?.trim() || apiModel,
      type: input.type,
      providerId,
      endpoint: inferEndpointForApiModel(input.type, apiModel),
      description: `自定义 ${displayNameForType(input.type)} · ${new Date(now).toLocaleString()}`,
      isBuiltIn: false,
      isEnabled: true,
      params: defaultParamsForType(input.type),
    } as ModelDefinition;

    const existingIndex = state.models.findIndex(m => m.id === modelId);
    if (existingIndex === -1) {
      state.models.push(model);
    } else {
      state.models[existingIndex] = {
        ...state.models[existingIndex],
        ...model,
      } as ModelDefinition;
    }
    return model;
  });

  state.activeModelChains[input.type] = savedModels.map(model => model.id);
  state.activeModels[input.type] = savedModels[0]?.id || '';
  saveRegistry(state);
  return savedModels;
};

export const getTypeProviderId = (type: ModelType): string => MODEL_TYPE_PROVIDER_IDS[type];

// ============================================
// 辅助函数
// ============================================

/**
 * 获取激活模型的完整配置
 */
export const getActiveModelsConfig = (): ActiveModels => {
  return loadRegistry().activeModels;
};

/**
 * 检查模型是否可用（已启用且有 API Key）
 */
export const isModelAvailable = (modelId: string): boolean => {
  const model = getModelById(modelId);
  if (!model || !model.isEnabled) return false;
  
  const apiKey = getApiKeyForModel(modelId);
  return !!apiKey;
};

// ============================================
// 默认值辅助函数（向后兼容）
// ============================================

/**
 * 获取默认横竖屏比例（模型默认值）
 */
export const getDefaultAspectRatio = (): AspectRatio => {
  const imageModel = getActiveImageModel();
  if (imageModel) {
    return imageModel.params.defaultAspectRatio;
  }
  return '16:9';
};

/**
 * 获取用户选择的横竖屏比例
 * 读取当前激活图片模型的 defaultAspectRatio
 */
export const getUserAspectRatio = (): AspectRatio => {
  return getDefaultAspectRatio();
};

/**
 * 设置用户选择的横竖屏比例（同步更新当前激活图片模型的默认比例）
 * 修改会持久化保存，并与模型配置页面的"默认比例"保持一致
 */
export const setUserAspectRatio = (ratio: AspectRatio): void => {
  const activeModel = getActiveImageModel();
  if (activeModel) {
    updateModel(activeModel.id, {
      params: { ...activeModel.params, defaultAspectRatio: ratio }
    } as any);
  }
};

/**
 * 获取默认视频时长
 */
export const getDefaultVideoDuration = (): VideoDuration => {
  const videoModel = getActiveVideoModel();
  if (videoModel) {
    return videoModel.params.defaultDuration;
  }
  return 8;
};

/**
 * 获取视频模型类型
 */
export const getVideoModelType = (): 'sora' | 'veo' => {
  const videoModel = getActiveVideoModel();
  if (videoModel) {
    return videoModel.params.mode === 'async' ? 'sora' : 'veo';
  }
  return 'sora';
};
