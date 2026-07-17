import React from 'react';

interface ConsoleLog {
  type: 'stdout' | 'stderr' | 'status';
  text: string;
}

interface ConsoleModalProps {
  showConsole: boolean;
  setShowConsole: (show: boolean) => void;
  consoleLogs: ConsoleLog[];
  generatorStatus: 'idle' | 'generating' | 'success' | 'failed';
  comfyExecutingNode: string | null;
  comfyPreviewUrl: string | null;
  comfyProgress: { value: number; max: number } | null;
  consoleLogEndRef: React.RefObject<HTMLDivElement | null>;
}

export const ConsoleModal: React.FC<ConsoleModalProps> = ({
  showConsole,
  setShowConsole,
  consoleLogs,
  generatorStatus,
  comfyExecutingNode,
  comfyPreviewUrl,
  comfyProgress,
  consoleLogEndRef
}) => {
  if (!showConsole) return null;

  return (
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
  );
};
