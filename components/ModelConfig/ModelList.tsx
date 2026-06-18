/**
 * 单类型模型配置组件
 * 每个模型类型独立配置 API 地址、API Key，并从 /v1/models 拉取可选模型。
 */

import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle, Download, Loader2, Save, Server, Shield, AlertCircle } from 'lucide-react';
import { ModelType } from '../../types/model';
import {
  getActiveModel,
  getProviderById,
  getTypeProviderId,
  saveTypeModelConfiguration,
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

const localStoragePrefix = 'bigbanana_model_config_draft';

const normalizeBaseUrl = (value: string): string => value.trim().replace(/\/+$/, '');

const modelsEndpointForBaseUrl = (baseUrl: string): string => {
  const clean = normalizeBaseUrl(baseUrl);
  return clean.endsWith('/v1') ? `${clean}/models` : `${clean}/v1/models`;
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
  const providerId = getTypeProviderId(type);
  const activeModel = getActiveModel(type);
  const provider = activeModel ? getProviderById(activeModel.providerId) : getProviderById(providerId);
  const draftKey = `${localStoragePrefix}_${type}`;

  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [modelName, setModelName] = useState('');
  const [endpoint, setEndpoint] = useState(defaultEndpointByType[type]);
  const [remoteModels, setRemoteModels] = useState<RemoteModel[]>([]);
  const [isFetching, setIsFetching] = useState(false);
  const [fetchMessage, setFetchMessage] = useState('');

  useEffect(() => {
    let draft: any = null;
    try {
      draft = JSON.parse(localStorage.getItem(draftKey) || 'null');
    } catch {
      draft = null;
    }

    setBaseUrl(provider?.baseUrl || draft?.baseUrl || '');
    setApiKey(provider?.apiKey || draft?.apiKey || '');
    setModelName(activeModel?.apiModel || activeModel?.id?.split(':').slice(1).join(':') || draft?.modelName || '');
    setEndpoint(activeModel?.endpoint || draft?.endpoint || defaultEndpointByType[type]);
    setRemoteModels([]);
    setFetchMessage('');
  }, [type, provider?.baseUrl, provider?.apiKey, activeModel?.id, activeModel?.apiModel, activeModel?.endpoint, draftKey]);

  useEffect(() => {
    try {
      localStorage.setItem(draftKey, JSON.stringify({ baseUrl, apiKey, modelName, endpoint }));
    } catch {
      // ignore local draft persistence failures
    }
  }, [draftKey, baseUrl, apiKey, modelName, endpoint]);

  const selectedModel = useMemo(
    () => remoteModels.find(model => model.id === modelName),
    [remoteModels, modelName]
  );

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
      const response = await fetch(modelsEndpointForBaseUrl(cleanBaseUrl), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${cleanApiKey}`,
          Accept: 'application/json',
        },
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

      const models = parseModelList(await response.json());
      if (models.length === 0) {
        setRemoteModels([]);
        setFetchMessage('接口已返回，但没有解析到模型列表。可以手动输入模型名后保存。');
        return;
      }

      setRemoteModels(models);
      if (!modelName || !models.some(model => model.id === modelName)) {
        setModelName(models[0].id);
      }
      setFetchMessage(`已拉取 ${models.length} 个模型`);
    } catch (error: any) {
      setRemoteModels([]);
      setFetchMessage(`拉取失败：${error?.message || '网络或跨域错误'}。可以手动输入模型名后保存。`);
    } finally {
      setIsFetching(false);
    }
  };

  const handleSave = () => {
    try {
      const model = saveTypeModelConfiguration({
        type,
        baseUrl,
        apiKey,
        apiModel: modelName,
        endpoint,
        displayName: selectedModel?.name || modelName,
      });
      onRefresh();
      showAlert(`已保存 ${model.name}`, { type: 'success' });
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
            {activeModel ? (
              <>
                <span className="font-medium">{activeModel.apiModel || activeModel.id}</span>
                {provider?.baseUrl && (
                  <span className="ml-2 text-[var(--text-tertiary)]">→ {provider.baseUrl}</span>
                )}
              </>
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
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://api.example.com 或 /api/ai-muling"
            className="w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-hover)] px-3 py-2.5 font-mono text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
          />
        </div>

        <div>
          <label className="mb-1 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-[var(--text-tertiary)]">
            <Shield className="h-3.5 w-3.5" />
            API Key
          </label>
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="sk-..."
            className="w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-hover)] px-3 py-2.5 font-mono text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
          />
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
            模型
          </label>
          {remoteModels.length > 0 ? (
            <select
              value={modelName}
              onChange={(event) => setModelName(event.target.value)}
              className="w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-hover)] px-3 py-2.5 font-mono text-xs text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
            >
              {remoteModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name === model.id ? model.id : `${model.name} (${model.id})`}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={modelName}
              onChange={(event) => setModelName(event.target.value)}
              placeholder="输入模型名，如 gpt-image-2"
              className="w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-hover)] px-3 py-2.5 font-mono text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
            />
          )}
        </div>

        <div>
          <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-[var(--text-tertiary)]">
            调用端点
          </label>
          <input
            type="text"
            value={endpoint}
            onChange={(event) => setEndpoint(event.target.value)}
            placeholder={defaultEndpointByType[type]}
            className="w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-hover)] px-3 py-2.5 font-mono text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
          />
        </div>

        <button
          type="button"
          onClick={handleSave}
          className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--btn-primary-bg)] px-4 py-3 text-xs font-bold text-[var(--btn-primary-text)] transition-colors hover:bg-[var(--btn-primary-hover)]"
        >
          <Save className="h-3.5 w-3.5" />
          保存并使用该模型
        </button>
      </div>
    </div>
  );
};

export default ModelList;
