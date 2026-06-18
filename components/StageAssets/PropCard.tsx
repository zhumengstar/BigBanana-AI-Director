import React from 'react';
import { Package, Check, Loader2, Trash2, Edit2, AlertCircle, FolderPlus } from 'lucide-react';
import { Prop } from '../../types';
import { PROP_CATEGORIES } from './constants';
import PromptEditor from './PromptEditor';
import ImageUploadButton from './ImageUploadButton';
import InlineEditableText from './InlineEditableText';
import { formatFailureStatus } from './failureReason';

interface PropCardProps {
  prop: Prop;
  isGenerating: boolean;
  onGenerate: () => void;
  onUpload: (file: File) => void;
  onPromptSave: (newPrompt: string) => void;
  onImageClick: (imageUrl: string) => void;
  onDelete: () => void;
  onUpdateInfo: (updates: { name?: string; category?: string; description?: string }) => void;
  onAddToLibrary: () => void;
}

const PropCard: React.FC<PropCardProps> = ({
  prop,
  isGenerating,
  onGenerate,
  onUpload,
  onPromptSave,
  onImageClick,
  onDelete,
  onUpdateInfo,
  onAddToLibrary,
}) => {
  const failureStatus = formatFailureStatus(prop);

  return (
    <div className="bg-[var(--bg-surface)] border border-[var(--border-primary)] rounded-xl overflow-hidden flex flex-col group hover:border-[var(--border-secondary)] transition-all hover:shadow-lg">
      <div
        className="aspect-video bg-[var(--bg-elevated)] relative cursor-pointer"
        onClick={() => prop.referenceImage && onImageClick(prop.referenceImage)}
      >
        {prop.referenceImage ? (
          <>
            <img src={prop.referenceImage} alt={prop.name} className="w-full h-full object-cover" />
            <div className="absolute top-2 right-2 p-1 bg-[var(--accent)] text-[var(--text-primary)] rounded shadow-lg backdrop-blur">
              <Check className="w-3 h-3" />
            </div>
          </>
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center text-[var(--text-muted)] p-4 text-center">
            {isGenerating ? (
              <>
                <Loader2 className="w-10 h-10 mb-3 animate-spin text-[var(--accent)]" />
                <span className="text-[10px] text-[var(--text-tertiary)]">生成中...</span>
              </>
            ) : prop.status === 'failed' ? (
              <>
                <AlertCircle className="w-10 h-10 mb-3 text-[var(--error)]" />
                <span className="text-[10px] text-[var(--error)] mb-2 max-w-full break-words" title={failureStatus}>{failureStatus}</span>
                <ImageUploadButton
                  variant="inline"
                  size="small"
                  onUpload={onUpload}
                  onGenerate={onGenerate}
                  isGenerating={isGenerating}
                  uploadLabel="上传"
                  generateLabel="重试"
                />
              </>
            ) : (
              <>
                <Package className="w-10 h-10 mb-3 opacity-10" />
                <ImageUploadButton
                  variant="inline"
                  size="medium"
                  onUpload={onUpload}
                  onGenerate={onGenerate}
                  isGenerating={isGenerating}
                  uploadLabel="上传"
                  generateLabel="生成"
                />
              </>
            )}
          </div>
        )}
      </div>

      <div className="p-3 border-t border-[var(--border-primary)] bg-[var(--bg-base)]">
        <div className="flex justify-between items-center mb-1 gap-2">
          <InlineEditableText
            value={prop.name}
            onSave={(next) => onUpdateInfo({ name: next })}
            inputClassName="font-bold text-[var(--text-secondary)] text-sm bg-[var(--bg-hover)] border border-[var(--border-secondary)] rounded px-2 py-1 flex-1 min-w-0 focus:outline-none focus:border-[var(--accent)]"
            renderDisplay={(value, startEdit) => (
              <div className="flex items-center gap-2 flex-1 min-w-0 group/name">
                <h3 className="font-bold text-[var(--text-secondary)] text-sm truncate" title={value}>
                  {value}
                </h3>
                <button
                  onClick={startEdit}
                  className="opacity-0 group-hover/name:opacity-100 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-opacity flex-shrink-0"
                >
                  <Edit2 className="w-3 h-3" />
                </button>
              </div>
            )}
          />
          <select
            value={prop.category}
            onChange={(e) => onUpdateInfo({ category: e.target.value })}
            className="px-1.5 py-0.5 bg-[var(--bg-elevated)] text-[var(--text-tertiary)] text-[9px] rounded border border-[var(--border-primary)] font-mono cursor-pointer hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] transition-colors shrink-0 focus:outline-none"
          >
            {PROP_CATEGORIES.map((cat) => (
              <option key={cat.value} value={cat.value}>
                {cat.label}
              </option>
            ))}
          </select>
        </div>

        <InlineEditableText
          value={prop.description || ''}
          onSave={(next) => onUpdateInfo({ description: next })}
          required={false}
          multiline={true}
          rows={2}
          inputClassName="text-[10px] text-[var(--text-secondary)] w-full bg-[var(--bg-hover)] border border-[var(--border-secondary)] rounded px-2 py-1 mb-3 focus:outline-none focus:border-[var(--accent)] resize-none"
          renderDisplay={(value, startEdit) => (
            <p
              onClick={startEdit}
              className="text-[10px] text-[var(--text-tertiary)] line-clamp-2 mb-3 cursor-pointer hover:text-[var(--text-secondary)] transition-colors min-h-[28px]"
            >
              {value || '点击添加道具描述...'}
            </p>
          )}
        />

        <div className="mt-3 pt-3 border-t border-[var(--border-primary)]">
          <PromptEditor
            prompt={prop.visualPrompt || ''}
            onSave={onPromptSave}
            label="道具提示词"
            placeholder="输入道具的视觉描述..."
            maxHeight="max-h-[160px]"
          />
        </div>

        {prop.referenceImage && (
          <div className="mt-3 pt-3 border-t border-[var(--border-primary)]">
            <ImageUploadButton
              variant="separate"
              hasImage={true}
              onUpload={onUpload}
              onGenerate={onGenerate}
              isGenerating={isGenerating}
              uploadLabel="上传图片"
            />
          </div>
        )}

        <div className="mt-3 pt-3 border-t border-[var(--border-primary)]">
          <button
            onClick={onAddToLibrary}
            disabled={isGenerating}
            className="w-full py-2 bg-[var(--bg-elevated)] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-primary)] rounded text-[10px] font-bold uppercase tracking-wider flex items-center justify-center gap-2 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <FolderPlus className="w-3 h-3" />
            加入资产库
          </button>
        </div>

        <div className="mt-3 pt-3 border-t border-[var(--border-primary)]">
          <button
            onClick={onDelete}
            disabled={isGenerating}
            className="w-full py-2 bg-transparent hover:bg-[var(--error-bg)] text-[var(--error-text)] hover:text-[var(--error-text)] border border-[var(--error-border)] hover:border-[var(--error-border)] rounded text-[10px] font-bold uppercase tracking-wider flex items-center justify-center gap-2 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <Trash2 className="w-3 h-3" />
            删除道具
          </button>
        </div>
      </div>
    </div>
  );
};

export default PropCard;
