import React from 'react';
import { StoryManifest } from '../types';

interface LightboxModalProps {
  previewImageSceneNum: number | null;
  setPreviewImageSceneNum: (sceneNumber: number | null) => void;
  story: StoryManifest | null;
  getMediaUrl: (sceneNumber: number, filePath?: string) => string;
}

export const LightboxModal: React.FC<LightboxModalProps> = ({
  previewImageSceneNum,
  setPreviewImageSceneNum,
  story,
  getMediaUrl
}) => {
  if (previewImageSceneNum === null || !story) return null;

  const previewScene = story.scenes.find(s => s.sceneNumber === previewImageSceneNum);
  if (!previewScene || !previewScene.imagePath) return null;

  return (
    <div className="lightbox-overlay" onClick={() => setPreviewImageSceneNum(null)}>
      <div className="lightbox-content" onClick={(e) => e.stopPropagation()}>
        <button 
          type="button" 
          className="lightbox-close-btn" 
          onClick={() => setPreviewImageSceneNum(null)}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
        <img 
          src={getMediaUrl(previewScene.sceneNumber, previewScene.imagePath)} 
          alt={`Scene ${previewScene.sceneNumber}`} 
          className="lightbox-image"
        />
        <div className="lightbox-info">
          <span className="lightbox-scene-badge">Scene {previewScene.sceneNumber}</span>
          <p className="lightbox-desc">{previewScene.description}</p>
          {previewScene.script && (
            <p className="lightbox-script"><strong>Script:</strong> {previewScene.script}</p>
          )}
        </div>
      </div>
    </div>
  );
};
