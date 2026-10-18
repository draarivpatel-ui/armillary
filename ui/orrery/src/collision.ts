import { OrreryPlanet, OrrerySun, WaitingLabelLayout } from './types';

export interface CollisionOptions {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Computes bounding rectangle for a sun's name plaque.
 */
export function getPlaqueRect(sun: OrrerySun): Rect {
  const titleText = sun.project.name.toUpperCase();
  const textWidth = Math.max(68, Math.round(titleText.length * 8.2));
  const plateW = Math.max(90, Math.round(textWidth + 22));
  const plateH = 20;
  const plateX = Math.round(sun.x - plateW / 2);
  const plateY = Math.round(sun.y - sun.radius - 12 - plateH);
  return { x: plateX, y: plateY, width: plateW, height: plateH };
}

/**
 * Checks whether two rectangles overlap with an optional clearance padding.
 */
export function rectsOverlap(r1: Rect, r2: Rect, padding = 3): boolean {
  return !(
    r1.x + r1.width + padding <= r2.x ||
    r2.x + r2.width + padding <= r1.x ||
    r1.y + r1.height + padding <= r2.y ||
    r2.y + r2.height + padding <= r1.y
  );
}

/**
 * Checks whether a rectangle intersects a circle.
 */
export function rectIntersectsCircle(
  rect: Rect,
  cx: number,
  cy: number,
  radius: number,
  padding = 2
): boolean {
  const closestX = Math.max(rect.x, Math.min(cx, rect.x + rect.width));
  const closestY = Math.max(rect.y, Math.min(cy, rect.y + rect.height));
  const distSq = (cx - closestX) ** 2 + (cy - closestY) ** 2;
  const effectiveR = radius + padding;
  return distSq < effectiveR * effectiveR;
}

/**
 * Format a waiting duration (ms, from planet.waitingElapsedMs) into clean text
 * (NO em or en dashes!). Pure: it never reads a clock.
 */
export function formatWaitingDuration(waitingElapsedMs: number): string {
  const ms = Math.max(0, waitingElapsedMs || 0);
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${Math.max(1, seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m`;
}

/**
 * Computes collision-free positions for needs-you labels.
 * When a label collides with another label, a planet, or sun,
 * it is displaced and assigned a leader line in gilt hairline.
 */
export function computeLabelLayout(
  planets: OrreryPlanet[],
  suns: OrrerySun[],
  options: CollisionOptions
): WaitingLabelLayout[] {
  const { width, height } = options;
  const waitingPlanets = planets.filter(p => p.session.state === 'waiting');
  if (waitingPlanets.length === 0) return [];

  const placedLabels: WaitingLabelLayout[] = [];
  const margin = 24;

  for (const planet of waitingPlanets) {
    const durationText = formatWaitingDuration(planet.waitingElapsedMs);
    const labelText = `Needs you (${durationText})`;

    // Metric estimation matching Instrument Sans 11px
    const badgeW = Math.max(92, Math.round(labelText.length * 6.6 + 14));
    const badgeH = 19;

    // Check candidate positions in priority order
    // 0: default directly below
    const candidates: Array<{ x: number; y: number; isDefault: boolean }> = [
      { x: planet.currentX - badgeW / 2, y: planet.currentY + planet.radius + 8, isDefault: true },
      // Staggered offsets below
      { x: planet.currentX - badgeW - 10, y: planet.currentY + planet.radius + 12, isDefault: false },
      { x: planet.currentX + 10, y: planet.currentY + planet.radius + 12, isDefault: false },
      { x: planet.currentX - badgeW / 2, y: planet.currentY + planet.radius + 32, isDefault: false },
      // Above
      { x: planet.currentX - badgeW / 2, y: planet.currentY - planet.radius - 8 - badgeH, isDefault: false },
      { x: planet.currentX - badgeW - 10, y: planet.currentY - planet.radius - 12 - badgeH, isDefault: false },
      { x: planet.currentX + 10, y: planet.currentY - planet.radius - 12 - badgeH, isDefault: false },
      { x: planet.currentX - badgeW / 2, y: planet.currentY - planet.radius - 32 - badgeH, isDefault: false },
      // Sides
      { x: planet.currentX + planet.radius + 14, y: planet.currentY - badgeH / 2, isDefault: false },
      { x: planet.currentX - planet.radius - 14 - badgeW, y: planet.currentY - badgeH / 2, isDefault: false },
    ];

    // Radial expansions if crowded
    const radialDistances = [45, 65, 88, 115, 145];
    const angles = [
      Math.PI / 2,
      (3 * Math.PI) / 4,
      Math.PI / 4,
      Math.PI,
      0,
      (5 * Math.PI) / 4,
      (7 * Math.PI) / 4,
      (3 * Math.PI) / 2,
    ];

    for (const dist of radialDistances) {
      for (const ang of angles) {
        const cx = planet.currentX + Math.cos(ang) * (planet.radius + dist);
        const cy = planet.currentY + Math.sin(ang) * (planet.radius + dist);
        candidates.push({
          x: cx - badgeW / 2,
          y: cy - badgeH / 2,
          isDefault: false,
        });
      }
    }

    let chosenCandidate: { x: number; y: number; isDefault: boolean } | null = null;

    for (const cand of candidates) {
      const rect: Rect = {
        x: Math.round(cand.x),
        y: Math.round(cand.y),
        width: badgeW,
        height: badgeH,
      };

      // 1. Boundary check
      if (
        rect.x < margin ||
        rect.x + rect.width > width - margin ||
        rect.y < margin ||
        rect.y + rect.height > height - margin
      ) {
        continue;
      }

      // 2. Check collision with already placed labels
      let collidesWithLabel = false;
      for (const placed of placedLabels) {
        if (rectsOverlap(rect, placed, 4)) {
          collidesWithLabel = true;
          break;
        }
      }
      if (collidesWithLabel) continue;

      // 3. Check collision with planet bodies
      let collidesWithPlanet = false;
      for (const p of planets) {
        if (rectIntersectsCircle(rect, p.currentX, p.currentY, p.radius, 3)) {
          collidesWithPlanet = true;
          break;
        }
      }
      if (collidesWithPlanet) continue;

      // 4. Check collision with sun discs
      let collidesWithSun = false;
      for (const sun of suns) {
        if (rectIntersectsCircle(rect, sun.x, sun.y, sun.radius + 12, 4)) {
          collidesWithSun = true;
          break;
        }
      }
      if (collidesWithSun) continue;

      // 4.5 Check collision with sun name plaques
      let collidesWithPlaque = false;
      for (const sun of suns) {
        const plaque = getPlaqueRect(sun);
        if (rectsOverlap(rect, plaque, 4)) {
          collidesWithPlaque = true;
          break;
        }
      }
      if (collidesWithPlaque) continue;

      // Found valid position!
      chosenCandidate = cand;
      break;
    }

    if (!chosenCandidate) {
      // Fallback: use first candidate bounded
      chosenCandidate = candidates[0];
    }

    const finalX = Math.round(Math.max(margin, Math.min(width - margin - badgeW, chosenCandidate.x)));
    const finalY = Math.round(Math.max(margin, Math.min(height - margin - badgeH, chosenCandidate.y)));
    const isDisplaced = !chosenCandidate.isDefault;

    let leaderLine: WaitingLabelLayout['leaderLine'] = undefined;
    if (isDisplaced) {
      // Calculate leader line from planet edge to nearest point on the badge
      const badgeCenterX = finalX + badgeW / 2;
      const badgeCenterY = finalY + badgeH / 2;
      const angle = Math.atan2(badgeCenterY - planet.currentY, badgeCenterX - planet.currentX);

      const fromX = Math.round((planet.currentX + Math.cos(angle) * (planet.radius + 2)) * 10) / 10;
      const fromY = Math.round((planet.currentY + Math.sin(angle) * (planet.radius + 2)) * 10) / 10;

      // Target point on the edge of the badge
      const toX = Math.round(Math.max(finalX, Math.min(badgeCenterX, finalX + badgeW)) * 10) / 10;
      const toY = Math.round(Math.max(finalY, Math.min(badgeCenterY, finalY + badgeH)) * 10) / 10;

      leaderLine = { fromX, fromY, toX, toY };
    }

    const layoutItem: WaitingLabelLayout = {
      planetId: planet.id,
      labelText,
      x: finalX,
      y: finalY,
      width: badgeW,
      height: badgeH,
      isDisplaced,
      leaderLine,
    };

    planet.labelLayout = layoutItem;
    placedLabels.push(layoutItem);
  }

  return placedLabels;
}
