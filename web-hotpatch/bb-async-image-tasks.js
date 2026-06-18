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
    tasks: {}
  };
  window.__BIGBANANA_ASYNC_IMAGE_TASKS__ = state;

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

  var isImageGenerationRequest = function (url, method, bodyText) {
    if (method !== 'POST') return null;
    if (url.indexOf(TASK_ENDPOINT) >= 0) return null;

    var parsed;
    try {
      parsed = new URL(url, window.location.href);
    } catch (error) {
      return null;
    }

    if (parsed.pathname.indexOf('/v1/images/generations') >= 0) {
      return 'openai-image';
    }

    if (parsed.pathname.indexOf(':generateContent') >= 0 && /"IMAGE"/.test(bodyText || '')) {
      return 'gemini-image';
    }

    return null;
  };

  var createTask = async function (request, bodyText, responseFormat) {
    var response = await originalFetch(TASK_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        responseFormat: responseFormat,
        upstream: {
          url: request.url,
          method: request.method,
          headers: headersToObject(request.headers),
          body: bodyText,
          responseFormat: responseFormat
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

    var responseFormat = isImageGenerationRequest(request.url, method, bodyText);
    if (!responseFormat) {
      return originalFetch(input, init);
    }

    var taskId = await createTask(request, bodyText, responseFormat);
    var task = await pollTask(taskId, null);
    return responseFromTask(task, responseFormat);
  };

  resumeStoredTasks();
})();
