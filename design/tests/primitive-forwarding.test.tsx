import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Tabs, TabList, Tab, TabPanel, Checkbox, TextField, FilterChip } from "../src/primitives";

describe("primitives forward attributes the demo tour and tests target", () => {
  it("Tab passes data-* attributes to its button", () => {
    render(
      <Tabs defaultValue="matrix">
        <TabList aria-label="Views">
          <Tab value="matrix" data-tab="matrix">Matrix</Tab>
          <Tab value="rules" data-tab="rules">Rules</Tab>
        </TabList>
        <TabPanel value="matrix">m</TabPanel>
        <TabPanel value="rules">r</TabPanel>
      </Tabs>,
    );
    expect(screen.getByRole("tab", { name: "Matrix" })).toHaveAttribute("data-tab", "matrix");
    expect(screen.getByRole("tab", { name: "Rules" })).toHaveAttribute("data-tab", "rules");
  });

  it("Checkbox passes data-* attributes to its native input", () => {
    render(<Checkbox label="Differences only" checked={false} onChange={() => {}} data-switchboard-differences-only="" />);
    expect(screen.getByRole("checkbox", { name: "Differences only" })).toHaveAttribute("data-switchboard-differences-only", "");
  });

  it("TextField is set in the UI face by default and in mono only when asked (paths)", () => {
    const { rerender } = render(<TextField aria-label="Filter" />);
    expect(screen.getByRole("textbox", { name: "Filter" })).not.toHaveClass("obs-text-field--mono");
    rerender(<TextField aria-label="Filter" mono />);
    expect(screen.getByRole("textbox", { name: "Filter" })).toHaveClass("obs-text-field--mono");
  });

  it("FilterChip passes data-* attributes to its button", () => {
    render(<FilterChip label="aurora-docs" selected={false} onToggle={() => {}} data-root="/projects/aurora-docs" />);
    expect(screen.getByRole("button", { name: /aurora-docs/ })).toHaveAttribute("data-root", "/projects/aurora-docs");
  });
});
