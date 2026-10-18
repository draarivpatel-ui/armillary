import { describe, it, expect, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { OrreryView } from "../src/views/Orrery";
import { fetchLiveList, getMockLiveList } from "../src/api/live";

type W = Window & {
  __armillaryTour?: { registerLocator?: (kind: string, fn: (id: string) => DOMRect | null) => () => void };
  __armillaryLocators?: Record<string, ((id: string) => DOMRect | null) | undefined>;
};

describe("Orrery Live View & Client Integration", () => {
  afterEach(() => {
    delete (window as W).__armillaryTour;
    delete (window as W).__armillaryLocators;
  });

  it("provides typed mock live data via live client", async () => {
    const data = await fetchLiveList();
    expect(data.projects.length).toBe(4);
    expect(data.sessions.length).toBeGreaterThan(0);
    expect(data.telemetry.activePlanets).toBeGreaterThan(0);
    expect(data.telemetry.needsYou).toBeGreaterThanOrEqual(1);
    const roots = data.projects.map((p) => p.name);
    expect(roots).toContain("agent-hub");
    expect(roots).toContain("astrolabe-core");
    expect(roots).toContain("quantum-sim");
    expect(roots).toContain("compiler-pass");
  });

  it("renders the Orrery with the shared view chrome, true figures and the measured stage", async () => {
    render(<OrreryView />);
    const heading = screen.getByRole("heading", { name: /^The Orrery$/, level: 2 });
    expect(heading.closest("section")).toHaveAttribute("aria-labelledby", heading.id);

    const canvas = document.querySelector("canvas");
    expect(canvas).toBeInTheDocument();
    expect(canvas).toHaveAttribute("aria-label", "Orrery celestial observatory view of live agent sessions");
    expect(document.querySelector("[data-orrery-stage]")).toContainElement(canvas as HTMLElement);

    const mock = getMockLiveList();
    const figures = screen.getByRole("group", { name: /live sessions/i });
    expect(within(figures).getByText(String(mock.telemetry.needsYou))).toBeInTheDocument();
    expect(within(figures).getByText(/need(s)? you/)).toBeInTheDocument();
    expect(within(figures).getByText("working")).toBeInTheDocument();

    // no pills, no decorative telemetry panel, no unverifiable orbit-period claim
    expect(document.querySelector(".obs-badge")).toBeNull();
    expect(screen.queryByText("Observatory Live Telemetry")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Orbit mechanics|40s to 120s/);
  });

  it("explains the picture in one quiet legend with the keyboard keys", () => {
    render(<OrreryView />);
    const legend = screen.getByRole("note", { name: /how to read the orrery/i });
    expect(legend).toHaveTextContent(/agent.s colour/i);
    expect(legend).toHaveTextContent(/needs you/i);
    expect(legend.querySelectorAll("kbd").length).toBeGreaterThanOrEqual(2);
  });

  it("registers a planet locator with the tour bridge when it offers one", () => {
    const registered: Array<[string, (id: string) => DOMRect | null]> = [];
    let unregistered = 0;
    (window as W).__armillaryTour = {
      registerLocator: (kind, fn) => {
        registered.push([kind, fn]);
        return () => {
          unregistered += 1;
        };
      },
    };
    const view = render(<OrreryView />);
    expect(registered.map(([kind]) => kind)).toContain("planet");
    view.unmount();
    expect(unregistered).toBeGreaterThanOrEqual(1);
  });

  it("falls back to window.__armillaryLocators when the bridge has no registry yet", () => {
    const view = render(<OrreryView />);
    expect(typeof (window as W).__armillaryLocators?.planet).toBe("function");
    view.unmount();
    expect((window as W).__armillaryLocators?.planet).toBeUndefined();
  });

  it("exposes the live layout on the stage for the first-run handoff, and announces it", () => {
    const seen: unknown[] = [];
    const onReady = (e: Event) => seen.push((e as CustomEvent).detail);
    document.addEventListener("orrery:ready", onReady);
    const view = render(<OrreryView />);
    const stage = document.querySelector("[data-orrery-stage]") as HTMLElement & {
      __armillaryOrrery?: { getLayout: () => unknown; layoutAt: (t: number) => { suns: unknown[] }; now: () => number };
    };
    expect(typeof stage.__armillaryOrrery?.getLayout).toBe("function");
    expect(typeof stage.__armillaryOrrery?.layoutAt).toBe("function");
    expect(typeof stage.__armillaryOrrery?.now).toBe("function");
    expect(stage.__armillaryOrrery!.layoutAt(5000).suns.length).toBeGreaterThan(0);
    expect(seen.length).toBeGreaterThanOrEqual(1);
    view.unmount();
    expect(stage.__armillaryOrrery).toBeUndefined();
    document.removeEventListener("orrery:ready", onReady);
  });

  it("contains no em or en dashes in user-facing text", () => {
    const data = getMockLiveList();
    const allTitles = data.sessions.map((s) => s.title).join(" ");
    expect(allTitles).not.toMatch(/[—–]/);
    render(<OrreryView />);
    expect(document.body.textContent).not.toMatch(/[—–]/);
  });
});
