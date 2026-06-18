/**
 * 模型配置管理服务
 * 管理 API 提供商和模型配置
 */

import { 
  ModelProvider, 
  ModelConfig, 
  ModelManagerState, 
  AspectRatio, 
  VideoDuration,
  ChatModelConfig,
  ImageModelConfig,
  VideoModelConfig
} from '../types';

// 兼容缓存键名：服务端配置是权威来源，浏览器只作为旧组件运行缓存。
const STORAGE_KEY = 'bigbanana_model_config';
const SERVER_MODEL_CONFIG_ENDPOINT = '/api/project-store/model-config';

const DEFAULT_PROVIDER: ModelProvider = {
  id: '',
  name: '',
  baseUrl: '',
  isDefault: false,
  isBuiltIn: false
};

const DEFAULT_CONFIG: ModelConfig = {
  chatModel: {
    providerId: '',
    modelName: '',
    endpoint: '/v1/chat/completions'
  },
  imageModel: {
    providerId: '',
    modelName: '',
    endpoint: '/v1/images/generations'
  },
  videoModel: {
    providerId: '',
    type: 'veo',
    modelName: '',
    endpoint: '/v1/videos'
  }
};

// 默认状态
const DEFAULT_STATE: ModelManagerState = {
  providers: [],
  currentConfig: DEFAULT_CONFIG,
  defaultAspectRatio: '16:9',
  defaultVideoDuration: 8
};

// 运行时状态缓存
let runtimeState: ModelManagerState | null = null;

const legacyModelId = (type: 'chat' | 'image' | 'video', modelName: string): string => (
  modelName ? `${type}:${modelName}` : ''
);

const legacyStateToServerConfig = (state: ModelManagerState) => {
  const providers = (state.providers || [])
    .filter(provider => provider.id && provider.baseUrl)
    .map(provider => ({ ...provider, isBuiltIn: false }));
  const models = [
    {
      id: legacyModelId('chat', state.currentConfig.chatModel.modelName),
      apiModel: state.currentConfig.chatModel.modelName,
      name: state.currentConfig.chatModel.modelName,
      type: 'chat',
      providerId: state.currentConfig.chatModel.providerId,
      endpoint: state.currentConfig.chatModel.endpoint || '/v1/chat/completions',
      isBuiltIn: false,
      isEnabled: true,
    },
    {
      id: legacyModelId('image', state.currentConfig.imageModel.modelName),
      apiModel: state.currentConfig.imageModel.modelName,
      name: state.currentConfig.imageModel.modelName,
      type: 'image',
      providerId: state.currentConfig.imageModel.providerId,
      endpoint: state.currentConfig.imageModel.endpoint || '/v1/images/generations',
      isBuiltIn: false,
      isEnabled: true,
    },
    {
      id: legacyModelId('video', state.currentConfig.videoModel.modelName),
      apiModel: state.currentConfig.videoModel.modelName,
      name: state.currentConfig.videoModel.modelName,
      type: 'video',
      providerId: state.currentConfig.videoModel.providerId,
      endpoint: state.currentConfig.videoModel.endpoint || '/v1/videos',
      isBuiltIn: false,
      isEnabled: true,
    },
  ].filter(model => model.id && model.providerId);

  return {
    version: 1,
    providers,
    models,
    activeModels: {
      chat: legacyModelId('chat', state.currentConfig.chatModel.modelName),
      image: legacyModelId('image', state.currentConfig.imageModel.modelName),
      video: legacyModelId('video', state.currentConfig.videoModel.modelName),
      audio: '',
    },
  };
};

const saveLegacyConfigToServer = (state: ModelManagerState): void => {
  try {
    void fetch(SERVER_MODEL_CONFIG_ENDPOINT, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: legacyStateToServerConfig(state) }),
    }).catch(error => {
      console.warn('旧模型配置保存到服务端失败，已保留浏览器缓存。', error);
    });
  } catch {
    // ignore
  }
};

/**
 * 从浏览器运行缓存加载旧配置；服务端模型配置是权威来源。
 */
