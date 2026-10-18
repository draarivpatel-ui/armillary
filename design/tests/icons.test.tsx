import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

import {
  OrreryIcon,
  AlmanacIcon,
  FolioIcon,
  FieldGuideIcon,
  SwitchboardIcon,
  LaunchpadIcon,
  SearchIcon,
  VIEW_ICONS,
  ViewIcon,
  ArmillaryMark,
  DayIcon,
  NightIcon,
  ReplayIcon,
  ChevronDownIcon,
  CheckIcon,
  CloseIcon,
} from "../src/icons";

const EXPECTED_VIEW_KEYS = [
  "orrery",
  "almanac",
  "folio",
  "field-guide",
  "switchboard",
  "launchpad",
  "search",
];

const ALL_ICONS: Array<[string, React.FC<{ size?: number; title?: string }>]> = [
  ["OrreryIcon", OrreryIcon],
  ["AlmanacIcon", AlmanacIcon],
  ["FolioIcon", FolioIcon],
  ["FieldGuideIcon", FieldGuideIcon],
  ["SwitchboardIcon", SwitchboardIcon],
  ["LaunchpadIcon", LaunchpadIcon],
  ["SearchIcon", SearchIcon],
  ["ArmillaryMark", ArmillaryMark],
  ["DayIcon", DayIcon],
  ["NightIcon", NightIcon],
  ["ReplayIcon", ReplayIcon],
  ["ChevronDownIcon", ChevronDownIcon],
  ["CheckIcon", CheckIcon],
  ["CloseIcon", CloseIcon],
];

describe("Observatory icon set", () => {
  it("VIEW_ICONS has exactly the 7 view keys", () => {
    expect(Object.keys(VIEW_ICONS).sort()).toEqual([...EXPECTED_VIEW_KEYS].sort());
  });

  for (const key of EXPECTED_VIEW_KEYS) {
    describe(`view icon ${key}`, () => {
      const Icon = VIEW_ICONS[key as keyof typeof VIEW_ICONS];

      it("renders one svg with obs-icon and obs-icon--<key> classes", () => {
        const { container } = render(<Icon />);
        const svgs = container.querySelectorAll("svg");
        expect(svgs).toHaveLength(1);
        const svg = svgs[0];
        expect(svg).toHaveClass("obs-icon");
        expect(svg).toHaveClass(`obs-icon--${key}`);
      });

      it("uses the 24 unit grid, default size 20, and is decorative without a title", () => {
        const { container } = render(<Icon />);
        const svg = container.querySelector("svg");
        expect(svg).toHaveAttribute("viewBox", "0 0 24 24");
        expect(svg).toHaveAttribute("width", "20");
        expect(svg).toHaveAttribute("height", "20");
        expect(svg).toHaveAttribute("aria-hidden", "true");
        expect(svg).not.toHaveAttribute("role");
      });
    });
  }

  it("with a title the svg is an img with that accessible name and no aria-hidden", () => {
    const { container } = render(<OrreryIcon title="Orrery" />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("role", "img");
    expect(svg).toHaveAttribute("aria-label", "Orrery");
    expect(svg).not.toHaveAttribute("aria-hidden");
  });

  it("size={32} sets width and height to 32", () => {
    const { container } = render(<SearchIcon size={32} />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("width", "32");
    expect(svg).toHaveAttribute("height", "32");
  });

  describe("ArmillaryMark (brand mark on the 32 unit grid)", () => {
    it("uses viewBox 0 0 32 32, default size 32, and the armillary class", () => {
      const { container } = render(<ArmillaryMark />);
      const svgs = container.querySelectorAll("svg");
      expect(svgs).toHaveLength(1);
      const svg = svgs[0];
      expect(svg).toHaveAttribute("viewBox", "0 0 32 32");
      expect(svg).toHaveAttribute("width", "32");
      expect(svg).toHaveAttribute("height", "32");
      expect(svg).toHaveClass("obs-icon--armillary");
      expect(svg).toHaveAttribute("aria-hidden", "true");
    });
  });

  it("ViewIcon name=\"search\" renders the search icon", () => {
    const viewed = render(<ViewIcon name="search" />).container.querySelector("svg");
    const direct = render(<SearchIcon />).container.querySelector("svg");
    expect(viewed).toHaveClass("obs-icon--search");
    expect(viewed?.outerHTML).toBe(direct?.outerHTML);
  });

  it("no icon hard-codes a colour: every stroke and fill is currentColor or none", () => {
    const violations: string[] = [];
    for (const [name, Icon] of ALL_ICONS) {
      const { container, unmount } = render(<Icon />);
      const nodes = [container.querySelector("svg"), ...Array.from(container.querySelectorAll("svg *"))];
      for (const node of nodes) {
        for (const attr of ["stroke", "fill"]) {
          const value = node?.getAttribute(attr);
          if (value !== null && value !== undefined && value !== "currentColor" && value !== "none") {
            violations.push(`${name}: <${node?.tagName}> ${attr}="${value}"`);
          }
        }
      }
      unmount();
    }
    expect(violations).toEqual([]);
  });
});
