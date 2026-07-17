import React from 'react';
import { StoryManifest } from '../types';

interface MoviePreviewProps {
  story: StoryManifest;
  mergingVideos: boolean;
  handleMergeVideos: () => void;
  mediaCacheBuster: Record<number, number>;
  getMediaUrl: (sceneNumber: number, filePath?: string) => string;
}

export const MoviePreview: React.FC<MoviePreviewProps> = ({
  story,
  mergingVideos,
  handleMergeVideos,
  mediaCacheBuster,
  getMediaUrl
}) => {
  return (
    <div className="master-video-card">
      <h2 className="card-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
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
        </span>
        <button 
          onClick={handleMergeVideos}
          disabled={mergingVideos}
          className="merge-action-btn"
          title="Merge all generated scene videos into the final movie"
        >
          {mergingVideos ? (
            <>
              <div className="spinner-mini"></div>
              Merging...
            </>
          ) : (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M18 12h-6a4 4 0 0 1-4-4V3" />
                <path d="M18 12h-6a4 4 0 0 0-4 4v5" />
                <path d="M22 12l-4-4v8z" />
              </svg>
              Merge Scenes
            </>
          )}
        </button>
      </h2>
      <div className="master-video-container">
        {story.mergedVideoPath ? (
          <video 
            key={story.mergedVideoPath + (mediaCacheBuster[0] ? `?cb=${mediaCacheBuster[0]}` : '')}
            controls 
            className="master-video-player"
            src={getMediaUrl(0, story.mergedVideoPath)}
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
  );
};
