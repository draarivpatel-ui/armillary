/**
 * Constants shared with the first run's handoff (FR): the Orrery's engraved frame and its layout seed.
 * The renderer draws from these, so the handoff can morph its own frame onto exactly these lines.
 * Live positions come from the controller (Orrery.layoutAt(t)); see also the app's stage handle.
 */
export const ORRERY_FRAME = {
  /** Outer gilt rule, CSS px in from every canvas edge. */
  outerInset: 10,
  /** Inner gilt rule; the degree scale sits in the band between the two rules. */
  innerInset: 24,
  /** The top and bottom scales span x = innerInset .. width - innerInset over this many degrees. */
  scaleDegrees: 360,
  minorTickDeg: 2,
  midTickDeg: 10,
  majorTickDeg: 30,
  /** Numerals every 30 degrees (30 to 330), set in Cormorant 600 10 px in the band. */
  numeralDeg: 30,
  /** Tick lengths (px), drawn outward from the inner rule. */
  tickLength: { minor: 2.5, mid: 4.5, major: 7 },
} as const;

/** Seed computeLayout uses unless the host passes another. */
export const ORRERY_LAYOUT_SEED = 42;
