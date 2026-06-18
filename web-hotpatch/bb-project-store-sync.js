(function () {
  var DB_NAME = 'BigBananaDB';
  var DB_VERSION = 3;
  var STORES = ['projects', 'assetLibrary', 'seriesProjects', 'series', 'episodes'];
  var ENDPOINT = '/api/project-store/backup';
  var MEDIA_ENDPOINT = '/api/project-store/media';
  var MEDIA_URL_PREFIX = '/api/project-store/media/';
  var SAVE_DELAY_MS = 1200;

  var saveTimer = null;
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
          json = JSON.stringify(item);
        } catch (error) {
          json = String(item && item.id ? item.id : '');
        }

        return {
          id: item && item.id ? String(item.id) : '',
          updatedAt: item ? (item.updatedAt || item.lastModified || item.createdAt || 0) : 0,
          size: json.length
        };
      }).sort(function (a, b) {
        return a.id.localeCompare(b.id);
      });
    });

    return JSON.stringify(summary);
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
      payload = clearTransientGenerationFailures(payload);
      payload = recoverStaleGeneratingState(payload);
      payload = await materializePayloadMedia(payload);

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

  var bootstrapFromServer = async function () {
    try {
      var response = await fetch(ENDPOINT, { method: 'GET', cache: 'no-store' });
      if (response.ok) {
        var result = await response.json();
        var serverPayload = result && result.payload ? result.payload : null;

        if (serverPayload && countPayloadItems(serverPayload) > 0) {
          var localPayload = await exportPayload();
          serverPayload = recoverStaleGeneratingState(clearTransientGenerationFailures(serverPayload));
          var serverSignature = contentSignature(serverPayload);
          var localSignature = contentSignature(localPayload);

          lastSavedSignature = serverSignature;
          if (serverSignature !== localSignature) {
            restoringFromServer = true;
            await replaceWithPayload(serverPayload);
            restoringFromServer = false;
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
  window.addEventListener('beforeunload', function () {
    if (saveTimer) persistNow();
  });
})();
