(function(){
  var registryKey = "bigbanana_model_registry";
  var legacyGlobalKey = "antsk_api_key";
  var customProviderId = "custom-ai-muling";
  var customProviderName = "Custom OpenAI Compatible (ai.muling.store)";
  var customBaseUrl = "/api/ai-muling";
  var seedanceProviderId = "seedance-newapi";
  var seedanceProviderName = "Seedance NewAPI (8.138.181.181)";
  var seedanceBase = "/api/seedance-proxy";
  var seedanceModel = "doubao-seedance-2-0-260128";

  function cleanKey(v){ return typeof v === "string" && v.trim() ? v.trim() : undefined; }
  function getExistingKey(registry, providerId){
    try {
      var providers = registry && Array.isArray(registry.providers) ? registry.providers : [];
      var p = providers.find(function(x){ return x && x.id === providerId; });
      return cleanKey((p && p.apiKey) || (registry && registry.globalApiKey) || localStorage.getItem(legacyGlobalKey));
    } catch(e) { return undefined; }
  }
  function modelParams(type){
    if (type === "chat") return { temperature: 0.7, maxTokens: 8192 };
    if (type === "image") return { apiFormat: "openai", defaultAspectRatio: "9:16", supportedAspectRatios: ["16:9", "9:16", "1:1"], size: "1024x1024", aspectRatioSizeMap: { "16:9": "1024x1024", "9:16": "1024x1024", "1:1": "1024x1024" } };
    if (type === "video") return { mode: "async", defaultDuration: 5, supportedDurations: [5, 10, 15], defaultAspectRatio: "9:16", supportedAspectRatios: ["9:16", "16:9"], resolution: "1080p", useReferenceArray: true, maxReferenceImages: 4, videoPromptMode: "auto" };
    if (type === "audio") return { voice: "alloy", defaultVoice: "alloy", outputFormat: "mp3" };
    return {};
  }
  function customOnlyRegistry(previous){
    previous = previous && typeof previous === "object" ? previous : {};
    var aiKey = getExistingKey(previous, customProviderId);
    var seedanceKey = getExistingKey(previous, seedanceProviderId);
    var providers = [
      { id: customProviderId, name: customProviderName, baseUrl: customBaseUrl, apiKey: aiKey, isBuiltIn: false, isDefault: true },
      { id: seedanceProviderId, name: seedanceProviderName, baseUrl: seedanceBase, apiKey: seedanceKey, isBuiltIn: false, isDefault: false }
    ].map(function(p){ var q = Object.assign({}, p); if (!q.apiKey) delete q.apiKey; return q; });
    var models = [
      { id: "custom-chat-gpt-5-5", apiModel: "gpt-5.5", name: "Custom GPT-5.5", type: "chat", providerId: customProviderId, endpoint: "/v1/chat/completions", isBuiltIn: false, isEnabled: true, params: modelParams("chat") },
      { id: "custom-image-gpt-image-2", apiModel: "gpt-image-2", name: "Custom GPT Image 2", type: "image", providerId: customProviderId, endpoint: "/v1/images/generations", isBuiltIn: false, isEnabled: true, params: modelParams("image") },
      { id: "seedance-newapi-2-0-260128", apiModel: seedanceModel, name: "Seedance 2.0 NewAPI", type: "video", providerId: seedanceProviderId, endpoint: "/v1/videos", isBuiltIn: false, isEnabled: true, params: modelParams("video") },
      { id: "custom-audio-gpt-audio-1-5", apiModel: "gpt-audio-1.5", name: "Custom GPT Audio 1.5", type: "audio", providerId: customProviderId, endpoint: "/v1/chat/completions", isBuiltIn: false, isEnabled: true, params: modelParams("audio") }
    ];
    var registry = { providers: providers, models: models, activeModels: { chat: "custom-chat-gpt-5-5", image: "custom-image-gpt-image-2", video: "seedance-newapi-2-0-260128", audio: "custom-audio-gpt-audio-1-5" } };
    if (aiKey) registry.globalApiKey = aiKey;
    return registry;
  }
  var internal = false;
  function installCustomOnlyRegistry(){
    try {
      localStorage.setItem("bigbanana_creator_service_agreement_accepted_v1", "true");
      localStorage.setItem("bigbanana_onboarding_completed", "true");
      localStorage.setItem("bigbanana_system_announcement_seen_2026-04-gpt-image-2-launch", "true");
      var previous = {};
      try { previous = JSON.parse(localStorage.getItem(registryKey) || "{}"); } catch(e) {}
      var registry = customOnlyRegistry(previous);
      internal = true;
      localStorage.setItem(registryKey, JSON.stringify(registry));
      internal = false;
      window.__BIGBANANA_CUSTOM_ONLY_MODELS__ = registry;
    } catch (e) {
      internal = false;
      console.warn("BigBanana custom-only model registry failed", e);
    }
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
  setTimeout(installCustomOnlyRegistry, 50);
  setTimeout(installCustomOnlyRegistry, 500);
  setTimeout(installCustomOnlyRegistry, 1500);
})();
