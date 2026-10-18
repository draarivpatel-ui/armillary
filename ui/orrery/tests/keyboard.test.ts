import { describe, it, expect } from 'vitest';
import { getNextFocusedPlanet, KeyboardNavigator } from '../src/navigation';
import { OrreryPlanet } from '../src/types';

describe('Orrery Keyboard Navigation', () => {
  function makePlanet(id: string, x: number, y: number): OrreryPlanet {
    return {
      id,
      session: {
        id: `s-${id}`,
        agent_id: 'claude',
        family: 'anthropic',
        project_root: '/proj',
        title: `Task ${id}`,
        turns: 4,
        activity: 0.5,
        state: 'working',
      },
      sunId: 'sun-1',
      orbitSemiMajor: 100,
      orbitSemiMinor: 60,
      orbitTilt: 0,
      angle: 0,
      startAngle: 0,
      targetAngle: 0,
      transitionProgress: 1,
      currentX: x,
      currentY: y,
      radius: 10,
      isFront: false,
      isDoneRing: false,
      haloProgress: 0,
      bellGlint: false,
      waitingElapsedMs: 0,
      moons: [],
    };
  }

  it('orders planets spatially and navigates right and left', () => {
    // 3 planets in a row horizontally
    const p1 = makePlanet('p1', 100, 200);
    const p2 = makePlanet('p2', 300, 200);
    const p3 = makePlanet('p3', 500, 200);
    const planets = [p2, p3, p1]; // arbitrary initial array order

    // Starting from p1, ArrowRight should find p2
    const nextR = getNextFocusedPlanet(planets, p1.id, 'ArrowRight');
    expect(nextR?.id).toBe('p2');

    // From p2, ArrowRight should find p3
    const nextR2 = getNextFocusedPlanet(planets, p2.id, 'ArrowRight');
    expect(nextR2?.id).toBe('p3');

    // From p3, ArrowLeft should find p2
    const nextL = getNextFocusedPlanet(planets, p3.id, 'ArrowLeft');
    expect(nextL?.id).toBe('p2');
  });

  it('navigates up and down based on vertical coordinates', () => {
    const pTop = makePlanet('pTop', 200, 100);
    const pMid = makePlanet('pMid', 200, 300);
    const pBot = makePlanet('pBot', 200, 500);
    const planets = [pMid, pTop, pBot];

    const nextDown = getNextFocusedPlanet(planets, pTop.id, 'ArrowDown');
    expect(nextDown?.id).toBe('pMid');

    const nextUp = getNextFocusedPlanet(planets, pBot.id, 'ArrowUp');
    expect(nextUp?.id).toBe('pMid');
  });

  it('triggers selection callback on Enter', () => {
    const p1 = makePlanet('p1', 100, 200);
    let selectedId: string | null = null;
    const nav = new KeyboardNavigator({
      onSelect: (session) => {
        selectedId = session.id;
      },
    });

    nav.setPlanets([p1]);
    nav.setFocusedId('p1');
    nav.handleKeyDown('Enter');

    expect(selectedId).toBe('s-p1');
  });
});
