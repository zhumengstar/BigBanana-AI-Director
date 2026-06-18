/**
 * AI API core utilities:
 * - API key lookup and routing
 * - retry and timeout helpers
 * - chat completion (sync / stream)
 * - media conversion helpers
 */

import { AspectRatio } from "../../types";
import {
  getGlobalApiKey as getRegistryApiKey,
  setGlobalApiKey as setRegistryApiKey,
  getApiBaseUrlForModel,
  getApiKeyForModel,
  getProviderById,
  getModelById,
  getModels,
  getActiveModel,
  getActiveChatModel,
  getActiveVideoModel,
  getActiveImageModel,
} from '../modelRegistry';
import { fetchMediaWithCorsFallback } from '../mediaFetchService';

// ============================================
// Script progress callback
// ============================================

type ScriptLogCallback = (message: string) => void;

let scriptLogCallback: ScriptLogCallback | null = null;

export const setScriptLogCallback = (callback: ScriptLogCallback) => {
  scriptLogCallback = callback;
};

export const clearScriptLogCallback = () => {
  scriptLogCallback = null;
};

export const logScriptProgress = (message: string) => {
  if (scriptLogCallback) {
    scriptLogCallback(message);
  }
};

// ============================================
// API key management
// ============================================

/** API key error */
export class ApiKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiKeyError';
  }
}

/** Runtime fallback API key (backward compatibility). */
let runtimeApiKey: string = process.env.API_KEY || '';

/** Set global API key for runtime + model registry */
export const setGlobalApiKey = (key: string) => {
  runtimeApiKey = key;
  setRegistryApiKey(key);
};

/** Resolve model by type and optional modelId */
export const resolveModel = (type: 'chat' | 'image' | 'video', modelId?: string) => {
  if (modelId) {
    const normalizedModelId = modelId.toLowerCase();
    // Keep alias compatibility for model registry lookup.
    const lookupId = normalizedModelId === 'veo_3_1-fast-4k' ? 'veo_3_1-fast' : modelId;
    const model = getModelById(lookupId);
    if (model && model.type === type) return model;

    const candidates = getModels(type).filter(m => m.apiModel === lookupId);
    if (candidates.length === 1) return candidates[0];
  }

  return getActiveModel(type);
};

/** Resolve model name used in request body */
export const resolveRequestModel = (type: 'chat' | 'image' | 'video', modelId?: string): string => {
  // Preserve explicit 4k request model naming.
  if (modelId && modelId.toLowerCase() === 'veo_3_1-fast-4k') {
    return modelId;
  }

  const resolved = resolveModel(type, modelId);
  return resolved?.apiModel || resolved?.id || modelId || '';
};

/**
 * Resolve API key for a specific model/type.
 * Order:
 * 1) model-level key
 * 2) registry global key
 * 3) runtime fallback key
 */
export const checkApiKey = (type: 'chat' | 'image' | 'video' = 'chat', modelId?: string): string => {
  const resolvedModel = resolveModel(type, modelId);
  console.log('[checkApiKey] type/model/resolved:', type, modelId, resolvedModel?.id, resolvedModel?.providerId);

  if (resolvedModel) {
    const provider = getProviderById(resolvedModel.providerId);
    const isVolcengineProvider =
      resolvedModel.providerId === 'volcengine' ||
      !!provider?.baseUrl?.toLowerCase().includes('volces.com');

    if (isVolcengineProvider) {
      const dedicatedKey = resolvedModel.apiKey || provider?.apiKey;
      if (dedicatedKey) return dedicatedKey;
      throw new ApiKeyError('Volcengine models require a dedicated API key at model/provider level.');
    }

    const modelApiKey = getApiKeyForModel(resolvedModel.id);
    if (modelApiKey) return modelApiKey;
  }

  const registryKey = getRegistryApiKey();
  if (registryKey) return registryKey;

  if (!runtimeApiKey) {
    throw new ApiKeyError('API Key is missing. Please configure it in model settings.');
  }

  return runtimeApiKey;
};

/** Get API base URL for model/type */
export const getApiBase = (type: 'chat' | 'image' | 'video' = 'chat', modelId?: string): string => {
  try {
    const resolvedModel = resolveModel(type, modelId);
    if (resolvedModel) {
      return getApiBaseUrlForModel(resolvedModel.id);
    }
    return '';
  } catch {
    return '';
  }
};

/** Get active chat model name for logging/default behavior */
export const getActiveChatModelName = (): string => {
  try {
    const model = getActiveChatModel();
    return model?.apiModel || model?.id || '';
  } catch {
    return '';
  }
};

// Re-export helpers from modelRegistry
export { getActiveModel, getActiveChatModel, getActiveVideoModel, getActiveImageModel };

// ============================================
// Generic helpers
// ============================================

