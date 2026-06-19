(function () {
  var DB_NAME = 'BigBananaDB';
  var DB_VERSION = 3;
  var STORES = ['projects', 'assetLibrary', 'seriesProjects', 'series', 'episodes'];
  var ENDPOINT = '/api/project-store/backup';
  var MEDIA_ENDPOINT = '/api/project-store/media';
  var MEDIA_URL_PREFIX = '/api/project-store/media/';
  var IMAGE_TASKS_ENDPOINT = '/api/project-store/image-tasks';
  var SAVE_DELAY_MS = 1200;
  var IMAGE_TASK_SYNC_INTERVAL_MS = 10000;

  var saveTimer = null;
  var imageTaskSyncTimer = null;
  var imageTaskSyncRunning = false;
  var readyResolved = false;
  var initialServerLoadComplete = false;
  var restoringFromServer = false;
  var lastSavedSignature = '';
  var readyResolve = null;

  window.__BIGBANANA_PROJECT_STORE_READY__ = new Promise(function (resolve) {
    readyResolve = resolve;
  });

  var finishReady = function () {
    if (readyResolved) return;
    readyResolved = true;
    initialServerLoadComplete = true;
    if (readyResolve) readyResolve();
  };

  var openDB = function () {
    return new Promise(function (resolve, reject) {
      var request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = function () { reject(request.error); };
      request.onsuccess = function () { resolve(request.result); };
      request.onupgradeneeded = function (event) {
        var db = event.target.result;
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('assetLibrary')) db.createObjectStore('assetLibrary', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('seriesProjects')) db.createObjectStore('seriesProjects', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('series')) {
          var seriesStore = db.createObjectStore('series', { keyPath: 'id' });
          seriesStore.createIndex('projectId', 'projectId', { unique: false });
        }
        if (!db.objectStoreNames.contains('episodes')) {
          var episodeStore = db.createObjectStore('episodes', { keyPath: 'id' });
          episodeStore.createIndex('projectId', 'projectId', { unique: false });
          episodeStore.createIndex('seriesId', 'seriesId', { unique: false });
        }
      };
    });
  };

  var getAll = function (db, storeName) {
    return new Promise(function (resolve, reject) {
      if (!db.objectStoreNames.contains(storeName)) {
        resolve([]);
        return;
      }

      var tx = db.transaction(storeName, 'readonly');
      var req = tx.objectStore(storeName).getAll();
      req.onsuccess = function () { resolve(req.result || []); };
      req.onerror = function () { reject(req.error); };
    });
  };

  var exportPayload = async function () {
    var db = await openDB();
    try {
      var stores = {};
      for (var i = 0; i < STORES.length; i += 1) {
        stores[STORES[i]] = await getAll(db, STORES[i]);
      }

      return {
        schemaVersion: 3,
        exportedAt: Date.now(),
        scope: 'all',
        dbName: DB_NAME,
        dbVersion: DB_VERSION,
        stores: stores
      };
    } finally {
      db.close();
    }
  };

  var countPayloadItems = function (payload) {
    var stores = payload && payload.stores ? payload.stores : {};
    return STORES.reduce(function (total, storeName) {
      return total + (stores[storeName] || []).length;
    }, 0);
  };

  var contentSignature = function (payload) {
    var stores = payload && payload.stores ? payload.stores : {};
    var summary = {};

    STORES.forEach(function (storeName) {
      summary[storeName] = (stores[storeName] || []).map(function (item) {
        var json = '';
        try {
          json = JSON.stringify(item, function (key, value) {
            if (key === 'lastModified' || key === 'updatedAt' || key === 'serverPersistedAt') {
              return undefined;
            }
            return value;
          });
        } catch (error) {
          json = String(item && item.id ? item.id : '');
        }

        return {
          id: item && item.id ? String(item.id) : '',
          json: json
        };
      }).sort(function (a, b) {
        return a.id.localeCompare(b.id);
      });
    });

    return JSON.stringify(summary);
  };

  var storesContentSignature = function (payload) {
    try {
      return JSON.stringify((payload && payload.stores) || {});
    } catch (error) {
      return '';
    }
  };

  var notifyProjectStoreUpdated = function (reason, payload) {
    try {
      window.dispatchEvent(new CustomEvent('bigbanana:project-store-updated', {
        detail: {
          reason: reason,
          at: Date.now(),
          items: countPayloadItems(payload)
        }
      }));
    } catch (error) {
      // UI refresh notifications are best-effort; persistence must continue.
    }
  };

  var replaceWithPayload = async function (payload) {
    var db = await openDB();
    try {
      await new Promise(function (resolve, reject) {
        var tx = db.transaction(STORES, 'readwrite');
        var stores = payload.stores || {};

        STORES.forEach(function (storeName) {
          tx.objectStore(storeName).clear();
        });

        STORES.forEach(function (storeName) {
          (stores[storeName] || []).forEach(function (item) {
            tx.objectStore(storeName).put(item);
          });
        });

        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    } finally {
      db.close();
    }
  };

  var putServerPayload = async function (payload) {
    return fetch(ENDPOINT, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  };

  var isDataImageUrl = function (value) {
    return typeof value === 'string' && /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(value);
  };

  var isServerMediaUrl = function (value) {
    return typeof value === 'string' && value.indexOf(MEDIA_URL_PREFIX) === 0;
  };

  var shouldPersistImageKey = function (key) {
    return /^(referenceImage|shapeReferenceImage|imageUrl|thumbnailUrl|previewUrl|coverImage|url)$/.test(key);
  };

  var uploadMedia = async function (dataUrl, pathParts) {
    var response = await fetch(MEDIA_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dataUrl: dataUrl,
        folder: 'persisted',
        filenamePrefix: pathParts.join('-').slice(0, 80) || 'image'
      })
    });

    if (!response.ok) {
      throw new Error('media upload failed: ' + response.status);
    }

    var result = await response.json();
    if (!result || !result.ok || !result.url) {
      throw new Error('media upload returned invalid response');
    }

    return result.url;
  };

  var materializeMediaUrls = async function (value, pathParts, cache) {
    if (!value || typeof value !== 'object') return value;

    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i += 1) {
        value[i] = await materializeMediaUrls(value[i], pathParts.concat(String(i)), cache);
      }
      return value;
    }

    var keys = Object.keys(value);
    for (var k = 0; k < keys.length; k += 1) {
      var key = keys[k];
      var child = value[key];

      if (shouldPersistImageKey(key) && isDataImageUrl(child)) {
        if (!cache[child]) {
          cache[child] = uploadMedia(child, pathParts.concat(key));
        }
        value[key] = await cache[child];
      } else if (shouldPersistImageKey(key) && isServerMediaUrl(child)) {
        value[key] = child;
      } else if (child && typeof child === 'object') {
        value[key] = await materializeMediaUrls(child, pathParts.concat(key), cache);
      }
    }

    return value;
  };

  var materializePayloadMedia = async function (payload) {
    var cache = {};
    var stores = payload && payload.stores ? payload.stores : {};

    for (var i = 0; i < STORES.length; i += 1) {
      var storeName = STORES[i];
      var items = stores[storeName] || [];
      for (var j = 0; j < items.length; j += 1) {
        items[j] = await materializeMediaUrls(items[j], [storeName, String(j)], cache);
      }
    }

    payload.mediaMaterializedAt = Date.now();
    return payload;
  };

  var isTransientGenerationError = function (value) {
    return /Failed to fetch|AbortError|aborted|NetworkError|Load failed|Unexpected end of JSON input/i.test(String(value || ''));
  };

  var hasImageReference = function (value) {
    if (!value || typeof value !== 'object') return false;

    var imageKeys = ['imageUrl', 'url', 'referenceImage', 'thumbnailUrl', 'previewUrl', 'coverImage', 'shapeReferenceImage'];
    for (var i = 0; i < imageKeys.length; i += 1) {
      if (typeof value[imageKeys[i]] === 'string' && value[imageKeys[i]]) return true;
    }

    if (Array.isArray(value.panels)) {
      for (var j = 0; j < value.panels.length; j += 1) {
        if (hasImageReference(value.panels[j])) return true;
      }
    }

    return false;
  };

  var firstImageReference = function (value) {
    if (!value || typeof value !== 'object') return '';
    var imageKeys = ['imageUrl', 'referenceImage', 'generatedImage', 'thumbnailUrl', 'previewUrl', 'coverImage', 'shapeReferenceImage', 'url'];
    for (var i = 0; i < imageKeys.length; i += 1) {
      var imageUrl = value[imageKeys[i]];
      if (typeof imageUrl === 'string' && imageUrl && imageUrl.indexOf('bb-image-task://') !== 0) return imageUrl;
    }
    return '';
  };

  var normalizeImageReferenceFields = function (value) {
    if (!value || typeof value !== 'object') return 0;
    var changed = 0;

    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i += 1) {
        changed += normalizeImageReferenceFields(value[i]);
      }
      return changed;
    }

    var imageUrl = firstImageReference(value);
    if (imageUrl) {
      if (!firstImageReference({ imageUrl: value.imageUrl })) {
        value.imageUrl = imageUrl;
        changed += 1;
      }
      if (!firstImageReference({ referenceImage: value.referenceImage })) {
        value.referenceImage = imageUrl;
        changed += 1;
      }
      if (!firstImageReference({ generatedImage: value.generatedImage })) {
        value.generatedImage = imageUrl;
        changed += 1;
      }

      var status = String(value.status || '').toLowerCase();
      if (status === 'failed' || status === 'generating' || status === 'queued' || status === 'generating_image' || status === 'generating_panels' || status === 'pending') {
        value.status = 'completed';
        delete value.error;
        delete value.failureReason;
        delete value.lastTransientFailure;
        changed += 1;
      }
    }

    Object.keys(value).forEach(function (key) {
      changed += normalizeImageReferenceFields(value[key]);
    });

    return changed;
  };

  var normalizeText = function (value) {
    return String(value || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  };

  var getSlotPrompt = function (value) {
    if (!value || typeof value !== 'object') return '';
    return normalizeText([
      value.visualPrompt,
      value.prompt,
      value.description,
      value.name,
      value.location,
      value.actionSummary
    ].filter(Boolean).join(' '));
  };

  var taskMatchesSlot = function (task, slot) {
    var taskPrompt = normalizeText(task && task.prompt);
    var slotPrompt = getSlotPrompt(slot);
    if (!taskPrompt || !slotPrompt) return false;
    if (taskPrompt.indexOf(slotPrompt) >= 0 || slotPrompt.indexOf(taskPrompt) >= 0) return true;

    var slotWords = slotPrompt.split(' ').filter(function (word) { return word.length >= 4; });
    if (slotWords.length === 0) return false;
    var matched = slotWords.filter(function (word) { return taskPrompt.indexOf(word) >= 0; }).length;
    return matched >= Math.min(6, Math.ceil(slotWords.length * 0.55));
  };

  var collectUsedImageTaskIds = function (value, used) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(function (item) { collectUsedImageTaskIds(item, used); });
      return;
    }

    ['imageTaskId', 'recoveredImageTaskId', 'serverImageTaskId'].forEach(function (key) {
      if (typeof value[key] === 'string' && value[key]) used[value[key]] = true;
    });

    Object.keys(value).forEach(function (key) {
      collectUsedImageTaskIds(value[key], used);
    });
  };

  var shouldRecoverImageSlot = function (value) {
    if (!value || typeof value !== 'object') return false;
    if (hasImageReference(value)) return false;
    var status = String(value.status || '').toLowerCase();
    if (status !== 'generating' && status !== 'failed') return false;
    if (value.type && value.resourceId && value.model && value.prompt) return false;
    return Boolean(
      value.visualPrompt ||
      value.prompt ||
      value.description ||
      value.name ||
      value.location ||
      value.actionSummary ||
      Array.isArray(value.panels)
    );
  };

  var applyTaskImageToSlot = function (slot, task) {
    var imageUrl = task && task.imageUrl;
    if (!imageUrl) return false;

    slot.imageUrl = imageUrl;
    slot.referenceImage = imageUrl;
    slot.generatedImage = imageUrl;
    slot.status = 'completed';
    slot.serverImageTaskId = task.id;
    slot.imageTaskId = task.id;
    slot.recoveredImageTaskId = task.id;
    slot.recoveredImageTaskAt = Date.now();
    delete slot.error;
    delete slot.failureReason;
    delete slot.lastTransientFailure;
    return true;
  };

  var recoverImageSlotsFromTasks = function (value, tasks, used) {
    if (!value || typeof value !== 'object' || tasks.length === 0) return 0;
    var recovered = 0;

    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i += 1) {
        recovered += recoverImageSlotsFromTasks(value[i], tasks, used);
      }
      return recovered;
    }

    if (shouldRecoverImageSlot(value)) {
      var matchedTask = tasks.find(function (task) {
        return !used[task.id] && taskMatchesSlot(task, value);
      });
      if (!matchedTask && String(value.status || '').toLowerCase() === 'generating') {
        matchedTask = tasks.find(function (task) { return !used[task.id]; });
      }
      if (matchedTask && applyTaskImageToSlot(value, matchedTask)) {
        used[matchedTask.id] = true;
        recovered += 1;
      }
    }

    Object.keys(value).forEach(function (key) {
      recovered += recoverImageSlotsFromTasks(value[key], tasks, used);
    });

    return recovered;
  };

  var isActiveImageTask = function (task) {
    return task && (task.status === 'queued' || task.status === 'running');
  };

  var isTerminalImageTask = function (task) {
    return task && (task.status === 'completed' || task.status === 'failed' || task.status === 'canceled');
  };

  var imageTaskIdForSlot = function (value) {
    if (!value || typeof value !== 'object') return '';
    return value.serverImageTaskId || value.imageTaskId || value.recoveredImageTaskId || '';
  };

  var fetchImageTasks = async function () {
    try {
      var response = await fetch(IMAGE_TASKS_ENDPOINT + '?limit=200', { method: 'GET', cache: 'no-store' });
      if (!response.ok) return [];
      var result = await response.json();
      return (result.tasks || [])
        .filter(function (task) { return task && task.id; })
        .sort(function (a, b) {
          return (a.completedAt || a.failedAt || a.canceledAt || a.updatedAt || a.createdAt || 0)
            - (b.completedAt || b.failedAt || b.canceledAt || b.updatedAt || b.createdAt || 0);
        });
    } catch (error) {
      console.warn('[project-store-sync] image task state lookup failed', error);
      return [];
    }
  };

  var applyTerminalImageTaskToSlot = function (slot, task) {
    if (!slot || !task || !isTerminalImageTask(task)) return false;
    if (task.status === 'completed' && task.imageUrl) {
      return applyTaskImageToSlot(slot, task);
    }

    if (task.status === 'failed' || task.status === 'canceled') {
      if (hasImageReference(slot)) return false;
      slot.status = 'failed';
      slot.imageTaskId = task.id;
      slot.serverImageTaskId = task.id;
      slot.imageTaskResolvedAt = Date.now();
      slot.error = task.error || (task.status === 'canceled' ? 'Image task canceled.' : 'Image generation task failed.');
      delete slot.failureReason;
      return true;
    }

    return false;
  };

  var applyActiveImageTaskToSlot = function (slot, task) {
    if (!slot || !task || !isActiveImageTask(task)) return false;
    var status = String(slot.status || '').toLowerCase();
    if (
      status !== 'failed' &&
      status !== 'pending' &&
      status !== 'queued' &&
      status !== 'generating' &&
      status !== 'generating_image' &&
      status !== 'generating_panels'
    ) {
      return false;
    }

    slot.status = Array.isArray(slot.panels) ? 'generating_image' : 'generating';
    slot.imageTaskId = task.id;
    slot.serverImageTaskId = task.id;
    delete slot.error;
    delete slot.failureReason;
    delete slot.lastTransientFailure;
    return true;
  };

  var syncTerminalImageTaskSlots = function (value, terminalById) {
    if (!value || typeof value !== 'object') return 0;
    var changed = 0;

    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i += 1) {
        changed += syncTerminalImageTaskSlots(value[i], terminalById);
      }
      return changed;
    }

    var taskId = imageTaskIdForSlot(value);
    if (taskId && terminalById[taskId]) {
      changed += applyTerminalImageTaskToSlot(value, terminalById[taskId]) ? 1 : 0;
    }

    Object.keys(value).forEach(function (key) {
      changed += syncTerminalImageTaskSlots(value[key], terminalById);
    });

    return changed;
  };

  var syncActiveImageTaskSlots = function (value, activeById) {
    if (!value || typeof value !== 'object') return 0;
    var changed = 0;

    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i += 1) {
        changed += syncActiveImageTaskSlots(value[i], activeById);
      }
      return changed;
    }

    var taskId = imageTaskIdForSlot(value);
    if (taskId && activeById[taskId]) {
      changed += applyActiveImageTaskToSlot(value, activeById[taskId]) ? 1 : 0;
    }

    Object.keys(value).forEach(function (key) {
      changed += syncActiveImageTaskSlots(value[key], activeById);
    });

    return changed;
  };

  var clearStaleGeneratingSlots = function (value) {
    if (!value || typeof value !== 'object') return 0;
    var changed = 0;

    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i += 1) {
        changed += clearStaleGeneratingSlots(value[i]);
      }
      return changed;
    }

    var status = String(value.status || '').toLowerCase();
    if (status === 'generating' || status === 'queued' || status === 'generating_image' || status === 'generating_panels') {
      if (hasImageReference(value)) {
        var imageUrl = value.imageUrl || value.referenceImage || value.generatedImage || value.thumbnailUrl || value.previewUrl || value.coverImage || value.url;
        value.imageUrl = value.imageUrl || imageUrl;
        value.referenceImage = value.referenceImage || imageUrl;
        value.generatedImage = value.generatedImage || imageUrl;
        value.status = 'completed';
        delete value.error;
        delete value.failureReason;
        delete value.lastTransientFailure;
        changed += 1;
      } else {
        value.status = 'pending';
        value.lastTransientFailure = 'stale generating state without active server image task';
        delete value.error;
        delete value.failureReason;
        changed += 1;
      }
    }

    Object.keys(value).forEach(function (key) {
      changed += clearStaleGeneratingSlots(value[key]);
    });

    return changed;
  };

  var syncImageTaskState = function (payload, tasks) {
    if (!payload || !payload.stores) return payload;
    var activeTasks = tasks.filter(isActiveImageTask);
    var activeById = {};
    activeTasks.forEach(function (task) {
      activeById[task.id] = task;
    });
    var terminalById = {};
    tasks.filter(isTerminalImageTask).forEach(function (task) {
      terminalById[task.id] = task;
    });

    var activeSynced = syncActiveImageTaskSlots(payload.stores, activeById);
    var terminalSynced = syncTerminalImageTaskSlots(payload.stores, terminalById);
    var staleCleared = activeTasks.length === 0 ? clearStaleGeneratingSlots(payload.stores) : 0;
    var imageFieldsNormalized = normalizeImageReferenceFields(payload.stores);

    window.__BIGBANANA_SERVER_IMAGE_TASK_STATE__ = {
      ok: true,
      active: activeTasks.length,
      activeSynced: activeSynced,
      terminal: Object.keys(terminalById).length,
      terminalSynced: terminalSynced,
      staleCleared: staleCleared,
      imageFieldsNormalized: imageFieldsNormalized,
      at: Date.now()
    };

    if (activeSynced > 0 || terminalSynced > 0 || staleCleared > 0 || imageFieldsNormalized > 0) {
      payload.imageTasksSyncedAt = Date.now();
      payload.imageTasksActiveSyncedCount = (payload.imageTasksActiveSyncedCount || 0) + activeSynced;
      payload.imageTasksTerminalSyncedCount = (payload.imageTasksTerminalSyncedCount || 0) + terminalSynced;
      payload.imageTasksStaleClearedCount = (payload.imageTasksStaleClearedCount || 0) + staleCleared;
      payload.imageFieldsNormalizedCount = (payload.imageFieldsNormalizedCount || 0) + imageFieldsNormalized;
    }

    return payload;
  };

  var recoverCompletedImageTasks = async function (payload, allTasks) {
    if (!payload || !payload.stores) return payload;
    var tasks = (allTasks || await fetchImageTasks())
      .filter(function (task) {
        return task && task.id && task.status === 'completed' && task.imageUrl;
      });
    if (tasks.length === 0) return payload;

    var used = {};
    collectUsedImageTaskIds(payload, used);
    var recovered = recoverImageSlotsFromTasks(payload.stores, tasks, used);
    if (recovered > 0) {
      payload.imageTasksRecoveredAt = Date.now();
      payload.imageTasksRecoveredCount = (payload.imageTasksRecoveredCount || 0) + recovered;
      window.__BIGBANANA_IMAGE_TASK_RECOVERY__ = {
        ok: true,
        recovered: recovered,
        checkedTasks: tasks.length,
        at: payload.imageTasksRecoveredAt
      };
    }

    return payload;
  };

  var isEmptyImageAssetFailure = function (value) {
    if (!value || typeof value !== 'object' || value.status !== 'failed') return false;
    if (value.error || value.message || value.failureReason) return false;
    if (hasImageReference(value)) return false;

    var isRenderLog = Boolean(value.type && value.resourceId && value.model && value.prompt);
    if (isRenderLog) return false;

    return Array.isArray(value.panels) || Boolean(value.visualPrompt || value.negativePrompt);
  };

  var clearTransientGenerationFailures = function (value) {
    if (!value || typeof value !== 'object') return value;

    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i += 1) {
        value[i] = clearTransientGenerationFailures(value[i]);
      }
      return value;
    }

    if (value.status === 'failed' && isTransientGenerationError(value.error || value.message || value.failureReason)) {
      value.lastTransientFailure = value.error || value.message || value.failureReason;
      value.status = value.imageUrl || value.url || value.referenceImage || value.thumbnailUrl ? 'completed' : 'pending';
      delete value.error;
      delete value.failureReason;
    }

    if (isEmptyImageAssetFailure(value)) {
      value.lastTransientFailure = 'empty failed image state without server task';
      value.status = 'pending';
    }

    Object.keys(value).forEach(function (key) {
      value[key] = clearTransientGenerationFailures(value[key]);
    });

    return value;
  };

  var recoverStaleGeneratingState = function (payload) {
    if (
      window.__BIGBANANA_RECOVER_STALE_GENERATING_STATE__ &&
      typeof window.__BIGBANANA_RECOVER_STALE_GENERATING_STATE__ === 'function'
    ) {
      return window.__BIGBANANA_RECOVER_STALE_GENERATING_STATE__(payload);
    }

    return payload;
  };

  var persistNow = async function () {
    if (restoringFromServer || !initialServerLoadComplete) return;

    try {
      var payload = await exportPayload();
      if (countPayloadItems(payload) === 0) return;
      var localStoresSignature = storesContentSignature(payload);
      payload = clearTransientGenerationFailures(payload);
      payload = recoverStaleGeneratingState(payload);
      var imageTasks = await fetchImageTasks();
      payload = syncImageTaskState(payload, imageTasks);
      payload = await recoverCompletedImageTasks(payload, imageTasks);
      payload = await materializePayloadMedia(payload);

      if (storesContentSignature(payload) !== localStoresSignature) {
        restoringFromServer = true;
        await replaceWithPayload(payload);
        restoringFromServer = false;
        notifyProjectStoreUpdated('image-task-sync', payload);
      }

      var signature = contentSignature(payload);
      if (signature === lastSavedSignature) return;

      var response = await putServerPayload(payload);
      if (response.ok) {
        lastSavedSignature = signature;
        window.__BIGBANANA_PROJECT_STORE_SYNC__ = {
          ok: true,
          mode: 'server-authoritative',
          lastSavedAt: Date.now(),
          endpoint: ENDPOINT,
          items: countPayloadItems(payload)
        };
      } else {
        console.warn('[project-store-sync] save failed with status', response.status);
      }
    } catch (error) {
      console.warn('[project-store-sync] save failed', error);
    }
  };

  var schedulePersist = function () {
    if (restoringFromServer || !initialServerLoadComplete) return;
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(persistNow, SAVE_DELAY_MS);
  };

  var syncImageTasksNow = async function () {
    if (imageTaskSyncRunning || restoringFromServer || !initialServerLoadComplete) return;
    imageTaskSyncRunning = true;
    try {
      await persistNow();
    } finally {
      imageTaskSyncRunning = false;
    }
  };

  var startImageTaskSyncLoop = function () {
    if (imageTaskSyncTimer) return;
    syncImageTasksNow();
    imageTaskSyncTimer = window.setInterval(syncImageTasksNow, IMAGE_TASK_SYNC_INTERVAL_MS);
  };

  var bootstrapFromServer = async function () {
    try {
      var response = await fetch(ENDPOINT, { method: 'GET', cache: 'no-store' });
      if (response.ok) {
        var result = await response.json();
        var serverPayload = result && result.payload ? result.payload : null;

        if (serverPayload && countPayloadItems(serverPayload) > 0) {
          var localPayload = await exportPayload();
          var imageTasks = await fetchImageTasks();
          serverPayload = recoverStaleGeneratingState(clearTransientGenerationFailures(serverPayload));
          serverPayload = syncImageTaskState(serverPayload, imageTasks);
          serverPayload = await recoverCompletedImageTasks(serverPayload, imageTasks);
          var serverSignature = contentSignature(serverPayload);
          var localSignature = contentSignature(localPayload);

          lastSavedSignature = serverSignature;
          if (serverSignature !== localSignature) {
            restoringFromServer = true;
            await replaceWithPayload(serverPayload);
            restoringFromServer = false;
            notifyProjectStoreUpdated('server-bootstrap', serverPayload);
          }

          window.__BIGBANANA_PROJECT_STORE_SYNC__ = {
            ok: true,
            mode: 'server-authoritative',
            restoredAt: Date.now(),
            endpoint: ENDPOINT,
            items: countPayloadItems(serverPayload)
          };
          finishReady();
          return;
        }
      } else if (response.status !== 404) {
        console.warn('[project-store-sync] restore failed with status', response.status);
      }

      finishReady();
      persistNow();
    } catch (error) {
      restoringFromServer = false;
      console.warn('[project-store-sync] restore failed', error);
      finishReady();
    }
  };

  var installIndexedDBWriteHook = function () {
    if (!window.IDBObjectStore || !IDBObjectStore.prototype || IDBObjectStore.prototype.__bbProjectStorePatched) return;

    ['put', 'add', 'delete', 'clear'].forEach(function (method) {
      var original = IDBObjectStore.prototype[method];
      IDBObjectStore.prototype[method] = function () {
        var result = original.apply(this, arguments);
        if (STORES.indexOf(this.name) >= 0) schedulePersist();
        return result;
      };
    });

    IDBObjectStore.prototype.__bbProjectStorePatched = true;
  };

  installIndexedDBWriteHook();
  bootstrapFromServer();
  startImageTaskSyncLoop();
  window.addEventListener('beforeunload', function () {
    if (saveTimer) persistNow();
  });
})();
