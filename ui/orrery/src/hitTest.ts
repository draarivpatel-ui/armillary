import { HitTestResult, OrreryLayout } from './types';

/**
 * Performs hit testing against all planets, moons, and suns in the layout.
 * Returns the hit entity or null if empty space was clicked.
 */
export function hitTest(
  x: number,
  y: number,
  layout: OrreryLayout,
  hitPadding: number = 6
): HitTestResult | null {
  // 1. Check moons first (highest visual stacking)
  for (const planet of layout.planets) {
    for (const moon of planet.moons) {
      const dx = x - moon.x;
      const dy = y - moon.y;
      const distSq = dx * dx + dy * dy;
      const hitRadius = moon.radius + hitPadding;
      if (distSq <= hitRadius * hitRadius) {
        return { type: 'moon', moon, planet };
      }
    }
  }

  // 2. Check planets
  // Sort by front-most (isFront or higher y coordinate) so foreground planets take precedence
  const sortedPlanets = [...layout.planets].sort((a, b) => {
    if (a.isFront && !b.isFront) return -1;
    if (!a.isFront && b.isFront) return 1;
    return b.currentY - a.currentY;
  });

  for (const planet of sortedPlanets) {
    const dx = x - planet.currentX;
    const dy = y - planet.currentY;
    const distSq = dx * dx + dy * dy;
    const hitRadius = planet.radius + hitPadding;
    if (distSq <= hitRadius * hitRadius) {
      return { type: 'planet', planet };
    }
  }

  // 3. Check suns
  for (const sun of layout.suns) {
    const dx = x - sun.x;
    const dy = y - sun.y;
    const distSq = dx * dx + dy * dy;
    const hitRadius = sun.radius + hitPadding;
    if (distSq <= hitRadius * hitRadius) {
      return { type: 'sun', sun };
    }
  }

  return null;
}
