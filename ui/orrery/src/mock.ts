import { AgentFamily, LiveState, Project, Session } from './types';

/**
 * Deterministic pseudo-random number generator (Mulberry32).
 */
export function createPrng(seed: number | string): () => number {
  let s = typeof seed === 'string' ? hashString(seed) : seed;
  if (s === 0) s = 1;
  return function () {
    let t = (s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0;
  }
  return hash;
}

export interface MockDataOptions {
  seed?: number | string;
  projectCount?: number; // 3 to 8
  sessionCount?: number; // up to 30
  /**
   * Unix ms the waiting_since values are measured back from. A host that shows
   * live data passes its own clock sample; the default is a fixed constant so
   * the same options always give the same data.
   */
  nowMs?: number;
}

/** Fixed default for MockDataOptions.nowMs (Unix ms). */
export const DEFAULT_MOCK_NOW_MS = 1_760_000_000_000;

export interface MockDataResult {
  projects: Project[];
  sessions: Session[];
}

const PROJECT_NAMES = [
  'agent-hub',
  'astrolabe-core',
  'quantum-sim',
  'compiler-pass',
  'folio-reader',
  'vector-store',
  'browser-pilot',
  'celestial-map',
];

const AGENT_CONFIGS: { agent_id: string; family: AgentFamily }[] = [
  { agent_id: 'claude-code', family: 'anthropic' },
  { agent_id: 'codex-cli', family: 'openai' },
  { agent_id: 'gemini-cli', family: 'google' },
  { agent_id: 'copilot-workspace', family: 'github' },
  { agent_id: 'cursor-composer', family: 'cursor' },
  { agent_id: 'aider', family: 'open-source' },
  { agent_id: 'qwen-coder', family: 'chinese' },
  { agent_id: 'hermes-desktop', family: 'other' },
];

const SESSION_TITLES = [
  'Refactor SQLite query planner',
  'Optimize LCP and font loading',
  'Fix parser grammar edge cases',
  'Implement waiting halo transition',
  'Verify WCAG contrast tokens',
  'Calibrate celestial grid hairlines',
  'Draft telemetry schema',
  'Profile Canvas 2D frame governor',
  'Audit keyboard navigation flow',
  'Generate deterministic star chart',
  'Sync local MCP servers',
  'Repair portable-pty terminal spawn',
  'Extract golden test fixtures',
  'Index session archive chunks',
  'Align project sun coordinate arc',
];

export function generateMockData(options: MockDataOptions = {}): MockDataResult {
  const seed = options.seed ?? 42;
  const rand = createPrng(seed);

  const numProjects = Math.min(
    8,
    Math.max(3, options.projectCount ?? 3 + Math.floor(rand() * 4))
  );
  const numSessions = Math.min(
    30,
    Math.max(6, options.sessionCount ?? 12 + Math.floor(rand() * 12))
  );

  const projects: Project[] = [];
  for (let i = 0; i < numProjects; i++) {
    const name = PROJECT_NAMES[i % PROJECT_NAMES.length];
    projects.push({
      id: `proj-${i + 1}`,
      name,
      root: `/Users/developer/Projects/${name}`,
    });
  }

  const sessions: Session[] = [];
  const now = options.nowMs ?? DEFAULT_MOCK_NOW_MS;

  // Distribute sessions across projects
  for (let i = 0; i < numSessions; i++) {
    const project = projects[i % projects.length];
    const agent = AGENT_CONFIGS[Math.floor(rand() * AGENT_CONFIGS.length)];
    const title = SESSION_TITLES[Math.floor(rand() * SESSION_TITLES.length)];

    // State distribution:
    // working: ~45%, waiting: ~25%, idle: ~15%, done: ~15%
    const stateRoll = rand();
    let state: LiveState;
    let waiting_since: number | undefined;

    if (stateRoll < 0.45) {
      state = 'working';
    } else if (stateRoll < 0.70) {
      state = 'waiting';
      // Between 30 seconds and 6 minutes ago
      waiting_since = now - Math.floor(30000 + rand() * 330000);
    } else if (stateRoll < 0.85) {
      state = 'idle';
    } else {
      state = 'done';
    }

    const turns = Math.floor(2 + rand() * 26);
    const activity = state === 'idle' ? 0.05 + rand() * 0.15 : 0.4 + rand() * 0.6;

    sessions.push({
      id: `session-${i + 1}`,
      agent_id: agent.agent_id,
      family: agent.family,
      project_root: project.root,
      title,
      turns,
      activity: state === 'done' ? 0 : activity,
      state,
      waiting_since,
    });
  }

  // Assign ~20% of active sessions as subagent moons to earlier sessions
  const activeSessions = sessions.filter(s => s.state === 'working');
  if (activeSessions.length >= 2) {
    const numMoons = Math.min(4, Math.floor(activeSessions.length * 0.35));
    for (let m = 0; m < numMoons; m++) {
      const child = activeSessions[activeSessions.length - 1 - m];
      const parent = activeSessions[m];
      if (child && parent && child.id !== parent.id) {
        child.parent_id = parent.id;
        child.title = `Subagent: ${child.title}`;
      }
    }
  }

  return { projects, sessions };
}
