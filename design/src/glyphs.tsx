import React from "react";
import { AgentFamily } from "./tokens";
import { GLYPH_GEOMETRY, type GlyphPrimitive } from "./glyphGeometry";

export const AGENT_FAMILIES: AgentFamily[] = [
  "anthropic",
  "openai",
  "google",
  "github-microsoft",
  "cursor",
  "open-source-clis",
  "chinese-labs",
  "other",
];

export interface GlyphProps extends React.SVGProps<SVGSVGElement> {
  size?: number;
  className?: string;
}

export interface AgentGlyphProps extends GlyphProps {
  family: AgentFamily;
}

function primitive(p: GlyphPrimitive, key: number): React.ReactElement {
  const common = {
    strokeWidth: p.sw ?? 1.25,
    stroke: p.noStroke ? "none" : "currentColor",
    fill: p.fill ? "currentColor" : "none",
    strokeDasharray: p.dash ? `${p.dash[0]} ${p.dash[1]}` : undefined,
  };
  switch (p.kind) {
    case "circle":
      return <circle key={key} cx={p.cx} cy={p.cy} r={p.r} {...common} />;
    case "ellipse":
      return (
        <ellipse
          key={key}
          cx={p.cx}
          cy={p.cy}
          rx={p.rx}
          ry={p.ry}
          transform={p.rotate ? `rotate(${p.rotate} ${p.cx} ${p.cy})` : undefined}
          {...common}
        />
      );
    case "path":
      return <path key={key} d={p.d} {...common} />;
  }
}

/** One engraved monochrome glyph per agent family (SPEC 3.2), drawn from the shared geometry. */
function makeGlyph(family: AgentFamily, displayName: string): React.FC<GlyphProps> {
  const Glyph: React.FC<GlyphProps> = ({ size = 16, className = "", ...props }) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`obs-glyph obs-glyph--${family} ${className}`.trim()}
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {GLYPH_GEOMETRY[family].map(primitive)}
    </svg>
  );
  Glyph.displayName = displayName;
  return Glyph;
}

export const AnthropicGlyph = makeGlyph("anthropic", "AnthropicGlyph");
export const OpenAIGlyph = makeGlyph("openai", "OpenAIGlyph");
export const GoogleGlyph = makeGlyph("google", "GoogleGlyph");
export const GitHubMicrosoftGlyph = makeGlyph("github-microsoft", "GitHubMicrosoftGlyph");
export const CursorGlyph = makeGlyph("cursor", "CursorGlyph");
export const OpenSourceCLIsGlyph = makeGlyph("open-source-clis", "OpenSourceCLIsGlyph");
export const ChineseLabsGlyph = makeGlyph("chinese-labs", "ChineseLabsGlyph");
export const OtherGlyph = makeGlyph("other", "OtherGlyph");

const BY_FAMILY: Record<AgentFamily, React.FC<GlyphProps>> = {
  anthropic: AnthropicGlyph,
  openai: OpenAIGlyph,
  google: GoogleGlyph,
  "github-microsoft": GitHubMicrosoftGlyph,
  cursor: CursorGlyph,
  "open-source-clis": OpenSourceCLIsGlyph,
  "chinese-labs": ChineseLabsGlyph,
  other: OtherGlyph,
};

export const AgentGlyph: React.FC<AgentGlyphProps> = ({ family, ...props }) => {
  const Glyph = BY_FAMILY[family] ?? OtherGlyph;
  return <Glyph {...props} />;
};
