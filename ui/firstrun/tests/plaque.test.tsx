// P3-3 / V-REG-6 (r2 fix round 1, asked first by R2-REV-4): the plaque says what Not now does to
// sessions that were already imported (they stay until Delete archive and reset).
import React, { act } from "react";
import { render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { ConsentPlaque } from "../src/host/ConsentPlaque";
import { FirstRun } from "../src/host/FirstRun";
import { T } from "../src/scene/instrument";
import { RecordedSource } from "../src/sources";
import { LOG } from "./helpers";

function stub2dContext(): CanvasRenderingContext2D {
  const target: Record<string, unknown> = {};
  const grad = { addColorStop: () => {} };
  return new Proxy(target, {
    get(_t, prop: string) {
      if (prop === "measureText") return (s: string) => ({ width: s.length * 7 });
      if (prop === "createLinearGradient" || prop === "createRadialGradient") return () => grad;
      if (prop === "createImageData" || prop === "getImageData")
        return (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
      if (prop === "createPattern") return () => ({});
      if (prop in target) return target[prop];
      return () => {};
    },
    set(_t, prop: string, v: unknown) {
      target[prop] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

describe("consent plaque", () => {
  it("says that Not now stops reading and keeps imported sessions until the archive is deleted", () => {
    const rigRef = React.createRef<HTMLDivElement>();
    render(<ConsentPlaque plan={null} interactive={true} onContinue={() => {}} onDecline={() => {}} rigRef={rigRef} />);
    expect(
      screen.getByText(
        /Not now stops reading: the live detector and any import about to start stop immediately; a file already being read finishes and nothing new is read\. Sessions already imported stay in the archive until you delete it\./,
      ),
    ).toBeTruthy();
  });

  it("positions the plaque rig on the very first frame it becomes visible (no one-frame flash)", async () => {
    const spy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockImplementation(((kind: string) => (kind === "2d" ? stub2dContext() : null)) as unknown as typeof HTMLCanvasElement.prototype.getContext);
    try {
      const { container } = render(<FirstRun source={new RecordedSource(LOG)} onComplete={() => {}} renderer="canvas2d" capture={true} />);
      await act(async () => {});
      expect(container.querySelector(".fr-plaque-rig")).toBeNull();

      // Advance to the first frame inside the plaque entrance window: only one frame renders here.
      const firstPlaqueMs = T.plaque[0] + 100;
      await act(async () => {
        void window.__armillaryFirstRun!.seek(firstPlaqueMs);
      });

      const frame = window.__armillaryFirstRun!.frame()!;
      expect(frame.plaque.visible).toBe(true);
      expect(frame.plaque.offsetY).not.toBe(0);

      const rig = container.querySelector<HTMLDivElement>(".fr-plaque-rig");
      expect(rig).not.toBeNull();
      expect(rig!.style.transform).toBe(
        `translate3d(0, ${frame.plaque.offsetY.toFixed(2)}px, 0) rotate(${frame.plaque.swing.toFixed(5)}rad)`,
      );
      expect(rig!.style.opacity).toBe(String(frame.plaque.alpha));
    } finally {
      spy.mockRestore();
    }
  });
});

