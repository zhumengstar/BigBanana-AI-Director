import React, { useState, useEffect, useRef } from 'react';
import { Routes, Route, useNavigate, useParams } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import StageScript from './components/StageScript';
import StageAssets from './components/StageAssets';
import StageDirector from './components/StageDirector';
import StageExport from './components/StageExport';
import StagePrompts from './components/StagePrompts';
import Dashboard from './components/Dashboard';
import ProjectOverview from './components/ProjectOverview';
import CharacterLibraryPage from './components/CharacterLibrary';
import Onboarding, { shouldShowOnboarding, resetOnboarding } from './components/Onboarding';
import ModelConfigModal from './components/ModelConfig';
import { ProjectState } from './types';
import { AlertCircle, Save, CheckCircle } from 'lucide-react';
import { saveEpisode, loadEpisode } from './services/storageService';
import { setLogCallback, clearLogCallback } from './services/renderLogService';
import { useAlert } from './components/GlobalAlert';
import { ProjectProvider, useProjectContext } from './contexts/ProjectContext';
import { checkCharacterSync, checkSceneSync, checkPropSync } from './services/characterSyncService';
import AssetSyncBanner from './components/CharacterLibrary/AssetSyncBanner';
import { fetchServerModelConfiguration } from './services/modelRegistry';
import logoImg from './logo.png';

const preserveInFlightGenerationStates = (episode: ProjectState): ProjectState => ({
  ...episode,
  isParsingScript: false,
  scriptGenerationCheckpoint: null,
});

const episodeSaveSignature = (episode: ProjectState | null): string => {
  if (!episode) return '';
  try {
    return JSON.stringify(episode, (key, value) => {
      if (
        key === 'serverPersistedAt' ||
        key === 'lastModified' ||
        key === 'updatedAt' ||
        key === 'imageTasksSyncedAt' ||
        key === 'imageTasksTerminalSyncedCount' ||
        key === 'imageTasksStaleClearedCount' ||
        key === 'imageTasksRecoveredAt' ||
        key === 'imageTasksRecoveredCount'
      ) {
        return undefined;
      }
      return value;
    });
  } catch (error) {
    return `${episode.id}:${episode.stage}:${episode.updatedAt || ''}`;
  }
};

type SaveStatus = 'saved' | 'saving' | 'unsaved' | 'error';

function MobileWarning() {
  return (
    <div className="h-screen bg-[var(--bg-base)] flex items-center justify-center p-6">
      <div className="max-w-md text-center space-y-6">
        <img src={logoImg} alt="Logo" className="w-20 h-20 mx-auto mb-4" />
        <h1 className="text-2xl font-bold text-[var(--text-primary)] mb-2">BigBanana AI Director</h1>
        <div className="bg-[var(--bg-primary)] border border-[var(--border-primary)] rounded-xl p-8">
          <p className="text-[var(--text-tertiary)] text-base leading-relaxed mb-4">为了获得最佳体验，请使用 PC 端浏览器访问。</p>
          <p className="text-[var(--text-muted)] text-sm">本应用需要较大的屏幕空间和桌面级浏览器环境才能正常运行。</p>
        </div>
      </div>
    </div>
  );
}

