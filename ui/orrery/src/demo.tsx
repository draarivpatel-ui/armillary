import React, { useState, useMemo, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { OrreryView } from './OrreryComponent';
import { generateMockData } from './mock';
import { OrreryTheme, Session } from './types';
import './tokens.css';

export const DemoApp: React.FC = () => {
  const [theme, setTheme] = useState<OrreryTheme>('dark');
  const [reducedMotion, setReducedMotion] = useState(false);
  const [seed, setSeed] = useState(42);
  const [projectCount, setProjectCount] = useState(4);
  const [sessionCount, setSessionCount] = useState(16);
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);

  // Dev page host clock sample: taken once at mount and passed down as the mock data's "now".
  const [demoNowMs] = useState<number>(() => Date.now());

  // Generate mock data
  const initialData = useMemo(() => {
    return generateMockData({ seed, projectCount, sessionCount, nowMs: demoNowMs });
  }, [seed, projectCount, sessionCount, demoNowMs]);

  const [projects] = useState(initialData.projects);
  const [sessions, setSessions] = useState(initialData.sessions);

  // Update sessions when seed/counts change
  React.useEffect(() => {
    setSessions(initialData.sessions);
  }, [initialData]);

  // Trigger a waiting transition live
  const triggerWaitingSession = useCallback(() => {
    setSessions(prev => {
      const working = prev.filter(s => s.state === 'working');
      if (working.length === 0) return prev;
      const target = working[Math.floor(Math.random() * working.length)];
      return prev.map(s => {
        if (s.id === target.id) {
          return {
            ...s,
            state: 'waiting',
            waiting_since: Date.now(),
          };
        }
        return s;
      });
    });
  }, []);

  // Complete a session live
  const completeSession = useCallback(() => {
    setSessions(prev => {
      const active = prev.filter(s => s.state !== 'done');
      if (active.length === 0) return prev;
      const target = active[0];
      return prev.map(s => {
        if (s.id === target.id) {
          return {
            ...s,
            state: 'done',
            activity: 0,
          };
        }
        return s;
      });
    });
  }, []);

  return (
    <div
      data-theme={theme}
      style={{
        backgroundColor: 'var(--ink-0)',
        color: 'var(--star)',
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Top Instrument Header */}
      <header
        style={{
          borderBottom: '1px solid var(--line)',
          backgroundColor: 'var(--ink-1)',
          padding: '12px 24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '12px',
        }}
      >
        <div>
          <h1
            style={{
              fontFamily: 'Cormorant, "Cormorant Garamond", Georgia, serif',
              fontSize: '22px',
              fontWeight: 700,
              letterSpacing: '1px',
              color: 'var(--gilt)',
              margin: 0,
            }}
          >
            ARMILLARY
          </h1>
          <p
            style={{
              fontSize: '11px',
              color: 'var(--dust)',
              fontFamily: 'Commit Mono, monospace',
              marginTop: '2px',
            }}
          >
            Live AI Agent Sessions - Antique Celestial View
          </p>
        </div>

        {/* Controls Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <button
            onClick={() => setTheme(t => (t === 'dark' ? 'light' : 'dark'))}
            style={{
              padding: '6px 14px',
              backgroundColor: 'var(--ink-2)',
              color: 'var(--star)',
              border: '1px solid var(--gilt)',
              borderRadius: '2px',
              cursor: 'pointer',
              fontSize: '12px',
              fontFamily: 'inherit',
            }}
          >
            Theme: {theme === 'dark' ? 'Dark (Night)' : 'Light (Day)'}
          </button>

          <button
            onClick={() => setReducedMotion(m => !m)}
            style={{
              padding: '6px 14px',
              backgroundColor: reducedMotion ? 'var(--verdigris)' : 'var(--ink-2)',
              color: 'var(--star)',
              border: '1px solid var(--line)',
              borderRadius: '2px',
              cursor: 'pointer',
              fontSize: '12px',
              fontFamily: 'inherit',
            }}
          >
            Reduced Motion: {reducedMotion ? 'On' : 'Off'}
          </button>

          <label style={{ fontSize: '11px', color: 'var(--dust)', display: 'flex', alignItems: 'center', gap: '4px' }}>
            Projects:
            <select
              value={projectCount}
              onChange={(e) => setProjectCount(Number(e.target.value))}
              style={{
                backgroundColor: 'var(--ink-2)',
                color: 'var(--star)',
                border: '1px solid var(--line)',
                padding: '4px',
                borderRadius: '2px',
              }}
            >
              {[3, 4, 5, 6, 7, 8].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>

          <label style={{ fontSize: '11px', color: 'var(--dust)', display: 'flex', alignItems: 'center', gap: '4px' }}>
            Sessions:
            <select
              value={sessionCount}
              onChange={(e) => setSessionCount(Number(e.target.value))}
              style={{
                backgroundColor: 'var(--ink-2)',
                color: 'var(--star)',
                border: '1px solid var(--line)',
                padding: '4px',
                borderRadius: '2px',
              }}
            >
              {[8, 12, 16, 20, 24, 28].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>

          <button
            onClick={() => setSeed(s => s + 1)}
            style={{
              padding: '6px 14px',
              backgroundColor: 'var(--ink-2)',
              color: 'var(--star)',
              border: '1px solid var(--line)',
              borderRadius: '2px',
              cursor: 'pointer',
              fontSize: '12px',
              fontFamily: 'inherit',
            }}
          >
            New Constellation (Seed {seed})
          </button>

          <button
            onClick={triggerWaitingSession}
            style={{
              padding: '6px 14px',
              backgroundColor: 'var(--vermilion)',
              color: '#ffffff',
              border: '1px solid var(--vermilion)',
              borderRadius: '2px',
              cursor: 'pointer',
              fontSize: '12px',
              fontWeight: 600,
              fontFamily: 'inherit',
            }}
          >
            Trigger "Needs You" Swing
          </button>

          <button
            onClick={completeSession}
            style={{
              padding: '6px 14px',
              backgroundColor: 'var(--verdigris)',
              color: '#ffffff',
              border: '1px solid var(--verdigris)',
              borderRadius: '2px',
              cursor: 'pointer',
              fontSize: '12px',
              fontWeight: 600,
              fontFamily: 'inherit',
            }}
          >
            Settle Done Session
          </button>
        </div>
      </header>

      {/* Main Canvas + Side Drawer */}
      <div
        style={{
          display: 'flex',
          flex: 1,
          position: 'relative',
          overflow: 'hidden',
          backgroundColor: 'var(--ink-0)',
        }}
      >
        <div style={{ flex: 1, position: 'relative', padding: '16px' }}>
          <OrreryView
            projects={projects}
            sessions={sessions}
            width={1160}
            height={740}
            theme={theme}
            reducedMotion={reducedMotion}
            seed={seed}
            onSelectSession={setSelectedSession}
            style={{
              width: '100%',
              height: '100%',
              boxShadow: 'inset 0 0 40px rgba(0,0,0,0.5)',
            }}
          />

          {/* Keyboard hints footer */}
          <div
            style={{
              position: 'absolute',
              bottom: '24px',
              left: '32px',
              fontSize: '11px',
              color: 'var(--dust)',
              fontFamily: 'Commit Mono, monospace',
              backgroundColor: 'var(--ink-1)',
              padding: '4px 10px',
              border: '1px solid var(--line)',
              borderRadius: '2px',
              opacity: 0.85,
            }}
          >
            Navigation: Click or use Arrow keys to move between planets. Press Enter to inspect.
          </div>
        </div>

        {/* Folio Drawer Panel (SPEC 2.1: "Click a planet: the Folio opens beside it") */}
        {selectedSession && (
          <aside
            style={{
              width: '320px',
              borderLeft: '1px solid var(--gilt)',
              backgroundColor: 'var(--ink-1)',
              padding: '20px',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
              zIndex: 10,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span
                style={{
                  fontFamily: 'Cormorant, Georgia, serif',
                  fontSize: '18px',
                  fontWeight: 700,
                  color: 'var(--giltSoft)',
                }}
              >
                FOLIO DRAWER
              </span>
              <button
                onClick={() => setSelectedSession(null)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--dust)',
                  cursor: 'pointer',
                  fontSize: '16px',
                }}
              >
                ✕
              </button>
            </div>

            <div style={{ borderBottom: '1px solid var(--line)', paddingBottom: '12px' }}>
              <div
                style={{
                  fontSize: '11px',
                  fontFamily: 'Commit Mono, monospace',
                  color: 'var(--dust)',
                }}
              >
                SESSION ID: {selectedSession.id}
              </div>
              <h2
                style={{
                  fontSize: '16px',
                  color: 'var(--star)',
                  marginTop: '4px',
                  fontFamily: 'Instrument Sans, sans-serif',
                }}
              >
                {selectedSession.title}
              </h2>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div
                style={{
                  backgroundColor: 'var(--ink-2)',
                  padding: '8px',
                  border: '1px solid var(--line)',
                }}
              >
                <div style={{ fontSize: '10px', color: 'var(--dust)' }}>AGENT FAMILY</div>
                <div
                  style={{
                    fontSize: '12px',
                    fontWeight: 600,
                    color: 'var(--star)',
                    marginTop: '2px',
                    textTransform: 'capitalize',
                  }}
                >
                  {selectedSession.family}
                </div>
              </div>

              <div
                style={{
                  backgroundColor: 'var(--ink-2)',
                  padding: '8px',
                  border: '1px solid var(--line)',
                }}
              >
                <div style={{ fontSize: '10px', color: 'var(--dust)' }}>STATE</div>
                <div
                  style={{
                    fontSize: '12px',
                    fontWeight: 600,
                    color:
                      selectedSession.state === 'waiting'
                        ? 'var(--vermilion)'
                        : selectedSession.state === 'done'
                        ? 'var(--verdigris)'
                        : 'var(--gilt)',
                    marginTop: '2px',
                    textTransform: 'uppercase',
                  }}
                >
                  {selectedSession.state}
                </div>
              </div>

              <div
                style={{
                  backgroundColor: 'var(--ink-2)',
                  padding: '8px',
                  border: '1px solid var(--line)',
                }}
              >
                <div style={{ fontSize: '10px', color: 'var(--dust)' }}>TURNS</div>
                <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--star)', marginTop: '2px' }}>
                  {selectedSession.turns}
                </div>
              </div>

              <div
                style={{
                  backgroundColor: 'var(--ink-2)',
                  padding: '8px',
                  border: '1px solid var(--line)',
                }}
              >
                <div style={{ fontSize: '10px', color: 'var(--dust)' }}>ACTIVITY</div>
                <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--star)', marginTop: '2px' }}>
                  {Math.round(selectedSession.activity * 100)}%
                </div>
              </div>
            </div>

            <div style={{ marginTop: 'auto' }}>
              <button
                style={{
                  width: '100%',
                  padding: '10px',
                  backgroundColor: 'var(--gilt)',
                  color: 'var(--ink-0)',
                  border: 'none',
                  borderRadius: '2px',
                  fontWeight: 600,
                  fontSize: '13px',
                  cursor: 'pointer',
                }}
              >
                Open in Full Folio
              </button>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
};

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<DemoApp />);
}
