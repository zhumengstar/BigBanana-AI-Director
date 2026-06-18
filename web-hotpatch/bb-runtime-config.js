(function(){
  var registryKey = "bigbanana_model_registry";
  var legacyGlobalKey = "antsk_api_key";
  var newApiProviderId = "newapi-ai-muling";
  var newApiProviderName = "New API (ai.muling.store)";
  var newApiBaseUrl = "/api/ai-muling";
  var seedanceProviderId = "seedance-newapi";
  var seedanceProviderName = "Seedance NewAPI (8.138.181.181)";
  var seedanceBase = "/api/seedance-proxy";
  var seedanceModel = "doubao-seedance-2-0-260128";

  function cleanKey(v){ return typeof v === "string" && v.trim() ? v.trim() : undefined; }
  function getExistingKey(registry, providerId){
    try {
      var providers = registry && Array.isArray(registry.providers) ? registry.providers : [];
      var p = providers.find(function(x){ return x && x.id === providerId; });
      return cleanKey((p && p.apiKey) || localStorage.getItem(legacyGlobalKey));
    } catch(e) { return undefined; }
  }
  function imageParams(requestFormat, responseFormat){
    return {
      apiFormat: requestFormat === "openai-chat-image" ? "openai-chat" : "openai-image",
      requestFormat: requestFormat,
      responseFormat: responseFormat || requestFormat,
      defaultAspectRatio: "9:16",
      supportedAspectRatios: ["16:9", "9:16", "1:1"],
      outputImageCount: 1,
      resultSelectionMode: "first",
      size: "1024x1024",
      aspectRatioSizeMap: { "16:9": "1024x1024", "9:16": "1024x1024", "1:1": "1024x1024" }
    };
  }
  function modelParams(type){
    if (type === "chat") return { temperature: 0.7, maxTokens: 8192 };
    if (type === "video") return { mode: "async", defaultDuration: 5, supportedDurations: [5, 10, 15], defaultAspectRatio: "9:16", supportedAspectRatios: ["9:16", "16:9"], resolution: "1080p", useReferenceArray: true, maxReferenceImages: 4, videoPromptMode: "auto" };
    if (type === "audio") return { voice: "alloy", defaultVoice: "alloy", outputFormat: "mp3" };
    return {};
  }
  function defaultImageModels(){
    return [
      {
        id: "newapi-gpt-image-2",
        apiModel: "gpt-image-2",
        name: "GPT Image 2",
        type: "image",
        providerId: newApiProviderId,
        endpoint: "/v1/images/generations",
        isBuiltIn: false,
        isEnabled: true,
        params: imageParams("openai-image", "openai-image")
      },
      {
        id: "newapi-gemini-3-1-flash-image",
        apiModel: "gemini-3.1-flash-image",
        name: "Gemini 3.1 Flash Image",
        type: "image",
        providerId: newApiProviderId,
        endpoint: "/v1/chat/completions",
        isBuiltIn: false,
        isEnabled: true,
        params: imageParams("openai-chat-image", "openai-chat-image")
      }
    ];
  }
  function normalizeServerConfig(serverConfig){
    var providers = serverConfig && Array.isArray(serverConfig.providers) ? serverConfig.providers : [];
    var models = serverConfig && Array.isArray(serverConfig.models) ? serverConfig.models : [];
    if (!providers.length || !models.length) return null;
    return {
      providers: providers.map(function(provider){
        return {
          id: provider.id || newApiProviderId,
          name: provider.name || newApiProviderName,
          baseUrl: provider.baseUrl || newApiBaseUrl,
          isBuiltIn: false,
          isDefault: provider.isDefault !== false
        };
      }),
      imageModels: models.filter(function(model){ return model && model.type === "image"; }).map(function(model){
        var params = model.params || {};
        var requestFormat = model.requestFormat || params.requestFormat || (model.apiModel === "gemini-3.1-flash-image" ? "openai-chat-image" : "openai-image");
        var responseFormat = model.responseFormat || params.responseFormat || requestFormat;
        return {
          id: model.id,
          apiModel: model.apiModel || model.model || model.id,
          name: model.name || model.apiModel || model.id,
          type: "image",
          providerId: model.providerId || (providers[0] && providers[0].id) || newApiProviderId,
          endpoint: model.endpoint || (requestFormat === "openai-chat-image" ? "/v1/chat/completions" : "/v1/images/generations"),
          isBuiltIn: false,
          isEnabled: model.isEnabled !== false,
          params: Object.assign(imageParams(requestFormat, responseFormat), params)
        };
      }),
      activeImage: serverConfig.activeModels && serverConfig.activeModels.image
    };
  }
  function customOnlyRegistry(previous, serverConfig){
    previous = previous && typeof previous === "object" ? previous : {};
    var normalized = normalizeServerConfig(serverConfig) || {};
    var providers = (normalized.providers && normalized.providers.length ? normalized.providers : [
      { id: newApiProviderId, name: newApiProviderName, baseUrl: newApiBaseUrl, isBuiltIn: false, isDefault: true }
    ]).concat([
      { id: seedanceProviderId, name: seedanceProviderName, baseUrl: seedanceBase, apiKey: getExistingKey(previous, seedanceProviderId), isBuiltIn: false, isDefault: false }
    ]).map(function(p){
      var q = Object.assign({}, p);
      if (!q.apiKey) delete q.apiKey;
      return q;
    });
    var imageModels = normalized.imageModels && normalized.imageModels.length ? normalized.imageModels : defaultImageModels();
    var models = [
      { id: "newapi-chat-gpt-5-5", apiModel: "gpt-5.5", name: "GPT 5.5", type: "chat", providerId: newApiProviderId, endpoint: "/v1/chat/completions", isBuiltIn: false, isEnabled: true, params: modelParams("chat") }
    ].concat(imageModels, [
      { id: "seedance-newapi-2-0-260128", apiModel: seedanceModel, name: "Seedance 2.0 NewAPI", type: "video", providerId: seedanceProviderId, endpoint: "/v1/videos", isBuiltIn: false, isEnabled: true, params: modelParams("video") },
      { id: "newapi-audio-gpt-audio-1-5", apiModel: "gpt-audio-1.5", name: "GPT Audio 1.5", type: "audio", providerId: newApiProviderId, endpoint: "/v1/chat/completions", isBuiltIn: false, isEnabled: true, params: modelParams("audio") }
    ]);
    return {
      providers: providers,
      models: models,
      activeModels: {
        chat: "newapi-chat-gpt-5-5",
        image: normalized.activeImage || "newapi-gpt-image-2",
        video: "seedance-newapi-2-0-260128",
        audio: "newapi-audio-gpt-audio-1-5"
      }
    };
  }
  var internal = false;
  var serverModelConfig = null;
  function installCustomOnlyRegistry(){
    try {
      localStorage.setItem("bigbanana_creator_service_agreement_accepted_v1", "true");
      localStorage.setItem("bigbanana_onboarding_completed", "true");
      localStorage.setItem("bigbanana_system_announcement_seen_2026-04-gpt-image-2-launch", "true");
      var previous = {};
      try { previous = JSON.parse(localStorage.getItem(registryKey) || "{}"); } catch(e) {}
      var registry = customOnlyRegistry(previous, serverModelConfig);
      internal = true;
      localStorage.setItem(registryKey, JSON.stringify(registry));
      internal = false;
      window.__BIGBANANA_CUSTOM_ONLY_MODELS__ = registry;
      window.BIGBANANA_MODEL_REGISTRY_CONFIG = registry;
    } catch (e) {
      internal = false;
      console.warn("BigBanana custom-only model registry failed", e);
    }
  }
  function refreshServerModelConfig(){
    try {
      fetch("/api/project-store/model-config", { cache: "no-store" })
        .then(function(response){ return response.ok ? response.json() : null; })
        .then(function(result){
          if (!result || !result.ok || !result.config) return;
          serverModelConfig = result.config;
          installCustomOnlyRegistry();
        })
        .catch(function(){});
    } catch(e) {}
  }
  try {
    var nativeSetItem = localStorage.setItem.bind(localStorage);
    localStorage.setItem = function(k, v){
      var result = nativeSetItem(k, v);
      if (!internal && k === registryKey) setTimeout(installCustomOnlyRegistry, 0);
      return result;
    };
  } catch(e) {}
  installCustomOnlyRegistry();
  refreshServerModelConfig();
  setTimeout(installCustomOnlyRegistry, 50);
  setTimeout(refreshServerModelConfig, 500);
  setTimeout(installCustomOnlyRegistry, 1500);
})();