function EpisodeWorkspace() {
  const { episodeId } = useParams<{ episodeId: string }>();
  const navigate = useNavigate();
  const { showAlert } = useAlert();
  const {
    project,
    currentEpisode,
    setCurrentEpisode,
    updateProject: updateSeriesProject,
    updateEpisode,
    syncAllCharactersToEpisode,
    syncAllScenesToEpisode,
    syncAllPropsToEpisode,
  } = useProjectContext();
  const [isGenerating, setIsGenerating] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [showSaveStatus, setShowSaveStatus] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showModelConfig, setShowModelConfig] = useState(false);
  const saveTimeoutRef = useRef<any>(null);
  const hideStatusTimeoutRef = useRef<any>(null);
  const suppressNextAutoSaveRef = useRef(false);
  const lastSavedSignatureRef = useRef('');
  const saveStatusRef = useRef(saveStatus);

  useEffect(() => {
    saveStatusRef.current = saveStatus;
  }, [saveStatus]);

  useEffect(() => {
    if (!episodeId) return;
    loadEpisode(episodeId).then(ep => {
      suppressNextAutoSaveRef.current = true;
      lastSavedSignatureRef.current = episodeSaveSignature(ep);
      setCurrentEpisode(ep);
    }).catch(() => navigate('/'));
    return () => {
      suppressNextAutoSaveRef.current = true;
      lastSavedSignatureRef.current = '';
      setCurrentEpisode(null);
    };
  }, [episodeId]);

  useEffect(() => {
    if (!episodeId) return;
    let reloadTimer: number | null = null;
    const reloadCurrentEpisode = () => {
      if (reloadTimer) window.clearTimeout(reloadTimer);
      reloadTimer = window.setTimeout(() => {
        if (saveStatusRef.current !== 'saved' || saveTimeoutRef.current) {
          return;
        }
        loadEpisode(episodeId)
          .then(ep => {
            const nextSignature = episodeSaveSignature(ep);
            if (nextSignature === lastSavedSignatureRef.current) return;
            suppressNextAutoSaveRef.current = true;
            lastSavedSignatureRef.current = nextSignature;
            setCurrentEpisode(ep);
          })
          .catch(error => console.warn('Reload episode after server task sync failed.', error));
      }, 100);
    };

    window.addEventListener('bigbanana:project-store-updated', reloadCurrentEpisode as EventListener);
    return () => {
      if (reloadTimer) window.clearTimeout(reloadTimer);
      window.removeEventListener('bigbanana:project-store-updated', reloadCurrentEpisode as EventListener);
    };
  }, [episodeId]);

  useEffect(() => {
    if (currentEpisode) {
      setLogCallback((log) => {
        updateEpisode(prev => ({
          ...prev,
          renderLogs: [...(prev.renderLogs || []), log]
        }));
      });
    } else {
      clearLogCallback();
    }
    return () => clearLogCallback();
  }, [currentEpisode?.id]);

  useEffect(() => {
    if (!currentEpisode) return;
    const signature = episodeSaveSignature(currentEpisode);
    if (suppressNextAutoSaveRef.current) {
      suppressNextAutoSaveRef.current = false;
      lastSavedSignatureRef.current = signature;
      return;
    }
    if (signature === lastSavedSignatureRef.current) return;

    setSaveStatus('unsaved');
    setShowSaveStatus(true);
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(async () => {
      saveTimeoutRef.current = null;
      setSaveStatus('saving');
      try {
        await saveEpisode(currentEpisode);
        lastSavedSignatureRef.current = signature;
        setSaveStatus('saved');
      } catch (e) {
        console.error("Auto-save failed", e);
        setSaveStatus('error');
        setShowSaveStatus(true);
      }
    }, 1000);
    return () => { if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current); };
  }, [currentEpisode]);

  useEffect(() => {
    if (saveStatus === 'saved') {
      if (hideStatusTimeoutRef.current) clearTimeout(hideStatusTimeoutRef.current);
      hideStatusTimeoutRef.current = setTimeout(() => setShowSaveStatus(false), 2000);
    } else if (saveStatus === 'saving' || saveStatus === 'unsaved') {
      setShowSaveStatus(true);
      if (hideStatusTimeoutRef.current) clearTimeout(hideStatusTimeoutRef.current);
    } else if (saveStatus === 'error') {
      setShowSaveStatus(true);
      if (hideStatusTimeoutRef.current) clearTimeout(hideStatusTimeoutRef.current);
      hideStatusTimeoutRef.current = setTimeout(() => setShowSaveStatus(false), 5000);
    }
    return () => { if (hideStatusTimeoutRef.current) clearTimeout(hideStatusTimeoutRef.current); };
  }, [saveStatus]);

  useEffect(() => {
    if (!project || !currentEpisode) return;
    if (currentEpisode.episodeNumber !== 1) return;

    const projectTitle = (project.title || '').trim();
    const isProjectPlaceholder =
      !projectTitle ||
      projectTitle === '未命名项目' ||
      /^新建项目\s\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}$/.test(projectTitle);

    if (!isProjectPlaceholder) return;

    const candidateTitle = (currentEpisode.scriptData?.title || currentEpisode.title || '').trim();
    if (!candidateTitle) return;
    if (/^第\s*\d+\s*集$/u.test(candidateTitle)) return;
    if (candidateTitle === projectTitle) return;

    updateSeriesProject({ title: candidateTitle });
  }, [project, currentEpisode, updateSeriesProject]);

  const handleUpdateProject = (updates: Partial<ProjectState> | ((prev: ProjectState) => ProjectState)) => {
    updateEpisode(updates);
  };

  const setStage = (stage: 'script' | 'assets' | 'director' | 'export' | 'prompts') => {
    if (isGenerating) {
      showAlert('当前正在执行生成任务，切换页面后后台任务会继续运行。\n\n确定要离开当前页面吗？', {
        title: '生成任务进行中', type: 'warning', showCancel: true, confirmText: '确定离开', cancelText: '继续等待',
        onConfirm: () => {
          setIsGenerating(false);
          updateEpisode(prev => ({ ...preserveInFlightGenerationStates(prev), stage }));
        }
      });
      return;
    }
    handleUpdateProject({ stage });
  };

  const handleExit = async () => {
    if (isGenerating) {
      showAlert('当前正在执行生成任务，退出后后台任务会继续运行。\n\n确定要退出吗？', {
        title: '生成任务进行中', type: 'warning', showCancel: true, confirmText: '确定退出', cancelText: '继续等待',
        onConfirm: async () => {
          setIsGenerating(false);
          if (currentEpisode) {
            await saveEpisode(preserveInFlightGenerationStates(currentEpisode));
          }
          navigate(`/project/${currentEpisode?.projectId || ''}`);
        }
      });
      return;
    }
    if (currentEpisode) await saveEpisode(currentEpisode);
    navigate(`/project/${currentEpisode?.projectId || ''}`);
  };

  if (!currentEpisode) {
    return <div className="h-screen flex items-center justify-center text-[var(--text-muted)]">加载中...</div>;
  }

  const renderStage = () => {
    switch (currentEpisode.stage) {
      case 'script':
        return <StageScript project={currentEpisode} updateProject={handleUpdateProject} onShowModelConfig={() => setShowModelConfig(true)} onGeneratingChange={setIsGenerating} />;
      case 'assets':
        return <StageAssets project={currentEpisode} updateProject={handleUpdateProject} onGeneratingChange={setIsGenerating} />;
      case 'director':
        return <StageDirector project={currentEpisode} updateProject={handleUpdateProject} onGeneratingChange={setIsGenerating} />;
      case 'export':
        return <StageExport project={currentEpisode} />;
      case 'prompts':
        return <StagePrompts project={currentEpisode} updateProject={handleUpdateProject} />;
      default:
        return <div className="text-[var(--text-primary)]">未知阶段</div>;
    }
  };

  const displayEpisodeTitle =
    project &&
    currentEpisode.episodeNumber === 1 &&
    currentEpisode.title?.trim() === project.title?.trim()
      ? `第 ${currentEpisode.episodeNumber} 集`
      : currentEpisode.title;
  const episodeLabel = project ? `${project.title} / ${displayEpisodeTitle}` : displayEpisodeTitle;

  return (
    <div className="flex h-screen bg-[var(--bg-secondary)] font-sans text-[var(--text-secondary)] selection:bg-[var(--accent-bg)]">
      <Sidebar
        currentStage={currentEpisode.stage}
        setStage={setStage}
        onExit={handleExit}
        projectName={episodeLabel}
        onShowOnboarding={() => { resetOnboarding(); setShowOnboarding(true); }}
        onShowModelConfig={() => setShowModelConfig(true)}
        isNavigationLocked={isGenerating}
        episodeInfo={project ? { projectId: project.id, projectTitle: project.title, episodeTitle: displayEpisodeTitle } : undefined}
        onGoToProject={project ? () => navigate(`/project/${project.id}`) : undefined}
      />
      <main className="ml-72 flex-1 h-screen overflow-hidden relative">
        {project && currentEpisode && (() => {
          const { outdatedRefs: outdatedCharacters } = checkCharacterSync(currentEpisode, project);
          const { outdatedRefs: outdatedScenes } = checkSceneSync(currentEpisode, project);
          const { outdatedRefs: outdatedProps } = checkPropSync(currentEpisode, project);

          return (
            <>
              <AssetSyncBanner
                title="Characters"
                outdatedRefs={outdatedCharacters.map(ref => ({ assetId: ref.characterId, syncedVersion: ref.syncedVersion }))}
                resolveName={(assetId) => project.characterLibrary.find(ch => ch.id === assetId)?.name || assetId}
                onSyncAll={syncAllCharactersToEpisode}
              />
              <AssetSyncBanner
                title="Scenes"
                outdatedRefs={outdatedScenes.map(ref => ({ assetId: ref.sceneId, syncedVersion: ref.syncedVersion }))}
                resolveName={(assetId) => project.sceneLibrary.find(sc => sc.id === assetId)?.location || assetId}
                onSyncAll={syncAllScenesToEpisode}
              />
              <AssetSyncBanner
                title="Props"
                outdatedRefs={outdatedProps.map(ref => ({ assetId: ref.propId, syncedVersion: ref.syncedVersion }))}
                resolveName={(assetId) => project.propLibrary.find(pr => pr.id === assetId)?.name || assetId}
                onSyncAll={syncAllPropsToEpisode}
              />
            </>
          );
        })()}
        {renderStage()}
        {showSaveStatus && (
          <div className="absolute top-4 right-6 pointer-events-none flex items-center gap-2 text-xs font-mono text-[var(--text-tertiary)] bg-[var(--overlay-medium)] px-2 py-1 rounded-full backdrop-blur-sm z-50">
            {saveStatus === 'saving' ? (
              <><Save className="w-3 h-3 animate-pulse" />保存中...</>
            ) : saveStatus === 'unsaved' ? (
              <><Save className="w-3 h-3 opacity-70" />待保存...</>
            ) : saveStatus === 'error' ? (
              <><AlertCircle className="w-3 h-3 text-[var(--danger)]" />保存失败</>
            ) : (
              <><CheckCircle className="w-3 h-3 text-[var(--success)]" />已保存</>
            )}
          </div>
        )}
      </main>
      {showOnboarding && <Onboarding onComplete={() => setShowOnboarding(false)} onQuickStart={() => setShowOnboarding(false)} currentApiKey="" onSaveApiKey={() => {}} />}
      <ModelConfigModal isOpen={showModelConfig} onClose={() => setShowModelConfig(false)} />
    </div>
  );
}

