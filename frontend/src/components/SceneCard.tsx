import React, { useState, useEffect } from 'react';
import { Scene } from '../types';

interface SceneCardProps {
  scene: Scene;
  isRegenerating: 'image' | 'video' | 'both' | null;
  isGenerating?: 'image' | 'video' | 'both' | null;
  elapsedTime: number | null;
  handleUpdateScript: (sceneNumber: number, script: string) => Promise<void>;
  handleUpdateDescription: (sceneNumber: number, description: string) => Promise<void>;
  handleEnhanceText: (sceneNumber: number, type: 'script' | 'description', currentText: string) => Promise<string | undefined>;
  handleSendSceneChat: (sceneNumber: number, instruction: string) => Promise<boolean>;
  handleRegenerate: (sceneNumber: number, type: 'image' | 'video' | 'both') => Promise<void>;
  getMediaUrl: (sceneNumber: number, filePath?: string) => string;
  setPreviewImageSceneNum: (sceneNumber: number | null) => void;
  setError: (err: string | null) => void;
}

export const SceneCard: React.FC<SceneCardProps> = ({
  scene,
  isRegenerating,
  isGenerating = null,
  elapsedTime,
  handleUpdateScript,
  handleUpdateDescription,
  handleEnhanceText,
  handleSendSceneChat,
  handleRegenerate,
  getMediaUrl,
  setPreviewImageSceneNum,
  setError
}) => {
  // Localized states
  const [isEditingScript, setIsEditingScript] = useState(false);
  const [localScript, setLocalScript] = useState(scene.script);

  const [isEditingDesc, setIsEditingDesc] = useState(false);
  const [localDesc, setLocalDesc] = useState(scene.description);

  const [enhancingScript, setEnhancingScript] = useState(false);
  const [enhancingDesc, setEnhancingDesc] = useState(false);

  const [chatInput, setChatInput] = useState('');
  const [sendingChat, setSendingChat] = useState(false);
  const [chatSuccess, setChatSuccess] = useState(false);

  const [isVideoPlaying, setIsVideoPlaying] = useState(false);

  // Sync local script and desc if parent scene object changes
  useEffect(() => {
    setLocalScript(scene.script);
  }, [scene.script]);

  useEffect(() => {
    setLocalDesc(scene.description);
  }, [scene.description]);

  // Handler for Ollama script enhancement
  const triggerEnhanceScript = async () => {
    setEnhancingScript(true);
    const enhanced = await handleEnhanceText(scene.sceneNumber, 'script', localScript);
    if (enhanced !== undefined) {
      setLocalScript(enhanced);
    }
    setEnhancingScript(false);
  };

  // Handler for Ollama action description enhancement
  const triggerEnhanceDesc = async () => {
    setEnhancingDesc(true);
    const enhanced = await handleEnhanceText(scene.sceneNumber, 'description', localDesc);
    if (enhanced !== undefined) {
      setLocalDesc(enhanced);
    }
    setEnhancingDesc(false);
  };

  // Save changes wrapper
  const saveScriptChanges = async () => {
    try {
      await handleUpdateScript(scene.sceneNumber, localScript);
      setIsEditingScript(false);
    } catch {
      // Error handled inside callback
    }
  };

  const saveDescChanges = async () => {
    try {
      await handleUpdateDescription(scene.sceneNumber, localDesc);
      setIsEditingDesc(false);
    } catch {
      // Error handled inside callback
    }
  };

  // Save & Regenerate combinations
  const saveDescAndRegenImage = async () => {
    try {
      setError(null);
      const res = await fetch('http://localhost:3001/api/scene/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sceneNumber: scene.sceneNumber, description: localDesc }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to update description');
      }
      setIsEditingDesc(false);
      await handleRegenerate(scene.sceneNumber, 'image');
    } catch (err: any) {
      setError(err.message || 'Failed to update description.');
    }
  };

  const saveScriptAndRegenVideo = async () => {
    try {
      setError(null);
      const res = await fetch('http://localhost:3001/api/scene/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sceneNumber: scene.sceneNumber, script: localScript }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to update script');
      }
      setIsEditingScript(false);
      await handleRegenerate(scene.sceneNumber, 'video');
    } catch (err: any) {
      setError(err.message || 'Failed to update script.');
    }
  };

  // Submit AI Directives Chat
  const submitChatInstruction = async () => {
    const trimmed = chatInput.trim();
    if (!trimmed) return;
    setSendingChat(true);
    const success = await handleSendSceneChat(scene.sceneNumber, trimmed);
    if (success) {
      setChatInput('');
      setChatSuccess(true);
      setTimeout(() => {
        setChatSuccess(false);
      }, 3000);
    }
    setSendingChat(false);
  };

  return (
    <div className="scene-card">
      
      {/* Active Generation/Regeneration Loader Overlay */}
      {(isRegenerating || isGenerating) && (
        <div className="card-loader-overlay">
          <div className="spinner"></div>
          <span className="card-loader-text">
            {isGenerating
              ? `Generating ${isGenerating === 'both' ? 'Assets' : isGenerating}...`
              : `Regenerating ${isRegenerating === 'both' ? 'Assets' : isRegenerating}...`
            }
          </span>
          {elapsedTime !== null && (
            <span className="card-loader-subtext" style={{ fontSize: '0.85rem', color: 'var(--accent-cyan)', fontWeight: 'bold', marginTop: '4px' }}>
              {elapsedTime} sec elapsed
            </span>
          )}
          <span className="card-loader-subtext">This may take up to a minute</span>
        </div>
      )}

      {/* Active AI Chat Processing Overlay */}
      {sendingChat && (
        <div className="card-loader-overlay" style={{ backgroundColor: 'rgba(15, 12, 28, 0.88)' }}>
          <div className="spinner" style={{ borderLeftColor: 'var(--accent-cyan)' }}></div>
          <span className="card-loader-text" style={{ color: 'var(--accent-cyan)' }}>
            AI Director modifying scene...
          </span>
          <span className="card-loader-subtext">Rewriting script &amp; action description</span>
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
            src={getMediaUrl(scene.sceneNumber, scene.videoPath)}
            controls
            autoPlay
            loop
            className="preview-video"
          />
        ) : scene.imagePath ? (
          // Image display
          <img
            src={getMediaUrl(scene.sceneNumber, scene.imagePath)}
            alt={`Scene ${scene.sceneNumber}`}
            className="preview-image"
            style={{ cursor: 'pointer' }}
            onClick={() => setPreviewImageSceneNum(scene.sceneNumber)}
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

        {/* Floating actions in top right corner of media container */}
        <div className="floating-media-actions">
          {scene.imagePath && (
            <button
              type="button"
              className="floating-action-btn"
              onClick={() => setPreviewImageSceneNum(scene.sceneNumber)}
              title="Preview Image"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
                <line x1="11" y1="8" x2="11" y2="14" />
                <line x1="8" y1="11" x2="14" y2="11" />
              </svg>
            </button>
          )}
          <button
            type="button"
            className="floating-action-btn"
            disabled={!!isRegenerating}
            onClick={() => handleRegenerate(scene.sceneNumber, 'image')}
            title="Regenerate Image"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
            </svg>
          </button>
          <button
            type="button"
            className="floating-action-btn"
            disabled={!!isRegenerating || !scene.imagePath}
            onClick={() => handleRegenerate(scene.sceneNumber, 'video')}
            title={!scene.imagePath ? 'Generate the image first' : 'Regenerate Video'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M23 7l-7 5 7 5V7z" />
              <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
            </svg>
          </button>
        </div>

        {/* Play Video overlay overlayed on image */}
        {!isVideoPlaying && scene.videoPath && (
          <button
            type="button"
            className="video-overlay-btn"
            onClick={() => setIsVideoPlaying(true)}
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
              onClick={() => setIsVideoPlaying(false)}
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
                setIsEditingDesc(true);
                setLocalDesc(scene.description);
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
              value={localDesc}
              onChange={(e) => setLocalDesc(e.target.value)}
            />
            <div className="edit-actions-row" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="cancel-btn"
                onClick={() => setIsEditingDesc(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="enhance-btn"
                disabled={enhancingDesc}
                onClick={triggerEnhanceDesc}
              >
                {enhancingDesc ? 'Enhancing...' : 'Enhance with Ollama'}
              </button>
              <button
                type="button"
                className="save-btn"
                onClick={saveDescChanges}
              >
                Save Action
              </button>
              <button
                type="button"
                className="save-btn"
                style={{ background: 'linear-gradient(135deg, var(--green-accent) 0%, var(--accent-purple) 100%)' }}
                onClick={saveDescAndRegenImage}
              >
                Save &amp; Regen Image
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
          {!isEditingScript && (
            <button
              type="button"
              className="edit-script-btn"
              onClick={() => {
                setIsEditingScript(true);
                setLocalScript(scene.script);
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

        {isEditingScript ? (
          <>
            <textarea
              className="script-textarea"
              value={localScript}
              onChange={(e) => setLocalScript(e.target.value)}
            />
            <div className="edit-actions-row" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="cancel-btn"
                onClick={() => setIsEditingScript(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="enhance-btn"
                disabled={enhancingScript}
                onClick={triggerEnhanceScript}
              >
                {enhancingScript ? 'Enhancing...' : 'Enhance with Ollama'}
              </button>
              <button
                type="button"
                className="save-btn"
                onClick={saveScriptChanges}
              >
                Save Script
              </button>
              <button
                type="button"
                className="save-btn"
                style={{ background: 'linear-gradient(135deg, var(--green-accent) 0%, var(--accent-purple) 100%)' }}
                onClick={saveScriptAndRegenVideo}
              >
                Save &amp; Regen Video
              </button>
            </div>
          </>
        ) : (
          <p className="script-text">
            {scene.script || <span style={{ color: '#475569', fontStyle: 'italic' }}>No dialog / narration script defined.</span>}
          </p>
        )}
        
        {/* Interactive AI Scene Directives Chat Box */}
        <div className="scene-chat-box">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2px' }}>
            <span className="script-label" style={{ marginBottom: 0 }}>AI Scene Director Chat</span>
            {chatSuccess && (
              <span style={{ fontSize: '0.75rem', color: 'var(--green-accent)', fontWeight: 'bold' }}>
                ✓ AI changes applied!
              </span>
            )}
          </div>
          <div className="scene-chat-input-wrapper">
            <input
              type="text"
              className="scene-chat-input"
              placeholder="Instruct AI to edit scene (e.g. add red lights)..."
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              disabled={sendingChat}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  submitChatInstruction();
                }
              }}
            />
            <button
              type="button"
              className="scene-chat-send-btn"
              disabled={sendingChat || !chatInput.trim()}
              onClick={submitChatInstruction}
            >
              {sendingChat ? (
                <div className="spinner" style={{ width: '12px', height: '12px', borderWidth: '2px', animationDuration: '0.8s' }}></div>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="22" y1="2" x2="11" y2="13"></line>
                  <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                </svg>
              )}
            </button>
          </div>
        </div>
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
};
