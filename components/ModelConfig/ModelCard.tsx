/**
 * 模型卡片组件
 * 显示单个模型的配置
 */

import React, { useState } from 'react';
import { CheckCircle, ChevronDown, ChevronUp, Circle, Eye, EyeOff, ToggleLeft, ToggleRight, Trash2 } from 'lucide-react';
import { 
  ModelDefinition, 
  ChatModelParams,
  ImageModelParams,
  VideoModelParams,
  AspectRatio,
  VideoDuration
} from '../../types/model';
import { getProviderById } from '../../services/modelRegistry';

interface ModelCardProps {
  model: ModelDefinition;
  isExpanded: boolean;
  isActive: boolean;
  onToggleExpand: () => void;
  onUpdate: (updates: Partial<ModelDefinition>) => void;
  onDelete: () => void;
  onSetActive: () => void;
}

const ModelCard: React.FC<ModelCardProps> = ({
  model,
  isExpanded,
  isActive,
  onToggleExpand,
  onUpdate,
  onDelete,
  onSetActive,
}) => {
  const [editParams, setEditParams] = useState<any>(model.params);
  const [editApiKey, setEditApiKey] = useState<string>(model.apiKey || '');
  const [showApiKey, setShowApiKey] = useState(false);
  const provider = getProviderById(model.providerId);
  const isVolcengineModel = model.providerId === 'volcengine';
  const modelHasApiKey = Boolean(model.apiKey?.trim());
  const providerHasApiKey = Boolean(provider?.apiKey?.trim());
  const isMissingVolcengineKey = isVolcengineModel && !modelHasApiKey && !providerHasApiKey;

  const handleParamChange = (key: string, value: any) => {
    const newParams = { ...editParams, [key]: value };
    setEditParams(newParams);
    onUpdate({ params: newParams } as any);
  };

  const handleToggleEnabled = () => {
    onUpdate({ isEnabled: !model.isEnabled });
  };

  const handleApiKeyChange = (value: string) => {
    setEditApiKey(value);
    onUpdate({ apiKey: value.trim() || undefined });
  };

  const renderChatParams = (params: ChatModelParams) => (
    <div className="grid grid-cols-2 gap-4">
      <div>
        <label className="text-[10px] text-[var(--text-tertiary)] block mb-1">温度</label>
        <input
          type="number"
          min="0"
          max="2"
          step="0.1"
          value={editParams.temperature}
          onChange={(e) => handleParamChange('temperature', parseFloat(e.target.value))}
          className="w-full bg-[var(--bg-hover)] border border-[var(--border-secondary)] rounded px-3 py-2 text-xs text-[var(--text-primary)]"
        />
      </div>
      <div>
        <label className="text-[10px] text-[var(--text-tertiary)] block mb-1">最大 Token</label>
        <input
          type="number"
          min="1"
          max="128000"
          value={editParams.maxTokens ?? ''}
          onChange={(e) => {
            const value = e.target.value;
            handleParamChange('maxTokens', value === '' ? undefined : parseInt(value));
          }}
          placeholder="留空不限制"
          className="w-full bg-[var(--bg-hover)] border border-[var(--border-secondary)] rounded px-3 py-2 text-xs text-[var(--text-primary)]"
        />
        <p className="text-[9px] text-[var(--text-muted)] mt-1">留空则不限制最大 Token</p>
      </div>
    </div>
  );

  const renderImageParams = (params: ImageModelParams) => (
    <div>
      <label className="text-[10px] text-[var(--text-tertiary)] block mb-1">默认比例</label>
      <div className="flex gap-2">
        {/* 从模型的 supportedAspectRatios 读取支持的比例 */}
        {(params.supportedAspectRatios || ['16:9', '9:16']).map((ratio) => (
          <button
            key={ratio}
            onClick={() => handleParamChange('defaultAspectRatio', ratio)}
            className={`px-3 py-1.5 text-xs rounded transition-colors ${
              editParams.defaultAspectRatio === ratio
                ? 'bg-[var(--accent)] text-[var(--text-primary)]'
                : 'bg-[var(--bg-hover)] text-[var(--text-tertiary)] hover:bg-[var(--border-secondary)]'
            }`}
          >
            {ratio === '16:9' ? '横屏' : ratio === '9:16' ? '竖屏' : '方形'}
          </button>
        ))}
      </div>
    </div>
  );

  const renderVideoParams = (params: VideoModelParams) => (
    <div className="space-y-4">
      <div>
        <label className="text-[10px] text-[var(--text-tertiary)] block mb-1">默认比例</label>
        <div className="flex gap-2">
          {editParams.supportedAspectRatios.map((ratio: AspectRatio) => (
            <button
              key={ratio}
              onClick={() => handleParamChange('defaultAspectRatio', ratio)}
              className={`px-3 py-1.5 text-xs rounded transition-colors ${
                editParams.defaultAspectRatio === ratio
                  ? 'bg-[var(--accent)] text-[var(--text-primary)]'
                  : 'bg-[var(--bg-hover)] text-[var(--text-tertiary)] hover:bg-[var(--border-secondary)]'
              }`}
            >
              {ratio === '16:9' ? '横屏' : ratio === '9:16' ? '竖屏' : '方形'}
            </button>
          ))}
        </div>
      </div>
      {editParams.supportedDurations.length > 1 && (
        <div>
          <label className="text-[10px] text-[var(--text-tertiary)] block mb-1">默认时长</label>
          <div className="flex gap-2">
            {editParams.supportedDurations.map((duration: VideoDuration) => (
              <button
                key={duration}
                onClick={() => handleParamChange('defaultDuration', duration)}
                className={`px-3 py-1.5 text-xs rounded transition-colors ${
                  editParams.defaultDuration === duration
                    ? 'bg-[var(--accent)] text-[var(--text-primary)]'
                    : 'bg-[var(--bg-hover)] text-[var(--text-tertiary)] hover:bg-[var(--border-secondary)]'
                }`}
              >
                {duration}秒
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="text-[10px] text-[var(--text-muted)]">
        模式：{
          editParams.mode === 'sync'
            ? '同步（Veo）'
            : (model.endpoint || '').includes('/contents/generations/tasks')
              ? '异步（火山任务）'
              : '异步（Sora 类）'
        }
      </div>
    </div>
  );

  const apiModel = model.apiModel || model.id;

  return (
    <div 
      className={`bg-[var(--bg-elevated)]/50 border rounded-lg overflow-hidden transition-all ${
        isActive ? 'border-[var(--accent-border)] bg-[var(--accent-bg)]' : 'border-[var(--border-primary)]'
      } ${!model.isEnabled ? 'opacity-60' : ''}`}
    >
      {/* 头部 */}
      <div className="p-4 flex items-center justify-between">
        <div className="flex items-center gap-3 flex-1">
          {/* 模型信息 */}
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-[var(--text-primary)]">{model.name}</span>
              {model.isBuiltIn && (
                <span className={`px-1.5 py-0.5 text-[9px] rounded ${
                  isVolcengineModel
                    ? 'bg-[var(--warning-bg)] text-[var(--warning-text)]'
                    : 'bg-[var(--border-secondary)] text-[var(--text-tertiary)]'
                }`}>
                  {isVolcengineModel ? '火山引擎' : '内置'}
                </span>
              )}
            </div>
            <p className="text-[10px] text-[var(--text-tertiary)] mt-0.5">
              API 模型名: {apiModel}
              {model.id !== apiModel && ` · 内部ID: ${model.id}`}
              {model.endpoint && ` · ${model.endpoint}`}
              {model.description && ` · ${model.description}`}
            </p>
          </div>
        </div>

        {/* 操作按钮 */}
        <div className="flex items-center gap-2">
          {/* 使用此模型按钮 */}
          {model.isEnabled && !isActive && (
            <button
              onClick={onSetActive}
              className="px-2.5 py-1 bg-[var(--accent)] text-[var(--text-primary)] text-[10px] font-bold rounded hover:bg-[var(--accent-hover)] transition-colors flex items-center gap-1"
              title="使用此模型"
            >
              <Circle className="w-3 h-3" />
              使用
            </button>
          )}
          
          {/* 当前激活标记 */}
          {isActive && (
            <span className="px-2.5 py-1 bg-[var(--accent-bg)] text-[var(--accent-text-hover)] text-[10px] font-bold rounded flex items-center gap-1">
              <CheckCircle className="w-3 h-3" />
              当前使用
            </span>
          )}

          {/* 启用/禁用开关 */}
          <button
            onClick={handleToggleEnabled}
            className="text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors"
            title={model.isEnabled ? '禁用' : '启用'}
          >
            {model.isEnabled ? (
              <ToggleRight className="w-5 h-5 text-[var(--accent-text)]" />
            ) : (
              <ToggleLeft className="w-5 h-5" />
            )}
          </button>

          {/* 删除按钮（仅非内置模型） */}
          {!model.isBuiltIn && (
            <button
              onClick={onDelete}
              className="text-[var(--text-tertiary)] hover:text-[var(--error-text)] transition-colors"
              title="删除"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}

          {/* 展开/收起 */}
          <button
            onClick={onToggleExpand}
            className="text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors"
          >
            {isExpanded ? (
              <ChevronUp className="w-4 h-4" />
            ) : (
              <ChevronDown className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>

      {/* 展开的参数配置 */}
      {isExpanded && (
        <div className="px-4 pb-4 pt-0 border-t border-[var(--border-primary)]">
          <div className="pt-4 space-y-4">
            {/* 模型专属 API Key */}
            <div>
              <label className="text-[10px] text-[var(--text-tertiary)] block mb-1">
                API Key（可选）
              </label>
              {isVolcengineModel && (
                <p className="text-[9px] text-[var(--warning-text)] mb-1">
                  请填写模型 Key 或 Volcengine 提供商 Key。
                </p>
              )}
              <div className="relative">
                <input
                  type={showApiKey ? 'text' : 'password'}
                  value={editApiKey}
                  onChange={(e) => handleApiKeyChange(e.target.value)}
                  placeholder="可选：为此模型单独填写 API Key"
                  className="w-full bg-[var(--bg-hover)] border border-[var(--border-secondary)] rounded px-3 py-2 pr-10 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] font-mono"
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
              {isMissingVolcengineKey && (
                <p className="text-[9px] text-[var(--error-text)] mt-1">
                  未配置火山引擎 Key，当前模型无法调用。
                </p>
              )}
              {model.apiKey && (
                <p className="text-[9px] text-[var(--success)] mt-1">✓ 已配置专属 Key</p>
              )}
            </div>
            
            {model.type === 'chat' && renderChatParams(model.params)}
            {model.type === 'image' && renderImageParams(model.params)}
            {model.type === 'video' && renderVideoParams(model.params)}
          </div>
        </div>
      )}
    </div>
  );
};

export default ModelCard;