function AppRoutes() {
  const navigate = useNavigate();
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showModelConfig, setShowModelConfig] = useState(false);

  useEffect(() => {
    fetchServerModelConfiguration().catch(() => {});
    if (shouldShowOnboarding()) setShowOnboarding(true);
  }, []);

  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      if (event.error?.message?.includes('API Key missing') || event.error?.message?.includes('AntSK API Key')) {
        setShowModelConfig(true); event.preventDefault();
      }
    };
    const handleRejection = (event: PromiseRejectionEvent) => {
      if (event.reason?.message?.includes('API Key missing') || event.reason?.message?.includes('AntSK API Key')) {
        setShowModelConfig(true); event.preventDefault();
      }
    };
    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleRejection);
    return () => { window.removeEventListener('error', handleError); window.removeEventListener('unhandledrejection', handleRejection); };
  }, []);

  return (
    <>
      <Routes>
        <Route path="/" element={
          <Dashboard
            onOpenProject={(proj) => {
              if (proj.projectId) navigate(`/project/${proj.projectId}`);
              else navigate(`/project/${proj.id}/episode/${proj.id}`);
            }}
            onShowOnboarding={() => { resetOnboarding(); setShowOnboarding(true); }}
            onShowModelConfig={() => setShowModelConfig(true)}
          />
        } />
        <Route path="/project/:projectId" element={
          <ProjectProvider>
            <ProjectOverview />
          </ProjectProvider>
        } />
        <Route path="/project/:projectId/characters" element={
          <ProjectProvider>
            <CharacterLibraryPage />
          </ProjectProvider>
        } />
        <Route path="/project/:projectId/episode/:episodeId" element={
          <ProjectProvider>
            <EpisodeWorkspace />
          </ProjectProvider>
        } />
      </Routes>
      {showOnboarding && <Onboarding onComplete={() => setShowOnboarding(false)} onQuickStart={() => setShowOnboarding(false)} currentApiKey="" onSaveApiKey={() => {}} />}
      <ModelConfigModal isOpen={showModelConfig} onClose={() => setShowModelConfig(false)} />
    </>
  );
}

function App() {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const check = () => setIsMobile(/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth < 1024);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  if (isMobile) return <MobileWarning />;
  return <AppRoutes />;
}

export default App;