export const loadModelConfig = (): ModelManagerState => {
  if (runtimeState) {
    return runtimeState;
  }

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as ModelManagerState;
      parsed.providers = (parsed.providers || []).filter(p => !p.isBuiltIn);
      // 迁移旧的 Veo 模型名为统一的 veo
      const videoModelName = parsed.currentConfig?.videoModel?.modelName || '';
      if (
        videoModelName === 'veo-3.1' ||
        videoModelName === 'veo-r2v' ||
        videoModelName === 'veo_3_1' ||
        videoModelName.startsWith('veo_3_1_') ||
        videoModelName.startsWith('veo_3_0_r2v')
      ) {
        parsed.currentConfig.videoModel.modelName = '';
        parsed.currentConfig.videoModel.type = 'veo';
        parsed.currentConfig.videoModel.endpoint = '/v1/videos';
        // 迁移后立即回写，避免重复执行
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed)); } catch (e) { /* ignore */ }
      }
      runtimeState = parsed;
      return parsed;
    }
  } catch (e) {
    console.error('加载模型配置失败:', e);
  }

  runtimeState = {
    ...DEFAULT_STATE,
    currentConfig: {
      chatModel: { ...DEFAULT_CONFIG.chatModel },
      imageModel: { ...DEFAULT_CONFIG.imageModel },
      videoModel: { ...DEFAULT_CONFIG.videoModel },
    },
  };
  return runtimeState;
};

/**
 * 保存旧配置缓存，并同步迁移到服务端模型配置。
 */
export const saveModelConfig = (state: ModelManagerState): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    runtimeState = state;
    saveLegacyConfigToServer(state);
  } catch (e) {
    console.error('保存模型配置失败:', e);
  }
};

/**
 * 获取当前模型配置状态
 */
export const getModelManagerState = (): ModelManagerState => {
  return loadModelConfig();
};

/**
 * 获取所有提供商列表
 */
export const getProviders = (): ModelProvider[] => {
  return loadModelConfig().providers;
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
  return getProviders().find(p => p.isDefault) || DEFAULT_PROVIDER;
};

/**
 * 添加新的提供商
 */
export const addProvider = (provider: Omit<ModelProvider, 'id' | 'isBuiltIn'>): ModelProvider => {
  const state = loadModelConfig();
  const newProvider: ModelProvider = {
    ...provider,
    id: `provider_${Date.now()}`,
    isBuiltIn: false
  };
  state.providers.push(newProvider);
  saveModelConfig(state);
  return newProvider;
};

/**
 * 更新提供商
 */
export const updateProvider = (id: string, updates: Partial<ModelProvider>): boolean => {
  const state = loadModelConfig();
  const index = state.providers.findIndex(p => p.id === id);
  if (index === -1) return false;
  
  // 不允许修改内置提供商的某些属性
  if (state.providers[index].isBuiltIn) {
    delete updates.id;
    delete updates.isBuiltIn;
    delete updates.baseUrl;
  }
  
  state.providers[index] = { ...state.providers[index], ...updates };
  saveModelConfig(state);
  return true;
};

/**
 * 删除提供商
 */
export const deleteProvider = (id: string): boolean => {
  const state = loadModelConfig();
  const provider = state.providers.find(p => p.id === id);
  
  // 不允许删除内置提供商
  if (!provider || provider.isBuiltIn) return false;
  
  state.providers = state.providers.filter(p => p.id !== id);
  
  // 如果删除的是当前使用的提供商，切换回默认
  if (state.currentConfig.chatModel.providerId === id) {
    state.currentConfig.chatModel.providerId = '';
  }
  if (state.currentConfig.imageModel.providerId === id) {
    state.currentConfig.imageModel.providerId = '';
  }
  if (state.currentConfig.videoModel.providerId === id) {
    state.currentConfig.videoModel.providerId = '';
  }
  
  saveModelConfig(state);
  return true;
};

/**
 * 获取当前模型配置
 */
export const getCurrentConfig = (): ModelConfig => {
  return loadModelConfig().currentConfig;
};

/**
 * 更新对话模型配置
 */
export const updateChatModelConfig = (config: Partial<ChatModelConfig>): void => {
  const state = loadModelConfig();
  state.currentConfig.chatModel = { ...state.currentConfig.chatModel, ...config };
  saveModelConfig(state);
};

/**
 * 更新画图模型配置
 */
export const updateImageModelConfig = (config: Partial<ImageModelConfig>): void => {
  const state = loadModelConfig();
  state.currentConfig.imageModel = { ...state.currentConfig.imageModel, ...config };
  saveModelConfig(state);
};

/**
 * 更新视频模型配置
 */
export const updateVideoModelConfig = (config: Partial<VideoModelConfig>): void => {
  const state = loadModelConfig();
  state.currentConfig.videoModel = { ...state.currentConfig.videoModel, ...config };
  saveModelConfig(state);
};

/**
 * 获取当前对话模型的完整 API URL
 */
export const getChatApiUrl = (): string => {
  const config = getCurrentConfig();
  const provider = getProviderById(config.chatModel.providerId) || getDefaultProvider();
  const baseUrl = provider.baseUrl.replace(/\/+$/, '');
  const endpoint = config.chatModel.endpoint || '/v1/chat/completions';
  return `${baseUrl}${endpoint}`;
};

