import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { AgentGlyph, AGENT_FAMILIES } from "../src";

describe("Observatory Agent Glyphs", () => {
  it("includes all 8 agent families from SPEC section 3.2", () => {
    expect(AGENT_FAMILIES).toEqual([
      "anthropic",
      "openai",
      "google",
      "github-microsoft",
      "cursor",
      "open-source-clis",
      "chinese-labs",
      "other",
    ]);
  });

  AGENT_FAMILIES.forEach((family) => {
    it(`renders ${family} glyph at 16px and 24px`, () => {
      const { container: c16, unmount: u16 } = render(
        <AgentGlyph family={family} size={16} />
      );
      const svg16 = c16.querySelector("svg");
      expect(svg16).toBeInTheDocument();
      expect(svg16).toHaveAttribute("width", "16");
      expect(svg16).toHaveAttribute("height", "16");
      expect(svg16).toHaveClass(`obs-glyph--${family}`);
      u16();

      const { container: c24 } = render(
        <AgentGlyph family={family} size={24} />
      );
      const svg24 = c24.querySelector("svg");
      expect(svg24).toBeInTheDocument();
      expect(svg24).toHaveAttribute("width", "24");
      expect(svg24).toHaveAttribute("height", "24");
      expect(svg24).toHaveClass(`obs-glyph--${family}`);
    });
  });
});
