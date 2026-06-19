/**
 * 单类型模型配置组件
 * 每个模型类型独立配置 API 地址、API Key，并从 /v1/models 拉取可选模型。
 */

import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, ArrowDown, ArrowUp, CheckCircle, Download, Eye, EyeOff, Loader2, Plus, Save, Server, Shield, Trash2 } from 'lucide-react';
import { ModelType } from '../../types/model';
import {
  fetchServerModelConfiguration,
  getActiveModelChain,
  inferEndpointForApiModel,
  getProviderById,
  getTypeProviderId,
  saveServerModelConfiguration,
  saveTypeModelConfigurations,
} from '../../services/modelRegistry';
import { useAlert } from '../GlobalAlert';

interface ModelListProps {
  type: ModelType;
  onRefresh: () => void;
}

interface RemoteModel {
  id: string;
  name: string;
}

interface ModelConfigDraft {
  baseUrl: string;
  apiKey: string;
  modelNames: string[];
  manualModelName: string;
  remoteModels: RemoteModel[];
  fetchMessage: string;
}

const modelConfigDrafts: Partial<Record<ModelType, ModelConfigDraft>> = {};

const typeDescriptions: Record<ModelType, string> = {
  chat: '用于剧本解析、分镜生成、提示词优化等文本生成任务',
  image: '用于角色定妆、场景生成、关键帧生成等图片生成任务',
  video: '用于视频片段生成任务',
  audio: '用于配音、旁白和音频生成任务',
};

const defaultEndpointByType: Record<ModelType, string> = {
  chat: '/v1/chat/completions',
  image: '/v1/images/generations',
  video: '/v1/videos',
  audio: '/v1/audio/speech',
};

const normalizeBaseUrl = (value: string): string => value.trim().replace(/\/+$/, '');

const uniqueModelNames = (values: string[]): string[] => {
  const seen = new Set<string>();
  return values
    .map(value => value.trim())
    .filter((value) => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
};

const imageModelPattern = /(image|imagen|gpt[-_ ]?image|flash[-_ ]?image|gemini.*image|dall[-_ ]?e|flux|sdxl|stable[-_ ]?diffusion|midjourney)/i;
const nonChatModelPattern = /(image|imagen|gpt[-_ ]?image|flash[-_ ]?image|gemini.*image|dall[-_ ]?e|flux|sdxl|stable[-_ ]?diffusion|midjourney|video|veo|sora|seedance|kling|runway|wan|hailuo|luma|audio|speech|tts|whisper|transcrib|voice|embedding|rerank|moderation)/i;

const modelTypePatterns: Record<Exclude<ModelType, 'chat'>, RegExp> = {
  image: imageModelPattern,
  video: /(video|veo|sora|seedance|kling|runway|wan|hailuo|luma)/i,
  audio: /(audio|speech|tts|whisper|transcrib|voice)/i,
};

const typeLabels: Record<ModelType, string> = {
  chat: '对话',
  image: '图片',
  video: '视频',
  audio: '音频',
};

const filterModelsByType = (models: RemoteModel[], type: ModelType): RemoteModel[] => {
  if (type === 'chat') {
    return models.filter(model => !nonChatModelPattern.test(`${model.id} ${model.name}`));
  }
  const pattern = modelTypePatterns[type];
  return models.filter(model => pattern.test(`${model.id} ${model.name}`));
};

const parseModelList = (payload: any): RemoteModel[] => {
  const rawItems = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload)
        ? payload
        : [];

  const seen = new Set<string>();
  return rawItems
    .map((item: any) => {
      const id = typeof item === 'string' ? item : item?.id || item?.name || item?.model;
      if (!id) return null;
      const cleanId = String(id).trim();
      if (!cleanId || seen.has(cleanId)) return null;
      seen.add(cleanId);
      return {
        id: cleanId,
        name: String(item?.name || item?.display_name || cleanId),
      };
    })
    .filter(Boolean) as RemoteModel[];
};

