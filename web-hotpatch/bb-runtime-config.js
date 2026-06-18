(function(){
  var registryKey = "bigbanana_model_registry";
  var endpoint = "/api/project-store/model-config";

  function normalizeRegistry(config){
    config = config && typeof config === "object" ? config : {};
    var providers = Array.isArray(config.providers) ? config.providers : [];
    var models = Array.isArray(config.models) ? config.models : [];
    return {
      providers: providers.filter(function(provider){
        return provider && provider.id && provider.baseUrl;
      }).map(function(provider){
        var output = Object.assign({}, provider, { isBuiltIn: false });
        if (!output.apiKey) delete output.apiKey;
        return output;
      }),
      models: models.filter(function(model){
        return model && model.id && model.type && model.providerId;
      }).map(function(model){
        return Object.assign({}, model, {
          apiModel: model.apiModel || model.id,
          isBuiltIn: false,
          isEnabled: model.isEnabled !== false
        });
      }),
      activeModels: Object.assign({
        chat: "",
        image: "",
        video: "",
        audio: ""
      }, config.activeModels || {})
    };
  }

  function installRegistry(config){
    try {
      var registry = normalizeRegistry(config);
      localStorage.setItem("bigbanana_creator_service_agreement_accepted_v1", "true");
      localStorage.setItem("bigbanana_onboarding_completed", "true");
      localStorage.setItem("bigbanana_system_announcement_seen_2026-04-gpt-image-2-launch", "true");
      localStorage.removeItem("antsk_api_key");
      localStorage.setItem(registryKey, JSON.stringify(registry));
      window.__BIGBANANA_CUSTOM_ONLY_MODELS__ = registry;
      window.BIGBANANA_MODEL_REGISTRY_CONFIG = registry;
    } catch (error) {
      console.warn("BigBanana server model registry install failed", error);
    }
  }

  function refresh(){
    try {
      fetch(endpoint, { cache: "no-store" })
        .then(function(response){ return response.ok ? response.json() : null; })
        .then(function(result){
          if (!result || !result.ok || !result.config) return;
          installRegistry(result.config);
        })
        .catch(function(){});
    } catch(error) {}
  }

  refresh();
  setTimeout(refresh, 500);
})();