/** Retry helper with exponential backoff */
export const retryOperation = async <T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 2000,
  abortSignal?: AbortSignal
): Promise<T> => {
  let lastError: any;

  const isAbortError = (error: any): boolean =>
    error?.name === 'AbortError' ||
    error?.message?.includes('Request cancelled') ||
    error?.message?.includes('请求已取消') ||
    error?.message?.includes('aborted');

  for (let i = 0; i < maxRetries; i += 1) {
    if (abortSignal?.aborted) {
      throw new Error('Request cancelled');
    }

    try {
      return await operation();
    } catch (e: any) {
      lastError = e;

      if (isAbortError(e) || abortSignal?.aborted) {
        throw new Error('Request cancelled');
      }

      const isRetryableError =
        e.status === 429 ||
        e.code === 429 ||
        e.status === 504 ||
        e.message?.includes('429') ||
        e.message?.includes('quota') ||
        e.message?.includes('RESOURCE_EXHAUSTED') ||
        e.message?.includes('timed out') ||
        e.message?.includes('timeout') ||
        e.message?.includes('超时') ||
        e.message?.includes('Gateway Timeout') ||
        e.message?.includes('504') ||
        e.message?.includes('ECONNRESET') ||
        e.message?.includes('ETIMEDOUT') ||
        e.message?.includes('network') ||
        e.message?.includes('openai_error') ||
        e.status >= 500;

      if (isRetryableError && i < maxRetries - 1) {
        const delay = baseDelay * Math.pow(2, i);
        console.warn(`Request failed, retrying (${i + 1}/${maxRetries}) in ${delay}ms`, e.message);

        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            if (abortSignal) {
              abortSignal.removeEventListener('abort', handleAbort);
            }
            resolve();
          }, delay);

          const handleAbort = () => {
            clearTimeout(timer);
            abortSignal?.removeEventListener('abort', handleAbort);
            reject(new Error('Request cancelled'));
          };

          if (abortSignal) {
            abortSignal.addEventListener('abort', handleAbort);
          }
        });

        continue;
      }

      throw e;
    }
  }

  throw lastError;
};

/** Remove markdown code fences around JSON */
export const cleanJsonString = (str: string): string => {
  if (!str) return '{}';
  let cleaned = str.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '');
  cleaned = cleaned.replace(/```\s*$/, '');
  return cleaned.trim();
};

/** Parse HTTP error payload to Error with status field */
export const parseHttpError = async (response: Response): Promise<Error> => {
  const httpStatus = response.status;
  let errorMessage = `HTTP error: ${httpStatus}`;

  try {
    const errorData = await response.json();
    errorMessage = errorData.error?.message || errorMessage;
  } catch {
    try {
      const errorText = await response.text();
      if (errorText) errorMessage = errorText;
    } catch {
      // ignore
    }
  }

  const err: any = new Error(errorMessage);
  err.status = httpStatus;
  return err;
};

// ============================================
// Chat completion API
// ============================================

/** Non-stream chat completion */
export const chatCompletion = async (
  prompt: string,
  model: string = '',
  temperature: number = 0.7,
  maxTokens: number = 8192,
  responseFormat?: 'json_object',
  timeout: number = 600000,
  abortSignal?: AbortSignal
): Promise<string> => {
  const apiKey = checkApiKey('chat', model);
  const requestModel = resolveRequestModel('chat', model);

  const requestBody: any = {
    model: requestModel,
    messages: [{ role: 'user', content: prompt }],
    temperature,
  };

  if (Number.isFinite(maxTokens) && maxTokens > 0) {
    requestBody.max_tokens = maxTokens;
  }

  if (responseFormat === 'json_object') {
    requestBody.response_format = { type: 'json_object' };
  }

  const controller = new AbortController();
  const handleExternalAbort = () => controller.abort();

  if (abortSignal) {
    if (abortSignal.aborted) {
      controller.abort();
    } else {
      abortSignal.addEventListener('abort', handleExternalAbort);
    }
  }

  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const apiBase = getApiBase('chat', model);
    const resolved = resolveModel('chat', model);
    const endpoint = resolved?.endpoint || '/v1/chat/completions';

    const response = await fetch(`${apiBase}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw await parseHttpError(response);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  } catch (error: any) {
    if (error.name === 'AbortError') {
      if (abortSignal?.aborted) {
        throw new Error('Request cancelled');
      }
      throw new Error(`Request timed out (${timeout}ms)`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (abortSignal) {
      abortSignal.removeEventListener('abort', handleExternalAbort);
    }
  }
};

/** Streaming chat completion (SSE) */
export const chatCompletionStream = async (
  prompt: string,
  model: string = '',
  temperature: number = 0.7,
  responseFormat: 'json_object' | undefined,
  timeout: number = 600000,
  onDelta?: (delta: string) => void,
  abortSignal?: AbortSignal
): Promise<string> => {
  const apiKey = checkApiKey('chat', model);
  const requestModel = resolveRequestModel('chat', model);

  const requestBody: any = {
    model: requestModel,
    messages: [{ role: 'user', content: prompt }],
    temperature,
    stream: true,
  };

  if (responseFormat === 'json_object') {
    requestBody.response_format = { type: 'json_object' };
  }

  const controller = new AbortController();
  const handleExternalAbort = () => controller.abort();

  if (abortSignal) {
    if (abortSignal.aborted) {
      controller.abort();
    } else {
      abortSignal.addEventListener('abort', handleExternalAbort);
    }
  }

  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const apiBase = getApiBase('chat', model);
    const resolved = resolveModel('chat', model);
    const endpoint = resolved?.endpoint || '/v1/chat/completions';

    const response = await fetch(`${apiBase}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw await parseHttpError(response);
    }

    if (!response.body) {
      throw new Error('Response body is empty; cannot process stream response.');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let fullText = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let boundaryIndex = buffer.indexOf('\n\n');
      while (boundaryIndex !== -1) {
        const chunk = buffer.slice(0, boundaryIndex).trim();
        buffer = buffer.slice(boundaryIndex + 2);

        if (chunk) {
          const lines = chunk.split('\n');
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const dataStr = line.replace(/^data:\s*/, '');

            if (dataStr === '[DONE]') {
              clearTimeout(timeoutId);
              return fullText;
            }

            try {
              const payload = JSON.parse(dataStr);
              const delta = payload?.choices?.[0]?.delta?.content || payload?.choices?.[0]?.message?.content || '';
              if (delta) {
                fullText += delta;
                onDelta?.(delta);
              }
            } catch {
              // Ignore malformed SSE JSON line.
            }
          }
        }

        boundaryIndex = buffer.indexOf('\n\n');
      }
    }

    clearTimeout(timeoutId);
    return fullText;
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      if (abortSignal?.aborted) {
        throw new Error('Request cancelled');
      }
      throw new Error(`Request timed out (${timeout}ms)`);
    }
    throw error;
  } finally {
    if (abortSignal) {
      abortSignal.removeEventListener('abort', handleExternalAbort);
    }
  }
};

// ============================================
// API key verification
// ============================================

/** Verify whether a provided key can call chat endpoint */
export const verifyApiKey = async (key: string): Promise<{ success: boolean; message: string }> => {
  try {
    const apiBase = getApiBase('chat');
    const response = await fetch(`${apiBase}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: 'gpt-41',
        messages: [{ role: 'user', content: 'Return 1 only.' }],
        temperature: 0.1,
        max_tokens: 5,
      }),
    });

    if (!response.ok) {
      let errorMessage = `Verification failed: ${response.status}`;
      try {
        const errorData = await response.json();
        errorMessage = errorData.error?.message || errorMessage;
      } catch {
        // ignore
      }
      return { success: false, message: errorMessage };
    }

    const data = await response.json();
    if (data.choices?.[0]?.message?.content !== undefined) {
      return { success: true, message: 'API Key 验证成功' };
    }

    return { success: false, message: '返回格式异常' };
  } catch (error: any) {
    return { success: false, message: error.message || '网络错误' };
  }
};

