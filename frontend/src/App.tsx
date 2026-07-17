import { useState, useEffect, useRef } from 'react';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import './storyboard.css';

interface Character {
  name: string;
  role: string;
  description: string;
}

interface Scene {
  sceneNumber: number;
  setting: string;
  description: string;
  script: string;
  imagePrompt: string;
  duration?: number;
  imagePath?: string;
  videoPath?: string;
}

interface StoryManifest {
  title: string;
  genre: string;
  premise: string;
  style: string;
  storyDuration: number;
  characters: Character[];
  scenes: Scene[];
  mergedVideoPath?: string;
  outputDir?: string;
}

export default function App() {
  const [story, setStory] = useState<StoryManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Track ongoing asset regeneration per scene: { [sceneNum]: 'image' | 'video' | 'both' | null }
  const [regeneratingMap, setRegeneratingMap] = useState<Record<number, 'image' | 'video' | 'both' | null>>({});
  
  // Script editing states
  const [editingSceneNum, setEditingSceneNum] = useState<number | null>(null);
  const [editedScript, setEditedScript] = useState('');

  // Description editing states
  const [editingDescSceneNum, setEditingDescSceneNum] = useState<number | null>(null);
  const [editedDescription, setEditedDescription] = useState('');

  // Track which scene videos are actively playing in place
  const [playingVideoMap, setPlayingVideoMap] = useState<Record<number, boolean>>({});

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

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let isMounted = true;

    function connect() {
      if (!isMounted) return;
      
      setComfyStatus('connecting');
      const wsUrl = `ws://127.0.0.1:8188/ws?clientId=${clientIdRef.current}`;
      console.log(`[ComfyWS] Connecting to ${wsUrl}`);
      
      try {
        ws = new WebSocket(wsUrl);
        ws.binaryType = "blob";
      } catch (err) {
        console.error('[ComfyWS] Socket creation failed:', err);
        setComfyStatus('disconnected');
        scheduleReconnect();
        return;
      }

      ws.onopen = () => {
        if (!isMounted) return;
        console.log('[ComfyWS] Connected successfully');
        setComfyStatus('connected');
      };

      ws.onclose = (event) => {
        if (!isMounted) return;
        console.log('[ComfyWS] Connection closed:', event.reason);
        setComfyStatus('disconnected');
        setComfyExecutingNode(null);
        setComfyProgress(null);
        setComfyPreviewUrl(null);
        scheduleReconnect();
      };

      ws.onerror = (error) => {
        if (!isMounted) return;
        console.error('[ComfyWS] Error:', error);
      };

      ws.onmessage = async (event) => {
        if (!isMounted) return;

        // Handle Binary message (Preview Frames)
        if (event.data instanceof Blob) {
          const url = URL.createObjectURL(event.data);
          setComfyPreviewUrl((prevUrl) => {
            if (prevUrl) URL.revokeObjectURL(prevUrl);
            return url;
          });
          return;
        }

        // Handle Text message (JSON execution progress/status)
        if (typeof event.data === "string") {
          try {
            const message = JSON.parse(event.data);
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
      };
    }

    function scheduleReconnect() {
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      reconnectTimeout = setTimeout(() => {
        console.log('[ComfyWS] Attempting reconnection...');
        connect();
      }, 5000);
    }

    connect();

    return () => {
      isMounted = false;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (ws) ws.close();
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

  const fetchStory = async () => {
    try {
      setLoading(true);
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
      setLoading(false);
    }
  };

  const handleUpdateScript = async (sceneNumber: number) => {
    try {
      setError(null);
      const res = await fetch('http://localhost:3001/api/scene/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sceneNumber, script: editedScript }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to update script');
      }
      if (data.success && data.story) {
        setStory(data.story);
      }
      setEditingSceneNum(null);
    } catch (err: any) {
      setError(err.message || 'Failed to update script.');
    }
  };

  const handleUpdateDescription = async (sceneNumber: number) => {
    try {
      setError(null);
      const res = await fetch('http://localhost:3001/api/scene/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sceneNumber, description: editedDescription }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to update description');
      }
      if (data.success && data.story) {
        setStory(data.story);
      }
      setEditingDescSceneNum(null);
    } catch (err: any) {
      setError(err.message || 'Failed to update description.');
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
        // If we generated video, reset playing video toggle to make sure it reloads
        if (type === 'video' || type === 'both') {
          setPlayingVideoMap((prev) => ({ ...prev, [sceneNumber]: false }));
        }
      }
    } catch (err: any) {
      setError(err.message || `Failed to regenerate asset for Scene ${sceneNumber}.`);
    } finally {
      setRegeneratingMap((prev) => ({ ...prev, [sceneNumber]: null }));
    }
  };

  const getMediaUrl = (filePath?: string) => {
    if (!filePath) return '';
    return `http://localhost:3001/api/media?path=${encodeURIComponent(filePath)}`;
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

          {/* Movie Generator Panel */}
          <div className="generator-bar">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', flexWrap: 'wrap', gap: '0.5rem' }}>
              <h2 className="card-title" style={{ fontSize: '1.1rem', marginBottom: 0 }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polygon points="6 2 18 2 18 6 6 6 6 2" />
                  <rect x="3" y="6" width="18" height="16" rx="2" />
                  <path d="M10 12l5 3-5 3v-6z" />
                </svg>
                Trigger Full Movie Production
              </h2>
              <div className={`badge ${
                comfyStatus === 'connected' ? 'badge-cyan' : comfyStatus === 'connecting' ? 'badge-amber' : 'badge-purple'
              }`} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '0.25rem 0.6rem', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 'bold' }}>
                <span style={{
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  backgroundColor: comfyStatus === 'connected' ? '#00b8d9' : comfyStatus === 'connecting' ? '#f59e0b' : '#8b66ff',
                  boxShadow: comfyStatus === 'connected' ? '0 0 8px #00b8d9' : comfyStatus === 'connecting' ? '0 0 8px #f59e0b' : '0 0 8px #8b66ff',
                  display: 'inline-block'
                }}></span>
                ComfyUI: {comfyStatus.toUpperCase()}
              </div>
            </div>
            <form onSubmit={handleTriggerFullGeneration} className="generator-form">
              <div className="form-group" style={{ flexGrow: 3 }}>
                <label htmlFor="topic-input">Movie Story Topic / Premise</label>
                <input
                  id="topic-input"
                  type="text"
                  className="input-field"
                  placeholder="e.g. space expedition lost on exoplanet, reactive dangerous flora..."
                  value={topicInput}
                  onChange={(e) => setTopicInput(e.target.value)}
                />
              </div>
              <div className="form-group" style={{ flexGrow: 1, minWidth: '160px' }}>
                <label htmlFor="style-select">Visual Art Style</label>
                <select
                  id="style-select"
                  className="select-field"
                  value={styleInput}
                  onChange={(e) => setStyleInput(e.target.value)}
                >
                  <option value="realistic">Realistic Cinematic</option>
                  <option value="anime">Anime / Manga</option>
                  <option value="cyberpunk">Cyberpunk Neon</option>
                  <option value="watercolor">Watercolor / Fine Art</option>
                  <option value="sketch">Pencil Sketch</option>
                </select>
              </div>
              <button type="submit" className="generate-submit-btn">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
                Produce Movie
              </button>
            </form>
          </div>

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
                <div className="master-video-card">
                  <h2 className="card-title">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" />
                      <line x1="7" y1="2" x2="7" y2="22" />
                      <line x1="17" y1="2" x2="17" y2="22" />
                      <line x1="2" y1="12" x2="22" y2="12" />
                      <line x1="2" y1="7" x2="7" y2="7" />
                      <line x1="2" y1="17" x2="7" y2="17" />
                      <line x1="17" y1="17" x2="22" y2="17" />
                      <line x1="17" y1="7" x2="22" y2="7" />
                    </svg>
                    Compiled Movie Preview
                  </h2>
                  <div className="master-video-container">
                    {story.mergedVideoPath ? (
                      <video 
                        key={story.mergedVideoPath}
                        controls 
                        className="master-video-player"
                        src={getMediaUrl(story.mergedVideoPath)}
                      />
                    ) : (
                      <div className="master-video-fallback">
                        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <path d="M23 7l-7 5 7 5V7z" />
                          <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                        </svg>
                        <span>No compiled movie found. Generate video scenes to compile the movie automatically.</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Character List Sidebar */}
                <div className="characters-card">
                  <h2 className="card-title">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                      <circle cx="9" cy="7" r="4" />
                      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                    </svg>
                    Character Profiles
                  </h2>
                  <div className="character-list">
                    {story.characters.map((char, index) => (
                      <div key={index} className="character-item">
                        <p className="character-name">
                          <span>{char.name}</span>
                          <span className="character-role-badge">{char.role}</span>
                        </p>
                        <p className="character-desc">{char.description}</p>
                      </div>
                    ))}
                  </div>
                </div>

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
                {story.scenes.map((scene) => {
                  const isRegenerating = regeneratingMap[scene.sceneNumber];
                  const isEditing = editingSceneNum === scene.sceneNumber;
                  const isEditingDesc = editingDescSceneNum === scene.sceneNumber;
                  const isVideoPlaying = playingVideoMap[scene.sceneNumber];

                  return (
                    <div key={scene.sceneNumber} className="scene-card">
                      
                      {/* Active Regeneration Loader Overlay */}
                      {isRegenerating && (
                        <div className="card-loader-overlay">
                          <div className="spinner"></div>
                          <span className="card-loader-text">
                            Regenerating {isRegenerating === 'both' ? 'Assets' : isRegenerating}...
                          </span>
                          <span className="card-loader-subtext">This may take up to a minute</span>
                        </div>
                      )}

                      {/* Card Header info */}
                      <div className="scene-card-header">
                        <div className="scene-card-title">
                          <span className="scene-card-badge">Scene {scene.sceneNumber}</span>
                          <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>({scene.duration || 6}s)</span>
                        </div>
                        <p className="scene-setting">{scene.setting}</p>
                      </div>

                      {/* Image/Video Preview container */}
                      <div className="preview-container">
                        {isVideoPlaying && scene.videoPath ? (
                          // In-place Video Player
                          <video
                            src={getMediaUrl(scene.videoPath)}
                            controls
                            autoPlay
                            loop
                            className="preview-video"
                          />
                        ) : scene.imagePath ? (
                          // Image display
                          <img
                            src={getMediaUrl(scene.imagePath)}
                            alt={`Scene ${scene.sceneNumber}`}
                            className="preview-image"
                          />
                        ) : (
                          // Empty/Placeholder
                          <div className="master-video-fallback">
                            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                              <circle cx="8.5" cy="8.5" r="1.5" />
                              <polyline points="21 15 16 10 5 21" />
                            </svg>
                            <span style={{ fontSize: '0.8rem' }}>No image generated yet</span>
                          </div>
                        )}

                        {/* Play Video overlay overlayed on image */}
                        {!isVideoPlaying && scene.videoPath && (
                          <button
                            type="button"
                            className="video-overlay-btn"
                            onClick={() => setPlayingVideoMap((prev) => ({ ...prev, [scene.sceneNumber]: true }))}
                            title="Play Video Scene"
                          >
                            <div className="play-icon-bg">
                              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                                <polygon points="5 3 19 12 5 21 5 3" />
                              </svg>
                            </div>
                          </button>
                        )}

                        {/* Back to image button shown while playing video */}
                        {isVideoPlaying && (
                          <div className="media-action-panel">
                            <button
                              type="button"
                              className="media-action-btn"
                              onClick={() => setPlayingVideoMap((prev) => ({ ...prev, [scene.sceneNumber]: false }))}
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                                <circle cx="8.5" cy="8.5" r="1.5" />
                                <polyline points="21 15 16 10 5 21" />
                              </svg>
                              View Image
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Visual Description & edit options */}
                      <div className="script-box">
                        <div className="script-label-row">
                          <span className="script-label">Visual Action Description</span>
                          {!isEditingDesc && (
                            <button
                              type="button"
                              className="edit-script-btn"
                              onClick={() => {
                                setEditingDescSceneNum(scene.sceneNumber);
                                setEditedDescription(scene.description);
                              }}
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                <path d="M12 20h9" />
                                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                              </svg>
                              Edit Action
                            </button>
                          )}
                        </div>

                        {isEditingDesc ? (
                          <>
                            <textarea
                              className="script-textarea"
                              value={editedDescription}
                              onChange={(e) => setEditedDescription(e.target.value)}
                            />
                            <div className="edit-actions-row">
                              <button
                                type="button"
                                className="cancel-btn"
                                onClick={() => setEditingDescSceneNum(null)}
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                className="save-btn"
                                onClick={() => handleUpdateDescription(scene.sceneNumber)}
                              >
                                Save Action
                              </button>
                            </div>
                          </>
                        ) : (
                          <p className="script-text">
                            {scene.description || <span style={{ color: '#475569', fontStyle: 'italic' }}>No action description defined.</span>}
                          </p>
                        )}
                      </div>

                      {/* Script text & edit options */}
                      <div className="script-box">
                        <div className="script-label-row">
                          <span className="script-label">Dialogue &amp; Narration</span>
                          {!isEditing && (
                            <button
                              type="button"
                              className="edit-script-btn"
                              onClick={() => {
                                setEditingSceneNum(scene.sceneNumber);
                                setEditedScript(scene.script);
                              }}
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                <path d="M12 20h9" />
                                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                              </svg>
                              Edit Script
                            </button>
                          )}
                        </div>

                        {isEditing ? (
                          <>
                            <textarea
                              className="script-textarea"
                              value={editedScript}
                              onChange={(e) => setEditedScript(e.target.value)}
                            />
                            <div className="edit-actions-row">
                              <button
                                type="button"
                                className="cancel-btn"
                                onClick={() => setEditingSceneNum(null)}
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                className="save-btn"
                                onClick={() => handleUpdateScript(scene.sceneNumber)}
                              >
                                Save Script
                              </button>
                            </div>
                          </>
                        ) : (
                          <p className="script-text">
                            {scene.script || <span style={{ color: '#475569', fontStyle: 'italic' }}>No dialog / narration script defined.</span>}
                          </p>
                        )}
                      </div>

                      {/* Actions grid */}
                      <div className="card-action-footer">
                        <button
                          type="button"
                          disabled={!!isRegenerating}
                          className={`regenerate-btn image-regen-btn ${isRegenerating ? 'btn-loading' : ''}`}
                          onClick={() => handleRegenerate(scene.sceneNumber, 'image')}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                          </svg>
                          Regen Image
                        </button>
                        <button
                          type="button"
                          disabled={!!isRegenerating || !scene.imagePath}
                          className={`regenerate-btn video-regen-btn ${(isRegenerating || !scene.imagePath) ? 'btn-loading' : ''}`}
                          onClick={() => handleRegenerate(scene.sceneNumber, 'video')}
                          title={!scene.imagePath ? 'Generate the image first' : 'Regenerate video for this scene'}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <path d="M23 7l-7 5 7 5V7z" />
                            <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                          </svg>
                          Regen Video
                        </button>
                      </div>

                    </div>
                  );
                })}
              </div>
            </>
          )}

        </div>

        {/* Real-time Generator Console Modal Overlay */}
        {showConsole && (
          <div className="console-overlay">
            <div className="console-box">
              <div className="console-header">
                <h3 className="console-title">
                  <span className="spinner" style={{ width: '16px', height: '16px', borderWidth: '2px', animationDuration: '0.8s', marginRight: '6px' }}></span>
                  Production Pipeline Terminal Logs
                </h3>
                <button 
                  type="button" 
                  className="console-close-btn"
                  onClick={() => setShowConsole(false)}
                  disabled={generatorStatus === 'generating'}
                >
                  {generatorStatus === 'generating' ? 'Processing...' : 'Close Terminal'}
                </button>
              </div>
              <div className="console-main-container" style={{ display: 'flex', flexGrow: 1, overflow: 'hidden' }}>
                <div className="console-body" style={{ flexGrow: 2, flexShrink: 1, flexBasis: '60%', margin: 0, border: 'none', borderRadius: 0 }}>
                  {consoleLogs.map((log, index) => (
                    <span key={index} className={`log-${log.type}`}>
                      {log.text}
                    </span>
                  ))}
                  <div ref={consoleLogEndRef} />
                </div>
                
                {/* ComfyUI Live Monitoring Column */}
                <div className="comfy-monitor-panel" style={{
                  flexGrow: 1,
                  flexShrink: 0,
                  flexBasis: '35%',
                  borderLeft: '1px solid rgba(255, 255, 255, 0.08)',
                  backgroundColor: '#06070a',
                  padding: '1.25rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '1rem',
                  overflowY: 'auto',
                  boxSizing: 'border-box'
                }}>
                  <h4 style={{ margin: 0, color: '#a78bfa', fontSize: '0.9rem', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    ComfyUI Monitor
                  </h4>
                  
                  {comfyExecutingNode || comfyPreviewUrl || comfyProgress ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', height: '100%' }}>
                      
                      {/* Active Node Info */}
                      <div style={{ backgroundColor: 'rgba(255,255,255,0.02)', padding: '0.75rem', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.04)' }}>
                        <span style={{ fontSize: '0.7rem', color: '#64748b', textTransform: 'uppercase', display: 'block', marginBottom: '2px' }}>
                          Executing Node
                        </span>
                        <span style={{ fontSize: '0.85rem', color: '#f8fafc', fontWeight: '600' }}>
                          Node ID: {comfyExecutingNode || 'Finishing / Staging...'}
                        </span>
                      </div>

                      {/* Progress bar */}
                      {comfyProgress && (
                        <div style={{ backgroundColor: 'rgba(255,255,255,0.02)', padding: '0.75rem', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.04)' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: '#64748b', textTransform: 'uppercase', marginBottom: '4px' }}>
                            <span>Sampling Progress</span>
                            <span>{Math.round((comfyProgress.value / comfyProgress.max) * 100)}%</span>
                          </div>
                          <div style={{ width: '100%', height: '6px', backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: '3px', overflow: 'hidden' }}>
                            <div style={{
                              width: `${(comfyProgress.value / comfyProgress.max) * 100}%`,
                              height: '100%',
                              background: 'linear-gradient(90deg, #00b8d9, #8b66ff)',
                              borderRadius: '3px',
                              transition: 'width 0.1s ease'
                            }}></div>
                          </div>
                          <span style={{ fontSize: '0.75rem', color: '#94a3b8', display: 'block', marginTop: '4px' }}>
                            Step {comfyProgress.value} of {comfyProgress.max}
                          </span>
                        </div>
                      )}

                      {/* Live Image/Video Preview */}
                      <div style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', minHeight: '180px' }}>
                        <span style={{ fontSize: '0.7rem', color: '#64748b', textTransform: 'uppercase', display: 'block', marginBottom: '4px' }}>
                          Live Preview Frame
                        </span>
                        <div style={{
                          flexGrow: 1,
                          backgroundColor: '#000000',
                          borderRadius: '8px',
                          border: '1px solid rgba(255,255,255,0.08)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          overflow: 'hidden',
                          position: 'relative'
                        }}>
                          {comfyPreviewUrl ? (
                            <img
                              src={comfyPreviewUrl}
                              alt="ComfyUI Live Preview"
                              style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                            />
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', color: '#475569' }}>
                              <div className="spinner" style={{ width: '20px', height: '20px', borderWidth: '2px' }}></div>
                              <span style={{ fontSize: '0.75rem' }}>Waiting for preview frame...</span>
                            </div>
                          )}
                        </div>
                      </div>

                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flexGrow: 1, color: '#475569', gap: '0.5rem', textAlign: 'center' }}>
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="16" x2="12" y2="12" />
                        <line x1="12" y1="8" x2="12.01" y2="8" />
                      </svg>
                      <span style={{ fontSize: '0.8rem', fontWeight: '500' }}>Idle / Waiting for ComfyUI...</span>
                    </div>
                  )}
                </div>
              </div>
              <div className="console-footer">
                <span className="console-status">
                  Status: <strong style={{ color: generatorStatus === 'success' ? '#10b981' : generatorStatus === 'failed' ? '#ef4444' : '#a855f7', marginLeft: '4px' }}>
                    {generatorStatus.toUpperCase()}
                  </strong>
                </span>
                {generatorStatus !== 'generating' && (
                  <button 
                    type="button" 
                    className="save-btn" 
                    style={{ backgroundColor: generatorStatus === 'success' ? '#10b981' : '#64748b' }}
                    onClick={() => setShowConsole(false)}
                  >
                    Done
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </main>
    </Theme>
  );
}
