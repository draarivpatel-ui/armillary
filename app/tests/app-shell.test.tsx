import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../src/App";

const VIEWS = ["Orrery", "Almanac", "Folio", "Field Guide", "Switchboard", "Launchpad", "Search"];

function setUrl(search: string) {
  window.history.replaceState(null, "", `/${search}`);
}

describe("Armillary app shell (DS)", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("data-theme");
    window.localStorage.clear();
    setUrl("");
  });

  it("rail lists exactly the seven views, each with an engraved view icon, and no design gallery", () => {
    render(<App />);
    const nav = screen.getByRole("navigation", { name: "Observatory Views" });
    const buttons = within(nav).getAllByRole("button");
    expect(buttons.map((b) => b.querySelector(".rail-item__label")?.textContent)).toEqual(VIEWS);
    for (const b of buttons) {
      expect(b.querySelector("svg.obs-icon")).not.toBeNull();
      // view icons are no longer agent family glyphs
      expect(b.querySelector("svg.obs-glyph")).toBeNull();
    }
    expect(screen.queryByText(/Design Gallery/i)).toBeNull();
  });

  it("brand mark is the armillary sphere, not an agent glyph", () => {
    render(<App />);
    const brand = screen.getByRole("heading", { level: 1, name: /armillary/i });
    const banner = brand.closest(".rail__brand") as HTMLElement;
    expect(banner.querySelector("svg.obs-icon--armillary")).not.toBeNull();
    expect(banner.querySelector("svg.obs-glyph")).toBeNull();
  });

  it("shows no pricing or pass badge anywhere in the shell", () => {
    render(<App />);
    expect(screen.queryByText(/Observatory Pass/i)).toBeNull();
    expect(document.body.textContent ?? "").not.toMatch(/\$\d|pricing|upgrade|\bpro\b/i);
  });

  it("switches views from the rail and marks the active item", async () => {
    render(<App />);
    const nav = screen.getByRole("navigation", { name: "Observatory Views" });
    expect(within(nav).getByRole("button", { name: /Orrery/ })).toHaveAttribute("aria-current", "page");
    await userEvent.click(within(nav).getByRole("button", { name: /Almanac/ }));
    expect(within(nav).getByRole("button", { name: /Almanac/ })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("button", { name: /Orrery/ })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("heading", { name: /Almanac/i, level: 2 })).toBeInTheDocument();
  });

  it("has exactly one gilt marker element, which follows the active item", async () => {
    render(<App />);
    const nav = screen.getByRole("navigation", { name: "Observatory Views" });
    const markers = nav.querySelectorAll("[data-rail-marker]");
    expect(markers).toHaveLength(1);
    expect(markers[0]).toHaveAttribute("aria-hidden", "true");
    expect(markers[0]).toHaveAttribute("data-active-view", "orrery");
    await userEvent.click(within(nav).getByRole("button", { name: /Switchboard/ }));
    expect(nav.querySelectorAll("[data-rail-marker]")).toHaveLength(1);
    expect(nav.querySelector("[data-rail-marker]")).toHaveAttribute("data-active-view", "switchboard");
  });

  it("keyboard shortcuts 1 to 7 switch views, but not while typing or with modifiers", () => {
    render(<App />);
    const nav = screen.getByRole("navigation", { name: "Observatory Views" });
    VIEWS.forEach((name, i) => {
      fireEvent.keyDown(window, { key: String(i + 1) });
      expect(within(nav).getByRole("button", { name: new RegExp(name) })).toHaveAttribute("aria-current", "page");
    });
    fireEvent.keyDown(window, { key: "1", metaKey: true });
    expect(within(nav).getByRole("button", { name: /Search/ })).toHaveAttribute("aria-current", "page");
    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "2" });
    expect(within(nav).getByRole("button", { name: /Search/ })).toHaveAttribute("aria-current", "page");
    input.remove();
  });

  it("theme is a labelled two-way control (Night, Day almanac) that sets data-theme on <html> only", async () => {
    render(<App />);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    const group = screen.getByRole("radiogroup", { name: "Theme" });
    const night = within(group).getByRole("radio", { name: /Night/ });
    const day = within(group).getByRole("radio", { name: /Day almanac/ });
    expect(night).toHaveAttribute("aria-checked", "true");
    await userEvent.click(day);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(day).toHaveAttribute("aria-checked", "true");
    expect(document.querySelector(".app-shell")?.hasAttribute("data-theme")).toBe(false);
    expect(window.localStorage.getItem("armillary.theme")).toBe("light");
    await userEvent.click(night);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("honours ?theme=light and a stored theme", () => {
    setUrl("?theme=light");
    const { unmount } = render(<App />);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    unmount();
    setUrl("");
    window.localStorage.setItem("armillary.theme", "light");
    render(<App />);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("offers Replay the first run only when the first-run gate provides it", async () => {
    const { unmount } = render(<App />);
    expect(screen.queryByRole("button", { name: /Replay the first run/i })).toBeNull();
    unmount();
    const replay = vi.fn();
    render(<App onReplayFirstRun={replay} />);
    await userEvent.click(screen.getByRole("button", { name: /Replay the first run/i }));
    expect(replay).toHaveBeenCalledTimes(1);
  });

  it("shows a small Sample data mark only on presentation data", () => {
    const { unmount } = render(<App />);
    expect(screen.queryByText("Sample data")).toBeNull();
    unmount();
    const r2 = render(<App sampleData />);
    expect(screen.getByText("Sample data")).toBeInTheDocument();
    r2.unmount();
    setUrl("?presentation=1");
    render(<App />);
    expect(screen.getByText("Sample data")).toBeInTheDocument();
  });

  it("keeps the design gallery reachable in development with ?gallery=1, outside the rail", () => {
    setUrl("?gallery=1");
    render(<App />);
    const nav = screen.getByRole("navigation", { name: "Observatory Views" });
    expect(within(nav).queryByText(/Gallery/i)).toBeNull();
    expect(document.querySelector("[data-gallery-stage]")).not.toBeNull();
  });

  it("only one view is interactive after a switch (the leaving layer is removed or inert)", async () => {
    render(<App />);
    const nav = screen.getByRole("navigation", { name: "Observatory Views" });
    await userEvent.click(within(nav).getByRole("button", { name: /Almanac/ }));
    const live = document.querySelectorAll(".view-layer:not([inert])");
    expect(live).toHaveLength(1);
    expect(live[0]).toHaveAttribute("data-view", "almanac");
  });
});