// ============================================
// Media conversion helpers
// ============================================

/** Convert a remote video URL to data URL base64 */
export const convertVideoUrlToBase64 = async (url: string): Promise<string> => {
  try {
    const response = await fetchMediaWithCorsFallback(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch video: HTTP ${response.status}`);
    }

    const blob = await response.blob();
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64String = reader.result as string;
        resolve(base64String);
      };
      reader.onerror = () => {
        reject(new Error('Failed to convert video to base64'));
      };
      reader.readAsDataURL(blob);
    });
  } catch (error: any) {
    console.error('convertVideoUrlToBase64 failed:', error);
    throw new Error(`Failed to convert video to base64: ${error.message}`);
  }
};

/**
 * Resize base64 PNG image to target size with cover strategy.
 * Return raw base64 (without data URI prefix).
 */
export const resizeImageToSize = async (base64Data: string, targetWidth: number, targetHeight: number): Promise<string> => {
  return new Promise((resolve, reject) => {
    const img = new Image();

    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = targetHeight;

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Failed to create canvas context'));
        return;
      }

      const scale = Math.max(targetWidth / img.width, targetHeight / img.height);
      const scaledWidth = img.width * scale;
      const scaledHeight = img.height * scale;
      const offsetX = (targetWidth - scaledWidth) / 2;
      const offsetY = (targetHeight - scaledHeight) / 2;

      ctx.drawImage(img, offsetX, offsetY, scaledWidth, scaledHeight);

      const result = canvas
        .toDataURL('image/png')
        .replace(/^data:image\/png;base64,/, '');
      resolve(result);
    };

    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = `data:image/png;base64,${base64Data}`;
  });
};

// ============================================
// Video model helpers
// ============================================

/** Get Veo model by reference mode and aspect ratio */
export const getVeoModelName = (hasReferenceImage: boolean, aspectRatio: AspectRatio): string => {
  const orientation = aspectRatio === '9:16' ? 'portrait' : 'landscape';
  if (hasReferenceImage) {
    return `veo_3_1_i2v_s_fast_fl_${orientation}`;
  }
  return `veo_3_1_t2v_fast_${orientation}`;
};

/** Map aspect ratio to Sora size */
export const getSoraVideoSize = (aspectRatio: AspectRatio): string => {
  const sizeMap: Record<AspectRatio, string> = {
    '16:9': '1280x720',
    '9:16': '720x1280',
    '1:1': '720x720',
  };
  return sizeMap[aspectRatio];
};
