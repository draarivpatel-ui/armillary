import { describe, it, expect, afterEach } from "vitest";
import { render, waitFor, fireEvent, cleanup } from "@testing-library/react";
import axe from "axe-core";
import { App } from "../src/App";

// Accessibility gate: every view in both themes. jsdom cannot compute colours, so the color-contrast
// rule is off here; an axe pass in a real browser covers it.
const VIEWS = ["orrery", "almanac", "folio", "field-guide", "switchboard", "launchpad", "search"] as const;
const THEMES = ["dark", "light"] as const;
const FOCUSABLE =
  'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

async function openView(theme: string, view: string): Promise<HTMLElement> {
  window.history.replaceState(null, "", `/?theme=${theme}`);
  const utils = render(<App />);
  const btn = utils.container.querySelector<HTMLElement>(`nav[aria-label="Observatory Views"] [data-view-key="${view}"]`);
  expect(btn).not.toBeNull();
  fireEvent.click(btn!);
  let layer: HTMLElement | null = null;
  await waitFor(
    () => {
      layer = document.querySelector<HTMLElement>(`.view-layer[data-view="${view}"]:not([inert])`);
      expect(layer).not.toBeNull();
      // the leaving layer (if any) must be gone or inert before auditing
      expect(document.querySelectorAll(".view-layer:not([inert])").length).toBe(1);
    },
    { timeout: 3000 },
  );
  // let the view settle (async fixture loads)
  await new Promise((r) => setTimeout(r, 50));
  return layer!;
}

function textOf(el: Element): string {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

function accessibleName(el: Element): string {
  const label = el.getAttribute("aria-label")?.trim();
  if (label) return label;
  const by = el.getAttribute("aria-labelledby");
  if (by) {
    const t = by.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((n) => textOf(n!)).join(" ").trim();
    if (t) return t;
  }
  if (el.id) {
    const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (lab && textOf(lab)) return textOf(lab);
  }
  const wrapping = el.closest("label");
  if (wrapping && textOf(wrapping)) return textOf(wrapping);
  const title = el.getAttribute("title")?.trim();
  if (title) return title;
  if (el instanceof HTMLInputElement && ["button", "submit", "reset"].includes(el.type) && el.value) return el.value;
  const text = textOf(el);
  if (text) return text;
  // images / svgs inside with their own label
  const inner = el.querySelector("img[alt]:not([alt=''])");
  if (inner) return inner.getAttribute("alt")!;
  const svgTitle = el.querySelector("svg > title");
  if (svgTitle && textOf(svgTitle)) return textOf(svgTitle);
  const innerLabel = el.querySelector("[aria-label]");
  return innerLabel?.getAttribute("aria-label")?.trim() ?? "";
}

function describeNode(el: Element): string {
  const id = el.id ? `#${el.id}` : "";
  const cls = typeof el.className === "string" && el.className ? `.${el.className.split(/\s+/).slice(0, 2).join(".")}` : "";
  return `<${el.tagName.toLowerCase()}${id}${cls}>`;
}

describe("a11y gate: axe-core per view and theme", () => {
  afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute("data-theme");
  });

  for (const theme of THEMES) {
    for (const view of VIEWS) {
      it(`axe: ${view} (${theme}) has no serious or critical violations`, async () => {
        await openView(theme, view);
        expect(document.documentElement.getAttribute("data-theme")).toBe(theme);
        const results = await axe.run(document.body, {
          resultTypes: ["violations"],
          rules: { "color-contrast": { enabled: false } },
        });
        const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
        if (bad.length) {
          const report = bad
            .map(
              (v) =>
                `${v.id} [${v.impact}] x${v.nodes.length}: ${v.help}\n` +
                v.nodes.slice(0, 3).map((n) => `    ${n.target.join(" ")}`).join("\n"),
            )
            .join("\n");
          // eslint-disable-next-line no-console
          console.error(`axe failures for ${view} (${theme}):\n${report}`);
        }
        expect(bad.map((v) => v.id)).toEqual([]);
      }, 30000);

      it(`keyboard: ${view} (${theme}) focusable elements all have an accessible name`, async () => {
        const layer = await openView(theme, view);
        const focusables = Array.from(layer.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
          (el) =>
            !(el as HTMLButtonElement).disabled &&
            el.getAttribute("aria-hidden") !== "true" &&
            !(el instanceof HTMLInputElement && el.type === "hidden") &&
            !el.closest("[hidden], [inert]"),
        );
        const unnamed = focusables.filter((el) => !accessibleName(el)).map(describeNode);
        expect(unnamed).toEqual([]);
      }, 30000);
    }
  }
});
