import { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import './storyboard.css';

import { StoryManifest } from './types';
import { MovieGenerator } from './components/MovieGenerator';
import { MoviePreview } from './components/MoviePreview';
import { CharacterList } from './components/CharacterList';
import { SceneCard } from './components/SceneCard';
import { ConsoleModal } from './components/ConsoleModal';
import { LightboxModal } from './components/LightboxModal';

export default function App() {
  const [story, setStory] = useState<StoryManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Track ongoing asset regeneration per scene: { [sceneNum]: 'image' | 'video' | 'both' | null }
  const [regeneratingMap, setRegeneratingMap] = useState<Record<number, 'image' | 'video' | 'both' | null>>({});

  // Track cache busters for scene media (forces browsers to reload regenerated images/videos)
  const [mediaCacheBuster, setMediaCacheBuster] = useState<Record<number, number>>({});

  // Track which scene is currently being previewed in the image lightbox modal
  const [previewImageSceneNum, setPreviewImageSceneNum] = useState<number | null>(null);

  // Track active timer intervals for scene regeneration
  const timersRef = useRef<Record<number, ReturnType<typeof setInterval>>>({});
  // Track elapsed time (seconds) for each scene's active regeneration
  const [elapsedTimeMap, setElapsedTimeMap] = useState<Record<number, number>>({});

  // Generator & real-time log states
  const [topicInput, setTopicInput] = useState('');
  const [styleInput, setStyleInput] = useState('realistic');
  const [showConsole, setShowConsole] = useState(false);
  const [consoleLogs, setConsoleLogs] = useState<{ type: 'stdout' | 'stderr' | 'status', text: string }[]>([]);
  const [generatorStatus, setGeneratorStatus] = useState<'idle' | 'generating' | 'success' | 'failed'>('idle');
  const consoleLogEndRef = useRef<HTMLDivElement>(null);

  // Client ID for ComfyUI session mapping
  const clientIdRef = useRef<string>('');
  if (!clientIdRef.current) {
    clientIdRef.current = typeof crypto !== 'undefined' && crypto.randomUUID 
      ? crypto.randomUUID() 
      : Math.random().toString(36).substring(2, 15);
  }

  // ComfyUI WebSocket Connection States
  const [comfyStatus, setComfyStatus] = useState<'connecting' | 'connected' | 'disconnected'>('disconnected');
  const [comfyExecutingNode, setComfyExecutingNode] = useState<string | null>(null);
  const [comfyProgress, setComfyProgress] = useState<{ value: number, max: number } | null>(null);
  const [comfyPreviewUrl, setComfyPreviewUrl] = useState<string | null>(null);

  // Track manual movie merging loading state
  const [mergingVideos, setMergingVideos] = useState(false);

  useEffect(() => {
    let socket: Socket | null = null;
    let isMounted = true;

    function connect() {
      if (!isMounted) return;
      
      setComfyStatus('connecting');
      const wsUrl = `http://localhost:3001`;
      console.log(`[ComfyWS] Connecting to backend proxy via Socket.io: ${wsUrl}`);
      
      try {
        socket = io(wsUrl, {
          query: { clientId: clientIdRef.current },
          transports: ["websocket"],
        });
      } catch (err) {
        console.error('[ComfyWS] Socket creation failed:', err);
        setComfyStatus('disconnected');
        return;
      }

      socket.on("connect", () => {
        if (!isMounted) return;
        console.log('[ComfyWS] Connected successfully');
        setComfyStatus('connected');
      });

      socket.on("disconnect", (reason) => {
        if (!isMounted) return;
        console.log('[ComfyWS] Connection closed:', reason);
        setComfyStatus('disconnected');
        setComfyExecutingNode(null);
        setComfyProgress(null);
        setComfyPreviewUrl(null);
      });

      socket.on("connect_error", (error) => {
        if (!isMounted) return;
        console.error('[ComfyWS] Connection error:', error);
        setComfyStatus('disconnected');
      });

      socket.on("message", async (data: string | ArrayBuffer) => {
        if (!isMounted) return;

        // Handle Binary message (Preview Frames)
        if (data instanceof ArrayBuffer) {
          const blob = new Blob([data]);
          const url = URL.createObjectURL(blob);
          setComfyPreviewUrl((prevUrl) => {
            if (prevUrl) URL.revokeObjectURL(prevUrl);
            return url;
          });
          return;
        }

        // Handle Text message (JSON execution progress/status)
        if (typeof data === "string") {
          try {
            const message = JSON.parse(data);
            switch (message.type) {
              case 'executing': {
                const node = message.data.node;
                setComfyExecutingNode(node);
                if (node === null) {
                  setComfyProgress(null);
                  setComfyPreviewUrl(null);
                }
                break;
              }
              case 'progress': {
                const { value, max } = message.data;
                setComfyProgress({ value, max });
                break;
              }
              case 'execution_start': {
                setComfyProgress(null);
                setComfyPreviewUrl(null);
                break;
              }
              default:
                break;
            }
          } catch (e) {
            // Ignore parse errors for non-JSON text messages
          }
        }
      });
    }

    connect();

    return () => {
      isMounted = false;
      if (socket) socket.disconnect();
      setComfyPreviewUrl((prevUrl) => {
        if (prevUrl) URL.revokeObjectURL(prevUrl);
        return null;
      });
    };
  }, []);

  useEffect(() => {
    if (consoleLogEndRef.current) {
      consoleLogEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [consoleLogs]);

  useEffect(() => {
    fetchStory();
  }, []);

  useEffect(() => {
    return () => {
      // Clear any active timers on unmount
      Object.values(timersRef.current).forEach(clearInterval);
    };
  }, []);

  // Poll story updates periodically during active generation so the user sees newly generated assets in real time
  useEffect(() => {
    if (generatorStatus !== 'generating') return;

    // Fetch once immediately to catch early updates
    fetchStory(true);

    const interval = setInterval(() => {
      fetchStory(true);
    }, 4000);

    return () => clearInterval(interval);
  }, [generatorStatus]);

  const fetchStory = async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      setError(null);
      const res = await fetch('http://localhost:3001/api/story');
      if (!res.ok) {
        throw new Error('Failed to connect to backend server. Make sure Bun server is running on port 3001.');
      }
      const data = await res.json();
      setStory(data);
    } catch (err: any) {
      setError(err.message || 'An error occurred while fetching the story.');
    } finally {
      if (!silent) setLoading(false);
    }
  };

  const handleUpdateScript = async (sceneNumber: number, script: string) => {
    try {
      setError(null);
      const res = await fetch('http://localhost:3001/api/scene/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sceneNumber, script }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to update script');
      }
      if (data.success && data.story) {
        setStory(data.story);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to update script.');
      throw err;
    }
  };

  const handleUpdateDescription = async (sceneNumber: number, description: string) => {
    try {
      setError(null);
      const res = await fetch('http://localhost:3001/api/scene/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sceneNumber, description }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to update description');
      }
      if (data.success && data.story) {
        setStory(data.story);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to update description.');
      throw err;
    }
  };

  const handleTriggerFullGeneration = (e: React.FormEvent) => {
    e.preventDefault();
    setConsoleLogs([
      { type: 'status', text: `Initializing generation process for topic: "${topicInput || 'default space description'}" with style: "${styleInput}"...\n` }
    ]);
    setShowConsole(true);
    setGeneratorStatus('generating');

    const params = new URLSearchParams({
      topic: topicInput,
      style: styleInput,
      clientId: clientIdRef.current
    });

    const eventSource = new EventSource(`http://localhost:3001/api/generate/stream?${params.toString()}`);

    eventSource.addEventListener('log', (event) => {
      try {
        const logData = JSON.parse(event.data);
        setConsoleLogs((prev) => [...prev, { type: logData.type, text: logData.text }]);
      } catch (err) {
        setConsoleLogs((prev) => [...prev, { type: 'stdout', text: event.data }]);
      }
    });

    eventSource.addEventListener('complete', (event) => {
      try {
        const data = JSON.parse(event.data);
        setConsoleLogs((prev) => [
          ...prev, 
          { type: 'status', text: `\n[System] Generation process finished with exit code ${data.code}.\n` }
        ]);
        setGeneratorStatus(data.code === 0 ? 'success' : 'failed');
      } catch {
        setConsoleLogs((prev) => [...prev, { type: 'status', text: `\n[System] Generation process finished.\n` }]);
        setGeneratorStatus('success');
      }
      eventSource.close();
      fetchStory(); // Reload story manifest to display newly generated story/scenes!
    });

    eventSource.addEventListener('error', (event) => {
      setConsoleLogs((prev) => [
        ...prev, 
        { type: 'stderr', text: `\n[System Error] Stream connection error occurred. Ensure ComfyUI and the servers are running.\n` }
      ]);
      setGeneratorStatus('failed');
      eventSource.close();
    });
  };

  const handleRegenerate = async (sceneNumber: number, type: 'image' | 'video' | 'both') => {
    try {
      setError(null);
      setRegeneratingMap((prev) => ({ ...prev, [sceneNumber]: type }));
      
      // Initialize elapsed time state and start interval timer
      setElapsedTimeMap((prev) => ({ ...prev, [sceneNumber]: 0 }));
      if (timersRef.current[sceneNumber]) {
        clearInterval(timersRef.current[sceneNumber]);
      }
      timersRef.current[sceneNumber] = setInterval(() => {
        setElapsedTimeMap((prev) => ({
          ...prev,
          [sceneNumber]: (prev[sceneNumber] || 0) + 1
        }));
      }, 1000);

      const res = await fetch('http://localhost:3001/api/scene/regenerate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sceneNumber, type, clientId: clientIdRef.current }),
      });
      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.error || `Failed to regenerate ${type}`);
      }
      
      if (data.success && data.story) {
        setStory(data.story);
        // Force reload of regenerated media via cache buster
        setMediaCacheBuster((prev) => ({ ...prev, [sceneNumber]: Date.now() }));
      }
    } catch (err: any) {
      setError(err.message || `Failed to regenerate asset for Scene ${sceneNumber}.`);
    } finally {
      setRegeneratingMap((prev) => ({ ...prev, [sceneNumber]: null }));
      // Stop and clean up the active timer
      if (timersRef.current[sceneNumber]) {
        clearInterval(timersRef.current[sceneNumber]);
        delete timersRef.current[sceneNumber];
      }
      setElapsedTimeMap((prev) => {
        const copy = { ...prev };
        delete copy[sceneNumber];
        return copy;
      });
    }
  };

  const handleEnhanceText = async (sceneNumber: number, type: 'script' | 'description', currentText: string): Promise<string | undefined> => {
    try {
      setError(null);
      const res = await fetch('http://localhost:3001/api/scene/enhance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sceneNumber, type, text: currentText }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `Failed to enhance ${type}`);
      }
      if (data.success && data.enhancedText) {
        return data.enhancedText;
      }
    } catch (err: any) {
      setError(err.message || `Failed to enhance ${type}.`);
    }
    return undefined;
  };

  const handleSendSceneChat = async (sceneNumber: number, instruction: string): Promise<boolean> => {
    try {
      setError(null);
      const res = await fetch('http://localhost:3001/api/scene/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sceneNumber, instruction }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to apply AI changes');
      }

      if (data.success && data.story) {
        setStory(data.story);
        // Automatically trigger image and video generation sequentially
        handleRegenerate(sceneNumber, 'both');
        return true;
      }
      return false;
    } catch (err: any) {
      setError(err.message || 'Failed to send AI instruction.');
      return false;
    }
  };

  const handleMergeVideos = async () => {
    try {
      setError(null);
      setMergingVideos(true);
      const res = await fetch('http://localhost:3001/api/story/merge', {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to merge videos');
      }
      if (data.success && data.story) {
        setStory(data.story);
        // Force reload of merged video via cache buster
        setMediaCacheBuster((prev) => ({ ...prev, 0: Date.now() }));
      }
    } catch (err: any) {
      setError(err.message || 'Failed to merge videos.');
    } finally {
      setMergingVideos(false);
    }
  };

  const getMediaUrl = (sceneNumber: number, filePath?: string) => {
    if (!filePath) return '';
    const buster = mediaCacheBuster[sceneNumber] || 0;
    const busterParam = buster ? `&cb=${buster}` : '';
    return `http://localhost:3001/api/media?path=${encodeURIComponent(filePath)}${busterParam}`;
  };

  if (loading) {
    return (
      <Theme theme={neutralTheme}>
        <main className="storyboard-main">
          <div className="loading-container">
            <div className="spinner"></div>
            <p style={{ color: '#94a3b8', fontWeight: '600' }}>Loading Storyboard Studio...</p>
          </div>
        </main>
      </Theme>
    );
  }

  return (
    <Theme theme={neutralTheme}>
      <main className="storyboard-main">
        {/* Glow ambient nodes */}
        <div className="glow-bg-1"></div>
        <div className="glow-bg-2"></div>

        <div className="storyboard-container">
          
          {error && (
            <div className="error-banner">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span>{error}</span>
            </div>
          )}

          {/* Movie Generator Panel Component */}
          <MovieGenerator
            comfyStatus={comfyStatus}
            topicInput={topicInput}
            setTopicInput={setTopicInput}
            styleInput={styleInput}
            setStyleInput={setStyleInput}
            handleTriggerFullGeneration={handleTriggerFullGeneration}
            showConsole={showConsole}
            setShowConsole={setShowConsole}
            generatorStatus={generatorStatus}
          />

          {story && (
            <>
              {/* Hero Banner Header */}
              <div className="header-section">
                <div className="title-container">
                  <h1 className="title-text">{story.title}</h1>
                  <p className="subtitle-text">Cinematic Production Storyboard</p>
                </div>

                <div className="badge-row">
                  <div className="badge badge-purple">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                    </svg>
                    <span>Genre: {story.genre}</span>
                  </div>
                  <div className="badge badge-cyan">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" />
                      <path d="M12 6v6l4 2" />
                    </svg>
                    <span>Duration: {story.storyDuration}s</span>
                  </div>
                  <div className="badge badge-amber">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M23 7l-7 5 7 5V7z" />
                      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                    </svg>
                    <span>Style: {story.style}</span>
                  </div>
                </div>

                <div className="premise-box">
                  <p className="premise-text">{story.premise}</p>
                </div>
              </div>

              {/* Main Dashboard Hero Row */}
              <div className="main-dashboard-grid">
                
                {/* Final Merged Video Player */}
                <MoviePreview
                  story={story}
                  mergingVideos={mergingVideos}
                  handleMergeVideos={handleMergeVideos}
                  mediaCacheBuster={mediaCacheBuster}
                  getMediaUrl={getMediaUrl}
                />

                {/* Character List Sidebar */}
                <CharacterList characters={story.characters} />

              </div>

              {/* Storyboard Segment */}
              <div className="section-title-row">
                <h2 className="section-heading">Storyboard Scenes</h2>
                <div style={{ color: '#64748b', fontSize: '0.9rem', fontWeight: '600' }}>
                  {story.scenes.length} total scenes
                </div>
              </div>

              {/* Scenes Cards Grid */}
              <div className="scene-grid">
                {(() => {
                  // Find the scene index that is currently generating during full generation
                  const activeGeneratingSceneNum = (() => {
                    if (generatorStatus !== 'generating' || !story || !story.scenes) return null;
                    const activeScene = story.scenes.find((s) => !s.videoPath);
                    return activeScene ? activeScene.sceneNumber : null;
                  })();

                  return story.scenes.map((scene) => {
                    const isSceneGenerating = activeGeneratingSceneNum === scene.sceneNumber;
                    const generatingType = isSceneGenerating
                      ? (!scene.imagePath ? 'image' : 'video')
                      : null;

                    return (
                      <SceneCard
                        key={scene.sceneNumber}
                        scene={scene}
                        isRegenerating={regeneratingMap[scene.sceneNumber] || null}
                        isGenerating={generatingType}
                        elapsedTime={elapsedTimeMap[scene.sceneNumber] || null}
                        handleUpdateScript={handleUpdateScript}
                        handleUpdateDescription={handleUpdateDescription}
                        handleEnhanceText={handleEnhanceText}
                        handleSendSceneChat={handleSendSceneChat}
                        handleRegenerate={handleRegenerate}
                        getMediaUrl={getMediaUrl}
                        setPreviewImageSceneNum={setPreviewImageSceneNum}
                        setError={setError}
                      />
                    );
                  });
                })()}
              </div>
            </>
          )}

        </div>

        {/* Real-time Generator Console Modal Overlay */}
        <ConsoleModal
          showConsole={showConsole}
          setShowConsole={setShowConsole}
          consoleLogs={consoleLogs}
          generatorStatus={generatorStatus}
          comfyExecutingNode={comfyExecutingNode}
          comfyPreviewUrl={comfyPreviewUrl}
          comfyProgress={comfyProgress}
          consoleLogEndRef={consoleLogEndRef}
        />

        {/* Fullscreen Image Preview Lightbox Modal */}
        <LightboxModal
          previewImageSceneNum={previewImageSceneNum}
          setPreviewImageSceneNum={setPreviewImageSceneNum}
          story={story}
          getMediaUrl={getMediaUrl}
        />
      </main>
    </Theme>
  );
}
