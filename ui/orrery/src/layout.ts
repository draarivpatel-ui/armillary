import { Project, Session, OrreryLayout, OrrerySun, OrreryPlanet, OrreryMoon } from './types';
import { createPrng } from './mock';
import { computeLabelLayout, getPlaqueRect, rectIntersectsCircle } from './collision';

export { computeLabelLayout, getPlaqueRect } from './collision';

export interface LayoutOptions {
  width: number;
  height: number;
  seed?: number | string;
}

export function computeLayout(
  projects: Project[],
  sessions: Session[],
  options: LayoutOptions
): OrreryLayout {
  const { width, height, seed = 42 } = options;
  const rand = createPrng(seed);

  // Separate subagents (moons) from parent planets.
  // A subagent whose parent does not exist in sessions is an orphan subagent,
  // and must be retained as a top-level session rather than disappearing.
  const sessionIds = new Set(sessions.map(s => s.id));
  const subagentSessions: Session[] = [];
  const topLevelSessions: Session[] = [];
  const orphanIds = new Set<string>();

  for (const session of sessions) {
    if (session.parent_id && sessionIds.has(session.parent_id)) {
      subagentSessions.push(session);
    } else {
      topLevelSessions.push(session);
      if (session.parent_id) orphanIds.add(session.id);
    }
  }

  // Check for unmatched session roots
  const knownRoots = new Set(projects.map(p => p.root));
  const hasUnmatched = topLevelSessions.some(s => !knownRoots.has(s.project_root));

  // Build effective projects list (including unassigned bucket if needed)
  const effectiveProjects = [...projects];
  if (hasUnmatched || (projects.length === 0 && topLevelSessions.length > 0)) {
    effectiveProjects.push({
      id: 'unassigned',
      name: 'Unassigned',
      root: '__UNASSIGNED__',
    });
  }

  if (effectiveProjects.length === 0) {
    return { suns: [], planets: [], labels: [] };
  }

  const numProjects = effectiveProjects.length;
  const suns: OrrerySun[] = [];

  // Calculate sun positions across vertical space in a celestial star-chart arrangement
  if (numProjects === 1) {
    suns.push({
      id: `sun-${effectiveProjects[0].id}`,
      project: effectiveProjects[0],
      x: Math.round(width * 0.5),
      y: Math.round(height * 0.5),
      radius: 24,
    });
  } else if (numProjects === 2) {
    suns.push({
      id: `sun-${effectiveProjects[0].id}`,
      project: effectiveProjects[0],
      x: Math.round(width * 0.32 + (rand() - 0.5) * 16),
      y: Math.round(height * 0.34 + (rand() - 0.5) * 16),
      radius: 24,
    });
    suns.push({
      id: `sun-${effectiveProjects[1].id}`,
      project: effectiveProjects[1],
      x: Math.round(width * 0.68 + (rand() - 0.5) * 16),
      y: Math.round(height * 0.66 + (rand() - 0.5) * 16),
      radius: 24,
    });
  } else if (numProjects === 3) {
    // Triangular star-chart constellation
    suns.push({
      id: `sun-${effectiveProjects[0].id}`,
      project: effectiveProjects[0],
      x: Math.round(width * 0.28 + (rand() - 0.5) * 16),
      y: Math.round(height * 0.66 + (rand() - 0.5) * 16),
      radius: 23,
    });
    suns.push({
      id: `sun-${effectiveProjects[1].id}`,
      project: effectiveProjects[1],
      x: Math.round(width * 0.50 + (rand() - 0.5) * 16),
      y: Math.round(height * 0.34 + (rand() - 0.5) * 16),
      radius: 25,
    });
    suns.push({
      id: `sun-${effectiveProjects[2].id}`,
      project: effectiveProjects[2],
      x: Math.round(width * 0.74 + (rand() - 0.5) * 16),
      y: Math.round(height * 0.66 + (rand() - 0.5) * 16),
      radius: 23,
    });
  } else {
    // 4 or more suns: staggered two-tier star-chart coordinates using both upper and lower canvas
    const paddingX = Math.max(140, width * 0.14);
    const usableWidth = width - 2 * paddingX;

    for (let i = 0; i < numProjects; i++) {
      const t = i / (numProjects - 1);
      const isLowerTier = i % 2 === 1;

      const x = paddingX + t * usableWidth + (rand() - 0.5) * 18;
      // Upper tier ~0.33 H, lower tier ~0.67 H (vertical spread ~270px)
      const yBase = isLowerTier ? height * 0.67 : height * 0.33;
      const y = yBase + (rand() - 0.5) * 18;
      const radius = 22 + Math.floor(rand() * 5);

      suns.push({
        id: `sun-${effectiveProjects[i].id}`,
        project: effectiveProjects[i],
        x: Math.round(x),
        y: Math.round(y),
        radius,
      });
    }
  }

  // Pre-calculate minimum distance to nearest neighbouring sun for each sun
  // to scale orbit sizes so neighbouring systems never overlap
  const minDistanceToOtherSun = new Map<string, number>();
  for (let i = 0; i < suns.length; i++) {
    let minDist = Infinity;
    for (let j = 0; j < suns.length; j++) {
      if (i !== j) {
        const d = Math.hypot(suns[i].x - suns[j].x, suns[i].y - suns[j].y);
        if (d < minDist) {
          minDist = d;
        }
      }
    }
    minDistanceToOtherSun.set(
      suns[i].id,
      minDist === Infinity ? Math.min(width, height) * 0.45 : minDist
    );
  }

  // Create sun lookup
  const sunMap = new Map<string, OrrerySun>();
  const sunByRoot = new Map<string, OrrerySun>();
  for (const sun of suns) {
    sunMap.set(sun.id, sun);
    sunByRoot.set(sun.project.root, sun);
  }

  // Group top-level sessions by sun
  const sessionsBySun = new Map<string, Session[]>();
  for (const sun of suns) {
    sessionsBySun.set(sun.id, []);
  }

  for (const session of topLevelSessions) {
    let assignedSun = sunByRoot.get(session.project_root);
    if (!assignedSun) {
      assignedSun = sunMap.get('sun-unassigned') || suns[0];
    }
    sessionsBySun.get(assignedSun.id)?.push(session);
  }

  const planets: OrreryPlanet[] = [];

  // Layout orbits per sun, strictly bounding orbit sizes to prevent inter-system overlap
  for (const sun of suns) {
    const sunSessions = sessionsBySun.get(sun.id) || [];
    const doneSessions = sunSessions.filter(s => s.state === 'done');
    const activeSessions = sunSessions.filter(s => s.state !== 'done');

    const nearestSunDist = minDistanceToOtherSun.get(sun.id) || 400;
    // Clearance between systems: at least 24px so orbits never overlap
    const maxAllowedByNeighbours = (nearestSunDist - 24) / 2;
    // Keep safely inside canvas margins
    const maxAllowedByBounds = Math.min(
      sun.x - 24,
      width - 24 - sun.x,
      sun.y - 24,
      height - 24 - sun.y
    );
    // The 60 px floor keeps tiny systems readable, but never past the canvas margin.
    const boundedMax = Math.max(0, maxAllowedByBounds);
    const systemMaxRadius = Math.min(
      boundedMax,
      Math.max(60, Math.min(maxAllowedByNeighbours, maxAllowedByBounds))
    );

    // 1. Done sessions settle into the inner done ring around the sun, strictly below the plaque
    const doneRingSemiMajor = Math.min(36, sun.radius + 8);
    const doneRingSemiMinor = Math.round(doneRingSemiMajor * 0.65);
    const doneRingTilt = 0.10;

    for (let d = 0; d < doneSessions.length; d++) {
      const s = doneSessions[d];
      const count = doneSessions.length;
      // Stagger angle away from top (-PI/2) so done planets never touch plaque
      const baseAngle = (d * 2 * Math.PI) / count;
      let angle = (baseAngle + Math.PI / 4) % (Math.PI * 2);
      const planetRadius = Math.max(5.5, Math.min(7.5, 5.5 + s.turns * 0.1));

      const plaque = getPlaqueRect(sun);
      let attempts = 0;
      while (attempts < 8) {
        const cosA = Math.cos(angle);
        const sinA = Math.sin(angle);
        const unrotatedX = doneRingSemiMajor * cosA;
        const unrotatedY = doneRingSemiMinor * sinA;
        const cosT = Math.cos(doneRingTilt);
        const sinT = Math.sin(doneRingTilt);
        const px = sun.x + (unrotatedX * cosT - unrotatedY * sinT);
        const py = sun.y + (unrotatedX * sinT + unrotatedY * cosT);
        if (!rectIntersectsCircle(plaque, px, py, planetRadius, 3)) {
          break;
        }
        angle = (angle + 0.4) % (Math.PI * 2);
        attempts++;
      }

      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      const unrotatedX = doneRingSemiMajor * cosA;
      const unrotatedY = doneRingSemiMinor * sinA;
      const cosT = Math.cos(doneRingTilt);
      const sinT = Math.sin(doneRingTilt);

      const px = sun.x + (unrotatedX * cosT - unrotatedY * sinT);
      const py = sun.y + (unrotatedX * sinT + unrotatedY * cosT);

      planets.push({
        id: `planet-${s.id}`,
        session: s,
        sunId: sun.id,
        orbitSemiMajor: doneRingSemiMajor,
        orbitSemiMinor: doneRingSemiMinor,
        orbitTilt: doneRingTilt,
        angle,
        startAngle: angle,
        targetAngle: angle,
        transitionProgress: 1,
        currentX: Math.round(px * 10) / 10,
        currentY: Math.round(py * 10) / 10,
        radius: planetRadius,
        isFront: false,
        isDoneRing: true,
        haloProgress: 0,
        bellGlint: false,
        waitingElapsedMs: 0,
        moons: [],
      });
    }

    // 2. Active & idle sessions get scaled concentric elliptical orbits
    const numActive = activeSessions.length;
    const waitingOnThisSun = activeSessions.filter(s => s.state === 'waiting');

    // Innermost active orbit must clear the plaque obstacle completely
    // On small canvases both radii are clamped so every orbit stays inside the 24 px margin.
    let minActiveR = Math.max(sun.radius + 62, 86);
    const maxActiveR = Math.min(boundedMax, Math.max(minActiveR + 10, systemMaxRadius - 4));
    minActiveR = Math.min(minActiveR, maxActiveR);

    // Compute orbit step to ensure adjacent orbits do not touch
    // Step is distributed across available span so max orbit semi-major strictly <= maxActiveR
    const availableSpan = Math.max(0, maxActiveR - minActiveR);
    const orbitStep = numActive > 1 ? availableSpan / (numActive - 1) : 0;

    for (let a = 0; a < numActive; a++) {
      const s = activeSessions[a];
      const orbitSemiMajor = Math.round(minActiveR + a * orbitStep);
      const orbitSemiMinor = Math.round(orbitSemiMajor * 0.88);
      const orbitTilt = 0.10 + (rand() - 0.5) * 0.04;

      const isWaiting = s.state === 'waiting';

      let targetAngle = Math.PI / 2;
      if (isWaiting && waitingOnThisSun.length > 1) {
        const waitIdx = waitingOnThisSun.findIndex(w => w.id === s.id);
        const spread = 0.28;
        targetAngle = Math.PI / 2 + (waitIdx - (waitingOnThisSun.length - 1) / 2) * spread;
      }

      const planetRadius = Math.max(6.5, Math.min(10.5, 6.5 + Math.sqrt(s.turns) * 0.75));

      // Initial angle: if session is already waiting, place at targetAngle (front of orbit)
      // Otherwise assign random angle that avoids the plaque obstacle
      let initialAngle = isWaiting ? targetAngle : rand() * Math.PI * 2;
      let angle = initialAngle;

      const plaque = getPlaqueRect(sun);
      let attempts = 0;
      while (attempts < 12) {
        const cosA = Math.cos(angle);
        const sinA = Math.sin(angle);
        const unrotatedX = orbitSemiMajor * cosA;
        const unrotatedY = orbitSemiMinor * sinA;
        const cosT = Math.cos(orbitTilt);
        const sinT = Math.sin(orbitTilt);
        const px = sun.x + (unrotatedX * cosT - unrotatedY * sinT);
        const py = sun.y + (unrotatedX * sinT + unrotatedY * cosT);
        if (!rectIntersectsCircle(plaque, px, py, planetRadius, 4)) {
          break;
        }
        angle = (angle + 0.4) % (Math.PI * 2);
        initialAngle = angle;
        attempts++;
      }

      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      const unrotatedX = orbitSemiMajor * cosA;
      const unrotatedY = orbitSemiMinor * sinA;
      const cosT = Math.cos(orbitTilt);
      const sinT = Math.sin(orbitTilt);

      const px = sun.x + (unrotatedX * cosT - unrotatedY * sinT);
      const py = sun.y + (unrotatedX * sinT + unrotatedY * cosT);

      planets.push({
        id: `planet-${s.id}`,
        session: s,
        sunId: sun.id,
        orbitSemiMajor,
        orbitSemiMinor,
        orbitTilt,
        angle,
        startAngle: initialAngle,
        targetAngle,
        transitionProgress: 1,
        currentX: Math.round(px * 10) / 10,
        currentY: Math.round(py * 10) / 10,
        radius: planetRadius,
        isFront: isWaiting,
        isDoneRing: false,
        haloProgress: isWaiting ? 1 : 0,
        bellGlint: isWaiting,
        // The layout has no clock: the controller derives the elapsed time from t.
        waitingElapsedMs: 0,
        // A waiting planet in a static layout counts as already arrived at the front.
        ...(isWaiting ? { transitionStartTime: -600 } : {}),
        moons: [],
      });
    }
  }

  // Create planet lookup for moons
  const planetBySessionId = new Map<string, OrreryPlanet>();
  for (const p of planets) {
    planetBySessionId.set(p.session.id, p);
  }

  for (const p of planets) {
    if (orphanIds.has(p.session.id)) p.isOrphan = true;
  }

  // 3. Attach subagents as moons
  for (let m = 0; m < subagentSessions.length; m++) {
    const subSession = subagentSessions[m];
    const parentPlanet = subSession.parent_id
      ? planetBySessionId.get(subSession.parent_id)
      : null;

    if (parentPlanet) {
      const moonOrbitRadius = parentPlanet.radius + 12 + m * 5;
      const moonAngle = (m * Math.PI * 2) / 3 + rand() * 0.5;
      const moonRadius = Math.max(3.5, Math.min(5, 3 + subSession.turns * 0.1));

      const mx = parentPlanet.currentX + Math.cos(moonAngle) * moonOrbitRadius;
      const my = parentPlanet.currentY + Math.sin(moonAngle) * moonOrbitRadius;

      const moon: OrreryMoon = {
        id: `moon-${subSession.id}`,
        session: subSession,
        parentPlanetId: parentPlanet.id,
        orbitRadius: moonOrbitRadius,
        angle: moonAngle,
        startAngle: moonAngle,
        x: Math.round(mx * 10) / 10,
        y: Math.round(my * 10) / 10,
        radius: moonRadius,
      };

      parentPlanet.moons.push(moon);
    }
  }

  // 4. Compute initial collision-free labels
  const labels = computeLabelLayout(planets, suns, { width, height });

  return { suns, planets, labels };
}
