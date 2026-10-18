import { OrreryMoon, OrreryPlanet, Session } from './types';

export type ArrowDirection = 'ArrowRight' | 'ArrowLeft' | 'ArrowUp' | 'ArrowDown';

export type NavigableItem = OrreryPlanet | OrreryMoon;

export function getItemX(item: NavigableItem): number {
  return 'currentX' in item ? item.currentX : item.x;
}

export function getItemY(item: NavigableItem): number {
  return 'currentY' in item ? item.currentY : item.y;
}

/**
 * Finds the next focused item (planet or moon) in the given directional quadrant.
 */
export function getNextFocusedItem(
  items: NavigableItem[],
  currentFocusedId: string | null,
  direction: ArrowDirection
): NavigableItem | null {
  if (items.length === 0) return null;

  const current = items.find(p => p.id === currentFocusedId) || items[0];
  const curX = getItemX(current);
  const curY = getItemY(current);

  let bestCandidate: NavigableItem | null = null;
  let bestScore = Infinity;

  for (const candidate of items) {
    if (candidate.id === current.id) continue;

    const dx = getItemX(candidate) - curX;
    const dy = getItemY(candidate) - curY;

    let isValid = false;
    let score = Infinity;

    switch (direction) {
      case 'ArrowRight':
        if (dx > 0) {
          isValid = true;
          // Primary weight along X, secondary along Y
          score = dx + Math.abs(dy) * 2.0;
        }
        break;
      case 'ArrowLeft':
        if (dx < 0) {
          isValid = true;
          score = -dx + Math.abs(dy) * 2.0;
        }
        break;
      case 'ArrowDown':
        if (dy > 0) {
          isValid = true;
          score = dy + Math.abs(dx) * 2.0;
        }
        break;
      case 'ArrowUp':
        if (dy < 0) {
          isValid = true;
          score = -dy + Math.abs(dx) * 2.0;
        }
        break;
    }

    if (isValid && score < bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    }
  }

  // Fallback if no item strictly in quadrant: wrap around or pick most extreme
  if (!bestCandidate) {
    switch (direction) {
      case 'ArrowRight': {
        // Wrap to leftmost item
        bestCandidate = [...items].sort((a, b) => getItemX(a) - getItemX(b))[0];
        break;
      }
      case 'ArrowLeft': {
        // Wrap to rightmost item
        bestCandidate = [...items].sort((a, b) => getItemX(b) - getItemX(a))[0];
        break;
      }
      case 'ArrowDown': {
        // Wrap to topmost item
        bestCandidate = [...items].sort((a, b) => getItemY(a) - getItemY(b))[0];
        break;
      }
      case 'ArrowUp': {
        // Wrap to bottommost item
        bestCandidate = [...items].sort((a, b) => getItemY(b) - getItemY(a))[0];
        break;
      }
    }
  }

  return bestCandidate;
}

/**
 * Finds the next focused planet in the given directional quadrant.
 */
export function getNextFocusedPlanet(
  planets: OrreryPlanet[],
  currentFocusedId: string | null,
  direction: ArrowDirection
): OrreryPlanet | null {
  return getNextFocusedItem(planets, currentFocusedId, direction) as OrreryPlanet | null;
}

export interface KeyboardNavigatorOptions {
  onSelect?: (session: Session) => void;
  onFocusChange?: (item: NavigableItem | null) => void;
}

export class KeyboardNavigator {
  private planets: OrreryPlanet[] = [];
  private allItems: NavigableItem[] = [];
  private focusedId: string | null = null;
  private onSelect?: (session: Session) => void;
  private onFocusChange?: (item: NavigableItem | null) => void;

  constructor(options: KeyboardNavigatorOptions = {}) {
    this.onSelect = options.onSelect;
    this.onFocusChange = options.onFocusChange;
  }

  public setPlanets(planets: OrreryPlanet[]): void {
    this.planets = planets;
    const items: NavigableItem[] = [];
    for (const p of planets) {
      items.push(p);
      if (p.moons) {
        for (const m of p.moons) {
          items.push(m);
        }
      }
    }
    this.allItems = items;
    if (this.focusedId && !this.allItems.some(item => item.id === this.focusedId)) {
      this.focusedId = this.allItems.length > 0 ? this.allItems[0].id : null;
      this.notifyFocus();
    }
  }

  public setFocusedId(id: string | null): void {
    this.focusedId = id;
    this.notifyFocus();
  }

  public getFocusedItem(): NavigableItem | null {
    return this.allItems.find(item => item.id === this.focusedId) || null;
  }

  public getFocusedPlanet(): OrreryPlanet | null {
    const item = this.getFocusedItem();
    if (!item) return null;
    if ('moons' in item) return item as OrreryPlanet;
    return this.planets.find(p => p.id === (item as OrreryMoon).parentPlanetId) || null;
  }

  public getFocusedMoon(): OrreryMoon | null {
    const item = this.getFocusedItem();
    if (item && 'parentPlanetId' in item) {
      return item as OrreryMoon;
    }
    return null;
  }

  public handleKeyDown(key: string): boolean {
    if (
      key === 'ArrowRight' ||
      key === 'ArrowLeft' ||
      key === 'ArrowUp' ||
      key === 'ArrowDown'
    ) {
      const next = getNextFocusedItem(this.allItems, this.focusedId, key);
      if (next) {
        this.focusedId = next.id;
        this.notifyFocus();
        return true;
      }
    } else if (key === 'Enter' || key === ' ') {
      const current = this.getFocusedItem();
      if (current && this.onSelect) {
        this.onSelect(current.session);
        return true;
      }
    }
    return false;
  }

  private notifyFocus(): void {
    if (this.onFocusChange) {
      this.onFocusChange(this.getFocusedItem());
    }
  }
}
