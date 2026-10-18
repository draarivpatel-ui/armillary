/**
 * Agent family glyphs as plain geometry on a 24 unit grid: the single source for the SVG glyphs
 * (design/src/glyphs.tsx) and the Orrery's canvas planets (ui/orrery/src/glyphs.ts), so a family
 * looks the same in the rail, the Field Guide and on its planet.
 *
 * `detail: true` marks hairline flourishes that a renderer may drop when the glyph is drawn
 * smaller than about 16 px, where they would only blur the symbol.
 */

export type GlyphFamily =
  | "anthropic"
  | "openai"
  | "google"
  | "github-microsoft"
  | "cursor"
  | "open-source-clis"
  | "chinese-labs"
  | "other";

interface Base {
  /** Stroke width in grid units (default 1.25). */
  sw?: number;
  /** Fill with the glyph colour instead of (or as well as) stroking. */
  fill?: boolean;
  /** Draw no stroke (fill only). */
  noStroke?: boolean;
  dash?: [number, number];
  detail?: boolean;
}

export type GlyphPrimitive =
  | (Base & { kind: "circle"; cx: number; cy: number; r: number })
  | (Base & { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number; rotate?: number })
  | (Base & { kind: "path"; d: string });

export const GLYPH_GEOMETRY: Record<GlyphFamily, GlyphPrimitive[]> = {
  // Radiant astrolabe spark
  anthropic: [
    { kind: "circle", cx: 12, cy: 12, r: 3, sw: 1.5 },
    { kind: "path", d: "M12 2v4M12 18v4M2 12h4M18 12h4" },
    { kind: "path", d: "M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83", sw: 0.8 },
    { kind: "circle", cx: 12, cy: 12, r: 8.5, sw: 0.75, dash: [1.5, 2], detail: true },
  ],
  // Armillary sphere with intersecting rings
  openai: [
    { kind: "circle", cx: 12, cy: 12, r: 9, sw: 1 },
    { kind: "ellipse", cx: 12, cy: 12, rx: 9, ry: 3.5, rotate: -30, sw: 0.85 },
    { kind: "ellipse", cx: 12, cy: 12, rx: 9, ry: 3.5, rotate: 30, sw: 0.85 },
    { kind: "circle", cx: 12, cy: 12, r: 1.5, fill: true },
  ],
  // Four-pointed Polaris beacon
  google: [
    { kind: "path", d: "M12 2C12 7.5 16.5 12 22 12C16.5 12 12 16.5 12 22C12 16.5 7.5 12 2 12C7.5 12 12 7.5 12 2Z", sw: 1.1 },
    { kind: "circle", cx: 12, cy: 12, r: 1.75, sw: 0.75 },
    { kind: "circle", cx: 12, cy: 12, r: 8.75, sw: 0.75, dash: [1, 3], detail: true },
  ],
  // Celestial sextant: three stars on their arcs
  "github-microsoft": [
    { kind: "circle", cx: 6, cy: 6, r: 2, sw: 1.2 },
    { kind: "circle", cx: 18, cy: 7, r: 2, sw: 1.2 },
    { kind: "circle", cx: 12, cy: 18, r: 2, sw: 1.2 },
    { kind: "path", d: "M7.5 7.5L10.5 16.5M16.5 8.5L13.5 16.5M8 6h8", sw: 0.85 },
    { kind: "path", d: "M5 20a11 11 0 0 0 14 0", sw: 1, dash: [1.5, 2], detail: true },
  ],
  // Sighting reticle
  cursor: [
    { kind: "circle", cx: 12, cy: 12, r: 8, sw: 1 },
    { kind: "path", d: "M12 3v5M12 16v5M3 12h5M16 12h5", sw: 1 },
    { kind: "circle", cx: 12, cy: 12, r: 2.5, sw: 0.75 },
    { kind: "path", d: "M6 6l2 2M18 6l-2 2M6 18l2-2M18 18l-2-2", sw: 0.75, detail: true },
  ],
  // Engraved gear with a terminal prompt
  "open-source-clis": [
    { kind: "path", d: "M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4l1.4-1.4M17 7l1.4-1.4", sw: 1.1 },
    { kind: "circle", cx: 12, cy: 12, r: 6.5, sw: 0.85 },
    { kind: "path", d: "M9.5 9.5L12.5 12l-3 2.5", sw: 1.25 },
    { kind: "path", d: "M14 15h2.5", sw: 1.25 },
  ],
  // Concentric sun disc with a meridian
  "chinese-labs": [
    { kind: "circle", cx: 12, cy: 12, r: 9, sw: 1 },
    { kind: "ellipse", cx: 12, cy: 12, rx: 4.5, ry: 9, sw: 0.85 },
    { kind: "path", d: "M12 2v20", sw: 1.2 },
    { kind: "path", d: "M3 12h18", sw: 0.75, dash: [1.5, 1.5], detail: true },
    { kind: "circle", cx: 12, cy: 12, r: 2.5, sw: 0.5, fill: true },
  ],
  // Horizon sphere
  other: [
    { kind: "circle", cx: 12, cy: 12, r: 8.5, sw: 1 },
    { kind: "ellipse", cx: 12, cy: 12, rx: 8.5, ry: 3, sw: 0.85 },
    { kind: "circle", cx: 12, cy: 7, r: 1.5, sw: 0.8 },
    { kind: "path", d: "M12 3.5v7", sw: 0.75, dash: [1, 1.5], detail: true },
  ],
};