/**
 * 获取当前画图模型的完整 API URL
 */
export const getImageApiUrl = (): string => {
  const config = getCurrentConfig();
  const provider = getProviderById(config.imageModel.providerId) || getDefaultProvider();
  const baseUrl = provider.baseUrl.replace(/\/+$/, '');
  const endpoint = config.imageModel.endpoint || '/v1/images/generations';
  return `${baseUrl}${endpoint}`;
};

/**
 * 获取当前视频模型的完整 API URL（仅用于异步视频 API）
 */
export const getVideoApiUrl = (): string => {
  const config = getCurrentConfig();
  const provider = getProviderById(config.videoModel.providerId) || getDefaultProvider();
  const baseUrl = provider.baseUrl.replace(/\/+$/, '');
  
  if (config.videoModel.type === 'sora') {
    return `${baseUrl}/v1/videos`;
  } else {
    return `${baseUrl}/v1/chat/completions`;
  }
};

/**
 * 获取当前提供商的基础 URL
 */
export const getApiBaseUrl = (type: 'chat' | 'image' | 'video' = 'chat'): string => {
  const config = getCurrentConfig();
  let providerId: string;
  
  switch (type) {
    case 'chat':
      providerId = config.chatModel.providerId;
      break;
    case 'image':
      providerId = config.imageModel.providerId;
      break;
    case 'video':
      providerId = config.videoModel.providerId;
      break;
    default:
      providerId = '';
  }
  
  const provider = getProviderById(providerId) || getDefaultProvider();
  return provider.baseUrl.replace(/\/+$/, '');
};

/**
 * 获取提供商的 API Key（如果有独立 Key 则使用，否则返回 undefined）
 */
export const getProviderApiKey = (providerId: string): string | undefined => {
  const provider = getProviderById(providerId);
  return provider?.apiKey;
};

/**
 * 获取默认横竖屏比例
 */
export const getDefaultAspectRatio = (): AspectRatio => {
  return loadModelConfig().defaultAspectRatio;
};

/**
 * 设置默认横竖屏比例
 */
export const setDefaultAspectRatio = (ratio: AspectRatio): void => {
  const state = loadModelConfig();
  state.defaultAspectRatio = ratio;
  saveModelConfig(state);
};

/**
 * 获取默认视频时长
 */
export const getDefaultVideoDuration = (): VideoDuration => {
  return loadModelConfig().defaultVideoDuration;
};

/**
 * 设置默认视频时长
 */
export const setDefaultVideoDuration = (duration: VideoDuration): void => {
  const state = loadModelConfig();
  state.defaultVideoDuration = duration;
  saveModelConfig(state);
};

/**
 * 获取视频模型类型
 */
export const getVideoModelType = (): 'sora' | 'veo' => {
  return getCurrentConfig().videoModel.type;
};

/**
 * 根据横竖屏比例获取 Veo 模型名称
 * @param hasReferenceImage 是否有参考图
 * @param aspectRatio 横竖屏比例
 */
export const getVeoModelName = (hasReferenceImage: boolean, aspectRatio: AspectRatio): string => {
  const orientation = aspectRatio === '9:16' ? 'portrait' : 'landscape';
  
  if (hasReferenceImage) {
    return `veo_3_1_i2v_s_fast_fl_${orientation}`;
  } else {
    return `veo_3_1_t2v_fast_${orientation}`;
  }
};

/**
 * 根据横竖屏比例获取 Sora 视频尺寸
 */
export const getSoraVideoSize = (aspectRatio: AspectRatio): string => {
  const sizeMap: Record<AspectRatio, string> = {
    '16:9': '1280x720',
    '9:16': '720x1280',
    '1:1': '720x720'
  };
  return sizeMap[aspectRatio];
};

/**
 * 重置为默认配置
 */
export const resetToDefault = (): void => {
  runtimeState = null;
  localStorage.removeItem(STORAGE_KEY);
  loadModelConfig(); // 重新加载默认值
};

/**
 * 预定义的对话模型列表
 */
export const AVAILABLE_CHAT_MODELS: Array<{ name: string; value: string; description: string }> = [];

/**
 * 预定义的画图模型列表
 */
export const AVAILABLE_IMAGE_MODELS: Array<{ name: string; value: string; description: string }> = [];

/**
 * 预定义的视频模型列表
 */
export const AVAILABLE_VIDEO_MODELS: Array<{ name: string; value: string; type: 'sora' | 'veo'; description: string }> = [];
