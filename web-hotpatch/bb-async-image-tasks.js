(function () {
  if (window.__BIGBANANA_ASYNC_IMAGE_TASKS_INSTALLED__) return;
  window.__BIGBANANA_ASYNC_IMAGE_TASKS_INSTALLED__ = true;

  var TASK_ENDPOINT = '/api/project-store/image-tasks';
  var STORAGE_KEY = 'bigbanana_async_image_tasks';
  var POLL_DELAY_MS = 2000;
  var originalFetch = window.fetch.bind(window);

  var state = {
    ok: true,
    mode: 'server-async-image-tasks',
    tasks: {},
    diagnostics: []
  };
  window.__BIGBANANA_ASYNC_IMAGE_TASKS__ = state;

  var recordDiagnostic = function (event, details) {
    var item = Object.assign({
      event: event,
      at: new Date().toISOString()
    }, details || {});
    state.diagnostics.push(item);
    if (state.diagnostics.length > 30) {
      state.diagnostics.splice(0, state.diagnostics.length - 30);
    }
    state.lastDiagnostic = item;
    try {
      console.info('[BigBanana async image]', event, details || {});
    } catch (error) {
      // Console logging must never affect image generation.
    }
  };

  var loadStoredTasks = function () {
    try {
      return JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}') || {};
    } catch (error) {
      return {};
    }
  };

  var saveStoredTasks = function () {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state.tasks || {}));
    } catch (error) {
      // Ignore storage quota/private mode failures. The server-side queue is still authoritative.
    }
  };

  state.tasks = loadStoredTasks();

  var rememberTask = function (task) {
    if (!task || !task.id) return;
    state.tasks[task.id] = task;
    state.lastTaskId = task.id;
    saveStoredTasks();
  };

  var sleep = function (ms) {
    return new Promise(function (resolve) {
      window.setTimeout(resolve, ms);
    });
  };

  var abortError = function () {
    var error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    return error;
  };

  var headersToObject = function (headers) {
    var output = {};
    headers.forEach(function (value, key) {
      output[key] = value;
    });
    return output;
  };

  var parseJson = function (text) {
    try {
      return JSON.parse(text || '{}') || {};
    } catch (error) {
      return {};
    }
  };

  var extractPromptFromGeminiBody = function (bodyText) {
    var body = parseJson(bodyText);
    if (typeof body.prompt === 'string' && body.prompt.trim()) return body.prompt.trim();

    var texts = [];
    (body.contents || []).forEach(function (content) {
      (content.parts || []).forEach(function (part) {
        if (typeof part.text === 'string' && part.text.trim()) {
          texts.push(part.text.trim());
        }
      });
    });

    return texts.join('\n\n').trim();
  };

  var getActiveImageModel = function () {
    try {
      var registry = window.BIGBANANA_MODEL_REGISTRY_CONFIG;
      if (!registry) {
        registry = JSON.parse(window.localStorage.getItem('bigbanana_model_registry') || '{}');
      }
      var activeImageId = registry && registry.activeModels && registry.activeModels.image;
      var models = registry && registry.models;
      if (models && !Array.isArray(models)) models = models.image;
      if (activeImageId && Array.isArray(models)) {
        return models.find(function (model) {
          return model && model.id === activeImageId;
        }) || null;
      }
    } catch (error) {
      return null;
    }
    return null;
  };

  var buildOpenAiImageBody = function (bodyText) {
    var originalBody = parseJson(bodyText);
    var activeModel = getActiveImageModel() || {};
    var params = activeModel.params || {};
    var prompt = extractPromptFromGeminiBody(bodyText) || originalBody.prompt || '';
    var output = {
      model: activeModel.apiModel || originalBody.model || activeModel.id || 'gpt-image-2',
      prompt: prompt,
      n: Number(originalBody.n || params.n || 1) || 1,
      size: originalBody.size || params.size || '1024x1024'
    };

    if (originalBody.quality || params.quality) output.quality = originalBody.quality || params.quality;
    if (originalBody.background || params.background) output.background = originalBody.background || params.background;
    return JSON.stringify(output);
  };

  var buildGeminiChatImageBody = function (bodyText) {
    var originalBody = parseJson(bodyText);
    var activeModel = getActiveImageModel() || {};
    var prompt = extractPromptFromGeminiBody(bodyText) || originalBody.prompt || '';
    return JSON.stringify({
      model: activeModel.apiModel || originalBody.model || 'gemini-3.1-flash-image',
      messages: [{ role: 'user', content: prompt }]
    });
  };

  var isGeminiFlashImageModel = function (model) {
    var apiModel = String((model && (model.apiModel || model.model || model.id)) || '').toLowerCase();
    return apiModel === 'gemini-3.1-flash-image';
  };

  var isImageGenerationRequest = function (url, method, bodyText) {
    if (method !== 'POST') return null;
    if (url.indexOf(TASK_ENDPOINT) >= 0) return null;

    var parsed;
    try {
      parsed = new URL(url, window.location.href);
    } catch (error) {
      return null;
    }

    var path = parsed.pathname.toLowerCase();
    var bodyLower = String(bodyText || '').toLowerCase();

    if (path.indexOf('/v1/images/generations') >= 0) {
      var activeModel = getActiveImageModel();
      if (isGeminiFlashImageModel(activeModel)) {
        return {
          upstreamFormat: 'openai-chat-image',
          clientFormat: 'gemini-image',
          upstreamPublicUrl: '/api/ai-muling/v1/chat/completions',
          transformBody: buildGeminiChatImageBody,
          reason: 'gemini-flash-image-chat-compatible-endpoint'
        };
      }

      return {
        upstreamFormat: 'openai-image',
        clientFormat: 'gemini-image',
        transformBody: buildOpenAiImageBody,
        reason: 'openai-compatible-images-endpoint'
      };
    }

    if (path.indexOf(':generatecontent') >= 0 && bodyLower.indexOf('"image"') >= 0) {
      return {
        upstreamFormat: 'gemini-image',
        clientFormat: 'gemini-image',
        transformBody: null,
        reason: 'gemini-generate-content-image'
      };
    }

    return null;
  };

  var createTask = async function (request, bodyText, route) {
    var upstreamBody = route.transformBody ? route.transformBody(bodyText) : bodyText;
    var upstreamPublicUrl = route.upstreamPublicUrl || request.url;
    if (!route.upstreamPublicUrl) {
      try {
        var parsedUpstreamUrl = new URL(request.url, window.location.href);
        upstreamPublicUrl = parsedUpstreamUrl.pathname + (parsedUpstreamUrl.search || '');
      } catch (error) {
        // Keep the original request URL if URL parsing fails.
      }
    }
    var response = await originalFetch(TASK_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        responseFormat: route.upstreamFormat,
        upstreamPublicUrl: upstreamPublicUrl,
        upstream: {
          url: upstreamPublicUrl,
          method: request.method,
          headers: headersToObject(request.headers),
          body: upstreamBody,
          responseFormat: route.upstreamFormat
        }
      })
    });

    if (!response.ok) {
      throw new Error('image task create failed: HTTP ' + response.status);
    }

    var result = await response.json();
    if (!result || !result.ok || !result.taskId) {
      throw new Error('image task create returned invalid response');
    }

    rememberTask(result.task || { id: result.taskId, status: 'queued' });
    state.lastCreatedAt = Date.now();
    state.lastTaskRoute = {
      upstreamFormat: route.upstreamFormat,
      clientFormat: route.clientFormat,
      reason: route.reason
    };
    return result.taskId;
  };

  var pollTask = async function (taskId, signal) {
    for (;;) {
      var response = await originalFetch(TASK_ENDPOINT + '/' + encodeURIComponent(taskId) + '?includeDataUrl=1', {
        method: 'GET',
        cache: 'no-store'
      });
      if (!response.ok) {
        throw new Error('image task poll failed: HTTP ' + response.status);
      }

      var result = await response.json();
      var task = result && result.task;
      rememberTask(task || { id: taskId, status: 'unknown' });

      if (task && task.status === 'completed') return task;
      if (task && task.status === 'failed') {
        throw new Error(task.error || 'image task failed');
      }

      if (signal && signal.aborted) {
        // 浏览器切页/刷新时，任务已经交给服务端，继续轮询会把“前端中断”误判成失败。
        // 这里不抛 AbortError，让服务端任务自然完成，避免把图片生成状态写成 failed。
      }

      await sleep(POLL_DELAY_MS);
    }
  };

  var splitDataUrl = function (dataUrl) {
    var match = String(dataUrl || '').match(/^data:([^;,]+);base64,(.+)$/);
    if (!match) return null;
    return { mimeType: match[1], base64: match[2] };
  };

  var responseFromTask = function (task, responseFormat) {
    var parsed = splitDataUrl(task.dataUrl);
    var headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'X-BigBanana-Image-Task-Id': task.id
    };

    if (responseFormat === 'gemini-image') {
      if (!parsed) {
        throw new Error('completed image task is missing inline image data');
      }

      return new Response(JSON.stringify({
        candidates: [{
          content: {
            parts: [{
              inlineData: {
                mimeType: parsed.mimeType,
                data: parsed.base64
              }
            }]
          }
        }]
      }), { status: 200, headers: headers });
    }

    return new Response(JSON.stringify({
      created: Math.floor(Date.now() / 1000),
      data: [{
        url: task.imageUrl,
        b64_json: parsed ? parsed.base64 : undefined
      }]
    }), { status: 200, headers: headers });
  };

  var resumeStoredTasks = function () {
    Object.keys(state.tasks || {}).forEach(function (taskId) {
      var task = state.tasks[taskId];
      if (!task || task.status === 'completed' || task.status === 'failed') return;
      pollTask(taskId, null).catch(function (error) {
        state.tasks[taskId] = Object.assign({}, task, {
          id: taskId,
          status: 'poll_error',
          pollError: error && error.message ? error.message : String(error)
        });
        saveStoredTasks();
      });
    });
  };

  var hasActiveStoredTask = function () {
    return Object.keys(state.tasks || {}).some(function (taskId) {
      var task = state.tasks[taskId];
      return task && task.status !== 'completed' && task.status !== 'failed' && task.status !== 'poll_error';
    });
  };

  var recoverStaleGeneratingState = function (project) {
    if (!project || hasActiveStoredTask()) return project;

    var changed = false;
    var markPending = function (item) {
      if (!item || item.status !== 'generating') return item;
      if (item.referenceImage || item.imageUrl) return item;
      changed = true;
      return Object.assign({}, item, {
        status: 'pending',
        lastTransientFailure: 'stale generating state without active server image task'
      });
    };

    var next = project;
    if (project.scriptData) {
      var scriptData = Object.assign({}, project.scriptData);
      scriptData.characters = (scriptData.characters || []).map(function (character) {
        var nextCharacter = markPending(character);
        var variations = (nextCharacter.variations || []).map(markPending);
        return variations !== nextCharacter.variations
          ? Object.assign({}, nextCharacter, { variations: variations })
          : nextCharacter;
      });
      scriptData.scenes = (scriptData.scenes || []).map(markPending);
      scriptData.props = (scriptData.props || []).map(markPending);
      next = Object.assign({}, next, { scriptData: scriptData });
    }

    if (Array.isArray(project.shots)) {
      next = Object.assign({}, next, {
        shots: project.shots.map(function (shot) {
          var keyframes = (shot.keyframes || []).map(markPending);
          var nineGrid = shot.nineGrid && !shot.nineGrid.imageUrl && (
            shot.nineGrid.status === 'generating' ||
            shot.nineGrid.status === 'generating_image' ||
            shot.nineGrid.status === 'generating_panels'
          )
            ? Object.assign({}, shot.nineGrid, {
                status: 'pending',
                lastTransientFailure: 'stale generating state without active server image task'
              })
            : shot.nineGrid;
          if (keyframes === shot.keyframes && nineGrid === shot.nineGrid) return shot;
          changed = true;
          return Object.assign({}, shot, { keyframes: keyframes, nineGrid: nineGrid });
        })
      });
    }

    return changed ? next : project;
  };

  window.fetch = async function (input, init) {
    var request = input instanceof Request ? input : new Request(input, init);
    var method = (request.method || 'GET').toUpperCase();
    var bodyText = '';

    if (method === 'POST') {
      try {
        bodyText = await request.clone().text();
      } catch (error) {
        bodyText = '';
      }
    }

    var route = isImageGenerationRequest(request.url, method, bodyText);
    if (!route) {
      return originalFetch(input, init);
    }

    recordDiagnostic('intercept', {
      url: request.url,
      upstreamFormat: route.upstreamFormat,
      clientFormat: route.clientFormat,
      reason: route.reason
    });

    try {
      var taskId = await createTask(request, bodyText, route);
      var task = await pollTask(taskId, null);
      return responseFromTask(task, route.clientFormat);
    } catch (error) {
      state.lastError = error && error.message ? error.message : String(error);
      recordDiagnostic('failed', { message: state.lastError });
      throw error;
    }
  };

  resumeStoredTasks();
  window.__BIGBANANA_RECOVER_STALE_GENERATING_STATE__ = recoverStaleGeneratingState;
})();
