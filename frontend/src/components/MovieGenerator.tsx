import React from 'react';

interface MovieGeneratorProps {
  comfyStatus: 'connecting' | 'connected' | 'disconnected';
  topicInput: string;
  setTopicInput: (val: string) => void;
  styleInput: string;
  setStyleInput: (val: string) => void;
  handleTriggerFullGeneration: (e: React.FormEvent) => void;
  showConsole: boolean;
  setShowConsole: (val: boolean) => void;
  generatorStatus: 'idle' | 'generating' | 'success' | 'failed';
}

export const MovieGenerator: React.FC<MovieGeneratorProps> = ({
  comfyStatus,
  topicInput,
  setTopicInput,
  styleInput,
  setStyleInput,
  handleTriggerFullGeneration,
  showConsole,
  setShowConsole,
  generatorStatus
}) => {
  return (
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
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          {generatorStatus !== 'idle' && (
            <button
              type="button"
              className="console-toggle-btn"
              onClick={() => setShowConsole(!showConsole)}
              style={{
                background: 'rgba(139, 102, 255, 0.15)',
                border: '1px solid rgba(139, 102, 255, 0.4)',
                color: '#c084fc',
                padding: '0.3rem 0.75rem',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '0.75rem',
                fontWeight: '700',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                transition: 'all 0.2s ease',
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
              {showConsole ? 'Hide Logs' : 'Show Logs'}
            </button>
          )}
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
  );
};