const ModelList: React.FC<ModelListProps> = ({ type, onRefresh }) => {
  const { showAlert } = useAlert();
  const [registryVersion, setRegistryVersion] = useState(0);
  const providerId = getTypeProviderId(type);
  const activeModelChain = getActiveModelChain(type);
  const primaryActiveModel = activeModelChain[0];
  const provider = primaryActiveModel ? getProviderById(primaryActiveModel.providerId) : getProviderById(providerId);

  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [modelNames, setModelNames] = useState<string[]>([]);
  const [manualModelName, setManualModelName] = useState('');
  const [remoteModels, setRemoteModels] = useState<RemoteModel[]>([]);
  const [isFetching, setIsFetching] = useState(false);
  const [fetchMessage, setFetchMessage] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);

  const saveDraft = (updates: Partial<ModelConfigDraft>) => {
    modelConfigDrafts[type] = {
      baseUrl,
      apiKey,
      modelNames,
      manualModelName,
      remoteModels,
      fetchMessage,
      ...modelConfigDrafts[type],
      ...updates,
    };
  };

  useEffect(() => {
    let canceled = false;
    fetchServerModelConfiguration()
      .then(() => {
        if (!canceled) setRegistryVersion(version => version + 1);
      })
      .catch(() => {});
    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    const draft = modelConfigDrafts[type];
    if (draft) {
      setBaseUrl(draft.baseUrl);
      setApiKey(draft.apiKey);
      setModelNames(draft.modelNames);
      setManualModelName(draft.manualModelName);
      setRemoteModels(draft.remoteModels);
      setFetchMessage(draft.fetchMessage);
      return;
    }

    setBaseUrl(provider?.baseUrl || '');
    setApiKey(provider?.apiKey || '');
    setModelNames(activeModelChain.map(model => model.apiModel || model.id.split(':').slice(1).join(':')));
    setManualModelName('');
    setRemoteModels([]);
    setFetchMessage('');
  }, [type, provider?.baseUrl, provider?.apiKey, activeModelChain.map(model => model.id).join('|'), registryVersion]);

  const selectedModelNames = useMemo(() => modelNames.filter(Boolean), [modelNames]);
  const selectedModelNameSet = useMemo(() => new Set(selectedModelNames), [selectedModelNames]);

  const addModelName = (value: string) => {
    const clean = value.trim();
    if (!clean || selectedModelNameSet.has(clean)) return;
    const next = [...selectedModelNames, clean];
    setModelNames(next);
    saveDraft({ modelNames: next });
  };

  const removeModelName = (value: string) => {
    const next = selectedModelNames.filter(model => model !== value);
    setModelNames(next);
    saveDraft({ modelNames: next });
  };

  const moveModelName = (index: number, direction: -1 | 1) => {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= selectedModelNames.length) return;
    const next = [...selectedModelNames];
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    setModelNames(next);
    saveDraft({ modelNames: next });
  };

  const handleFetchModels = async () => {
    const cleanBaseUrl = normalizeBaseUrl(baseUrl);
    const cleanApiKey = apiKey.trim();
    if (!cleanBaseUrl || !cleanApiKey) {
      showAlert('请先填写 API 地址和 API Key', { type: 'warning' });
      return;
    }

    setIsFetching(true);
    setFetchMessage('');
    try {
      const response = await fetch('/api/project-store/model-config/fetch-models', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ baseUrl: cleanBaseUrl, apiKey: cleanApiKey }),
      });

      if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
          const data = await response.json();
          detail = data?.error?.message || data?.message || detail;
        } catch {
          const text = await response.text();
          if (text) detail = text;
        }
        throw new Error(detail);
      }

      const result = await response.json();
      if (!result?.ok) {
        throw new Error(result?.message || '模型接口返回失败');
      }
      const models = parseModelList(result.payload);
      const typedModels = filterModelsByType(models, type);
      if (models.length === 0) {
        setRemoteModels([]);
        setFetchMessage('接口已返回，但没有解析到模型列表。可以手动输入模型名后保存。');
        saveDraft({ remoteModels: [], fetchMessage: '接口已返回，但没有解析到模型列表。可以手动输入模型名后保存。' });
        return;
      }
      if (typedModels.length === 0) {
        const message = `已拉取 ${models.length} 个模型，但没有匹配到${typeLabels[type]}模型。可以手动输入模型名后保存。`;
        setRemoteModels([]);
        setFetchMessage(message);
        saveDraft({ remoteModels: [], fetchMessage: message });
        return;
      }

      setRemoteModels(typedModels);
      let nextModelNames = selectedModelNames.filter(modelName => typedModels.some(model => model.id === modelName));
      if (nextModelNames.length === 0 && typedModels[0]?.id) {
        nextModelNames = [typedModels[0].id];
      }
      if (nextModelNames.join('|') !== selectedModelNames.join('|')) {
        setModelNames(nextModelNames);
      }
      const message = `已拉取 ${models.length} 个模型，显示 ${typedModels.length} 个${typeLabels[type]}模型`;
      setFetchMessage(message);
      saveDraft({ remoteModels: typedModels, modelNames: nextModelNames, fetchMessage: message });
    } catch (error: any) {
      setRemoteModels([]);
      const message = `拉取失败：${error?.message || '网络或跨域错误'}。可以手动输入模型名后保存。`;
      setFetchMessage(message);
      saveDraft({ remoteModels: [], fetchMessage: message });
    } finally {
      setIsFetching(false);
    }
  };

  const handleSave = async () => {
    try {
      const models = saveTypeModelConfigurations({
        type,
        baseUrl,
        apiKey,
        apiModels: selectedModelNames,
        displayNames: Object.fromEntries(remoteModels.map(model => [model.id, model.name])),
      });
      await saveServerModelConfiguration();
      saveDraft({
        baseUrl,
        apiKey,
        modelNames: selectedModelNames,
        manualModelName,
        remoteModels,
        fetchMessage,
      });
      onRefresh();
      showAlert(`已保存 ${models.length} 个${typeLabels[type]}模型`, { type: 'success' });
    } catch (error: any) {
      showAlert(error?.message || '保存失败', { type: 'error' });
    }
  };

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <p className="text-xs text-[var(--text-tertiary)]">{typeDescriptions[type]}</p>
        <div className="rounded-lg border border-[var(--accent-border)] bg-[var(--accent-bg)] p-3">
          <div className="mb-1 flex items-center gap-2">
            <CheckCircle className="h-4 w-4 text-[var(--accent-text)]" />
            <span className="text-xs font-bold text-[var(--accent-text-hover)]">当前使用</span>
          </div>
          <p className="break-all text-[11px] text-[var(--text-secondary)]">
            {activeModelChain.length > 0 ? (
              <span>
                {activeModelChain.map(model => model.apiModel || model.id).join(' → ')}
                {provider?.baseUrl && (
                  <span className="ml-2 text-[var(--text-tertiary)]">· {provider.baseUrl}</span>
                )}
              </span>
            ) : (
              '未配置'
            )}
          </p>
        </div>
      </div>

      <div className="space-y-4 rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-elevated)]/45 p-4">
        <div>
          <label className="mb-1 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-[var(--text-tertiary)]">
            <Server className="h-3.5 w-3.5" />
            API 地址
          </label>
          <input
            type="url"
            value={baseUrl}
            onChange={(event) => {
              const value = event.target.value;
              setBaseUrl(value);
              saveDraft({ baseUrl: value });
            }}
            placeholder="https://api.example.com"
            className="w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-hover)] px-3 py-2.5 font-mono text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
          />
        </div>

        <div>
          <label className="mb-1 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-[var(--text-tertiary)]">
            <Shield className="h-3.5 w-3.5" />
            API Key
          </label>
          <div className="relative">
            <input
              type={showApiKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(event) => {
                const value = event.target.value;
                setApiKey(value);
                saveDraft({ apiKey: value });
              }}
              placeholder="sk-..."
              className="w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-hover)] px-3 py-2.5 pr-10 font-mono text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
            />
            <button
              type="button"
              onClick={() => setShowApiKey(value => !value)}
              className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
              aria-label={showApiKey ? '隐藏 API Key' : '显示 API Key'}
              title={showApiKey ? '隐藏 API Key' : '显示 API Key'}
            >
              {showApiKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleFetchModels}
            disabled={isFetching}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-[var(--accent)] px-4 py-2.5 text-xs font-bold text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            拉取模型
          </button>
          {fetchMessage && (
            <span className="inline-flex min-w-0 items-center gap-1.5 text-[10px] text-[var(--text-tertiary)]">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              <span className="break-all">{fetchMessage}</span>
            </span>
          )}
        </div>

        <div>
          <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-[var(--text-tertiary)]">
            选择模型
          </label>
          {remoteModels.length > 0 ? (
            <div className="max-h-52 space-y-1 overflow-y-auto rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-hover)] p-2">
              {remoteModels.map((model) => (
                <label
                  key={model.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-xs text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-elevated)]"
                >
                  <input
                    type="checkbox"
                    checked={selectedModelNameSet.has(model.id)}
                    onChange={(event) => {
                      const next = event.target.checked
                        ? uniqueModelNames([...selectedModelNames, model.id])
                        : selectedModelNames.filter(item => item !== model.id);
                      setModelNames(next);
                      saveDraft({ modelNames: next });
                    }}
                    className="h-3.5 w-3.5 accent-[var(--accent)]"
                  />
                  <span className="min-w-0 flex-1 break-all font-mono">
                    {model.name === model.id ? model.id : `${model.name} (${model.id})`}
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <p className="rounded-lg border border-dashed border-[var(--border-secondary)] bg-[var(--bg-hover)] px-3 py-3 text-[11px] text-[var(--text-tertiary)]">
              拉取模型后可勾选；也可以手动添加模型名。
            </p>
          )}
        </div>

        <div>
          <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-[var(--text-tertiary)]">
            手动添加模型
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={manualModelName}
              onChange={(event) => {
                const value = event.target.value;
                setManualModelName(value);
                saveDraft({ manualModelName: value });
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addModelName(manualModelName);
                  setManualModelName('');
                  saveDraft({ manualModelName: '' });
                }
              }}
              placeholder={type === 'image' ? '如 gpt-image-2 或 gemini-3.1-flash-image' : '输入模型名'}
              className="min-w-0 flex-1 rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-hover)] px-3 py-2.5 font-mono text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
            />
            <button
              type="button"
              onClick={() => {
                addModelName(manualModelName);
                setManualModelName('');
                saveDraft({ manualModelName: '' });
              }}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-[var(--border-secondary)] px-3 py-2.5 text-xs font-bold text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              <Plus className="h-3.5 w-3.5" />
              添加
            </button>
          </div>
        </div>

        <div>
          <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-[var(--text-tertiary)]">
            执行顺序
          </label>
          {selectedModelNames.length > 0 ? (
            <div className="space-y-2">
              {selectedModelNames.map((modelName, index) => (
                <div
                  key={modelName}
                  className="flex items-center gap-2 rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-hover)] px-3 py-2"
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--bg-elevated)] text-[10px] font-bold text-[var(--text-tertiary)]">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="break-all font-mono text-xs text-[var(--text-primary)]">{modelName}</div>
                    <div className="break-all font-mono text-[10px] text-[var(--text-tertiary)]">
                      {inferEndpointForApiModel(type, modelName, defaultEndpointByType[type])}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => moveModelName(index, -1)}
                    disabled={index === 0}
                    className="flex h-7 w-7 items-center justify-center rounded text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-35"
                    aria-label="上移模型"
                    title="上移模型"
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => moveModelName(index, 1)}
                    disabled={index === selectedModelNames.length - 1}
                    className="flex h-7 w-7 items-center justify-center rounded text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-35"
                    aria-label="下移模型"
                    title="下移模型"
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeModelName(modelName)}
                    className="flex h-7 w-7 items-center justify-center rounded text-[var(--danger)] transition-colors hover:bg-[var(--danger-bg)]"
                    aria-label="移除模型"
                    title="移除模型"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="rounded-lg border border-dashed border-[var(--border-secondary)] bg-[var(--bg-hover)] px-3 py-3 text-[11px] text-[var(--text-tertiary)]">
              还没有选择模型。执行时会按这里的顺序调用，前一个失败后自动切换到后一个。
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={handleSave}
          className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--btn-primary-bg)] px-4 py-3 text-xs font-bold text-[var(--btn-primary-text)] transition-colors hover:bg-[var(--btn-primary-hover)]"
        >
          <Save className="h-3.5 w-3.5" />
          保存模型链
        </button>
      </div>
    </div>
  );
};

export default ModelList;
