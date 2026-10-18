import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { NormalizedSession } from "../src/types";
import { Folio } from "../src/index";
import { user } from "./user";

export { screen, render, user, act };

/** Render markdown output on its own, inside a Folio page wrapper. */
export function container(node: ReactNode): HTMLElement {
  const { container } = render(<div className="folio-page">{node}</div>);
  return container.querySelector(".folio-page") as HTMLElement;
}

export interface RenderOptions {
  theme?: "dark" | "light";
  virtualize?: boolean | "auto";
  height?: number;
  showContents?: boolean;
  marginalia?: boolean;
  itemEstimateHeight?: number;
  overscan?: number;
  defaultViewportHeight?: number;
  exportEnabled?: boolean;
}

export function renderFolio(session: NormalizedSession, options: RenderOptions = {}) {
  const view = render(
    <Folio
      session={session.session}
      messages={session.messages}
      toolCalls={session.toolCalls}
      theme={options.theme ?? "dark"}
      virtualize={options.virtualize ?? "auto"}
      height={options.height ?? 900}
      showContents={options.showContents ?? true}
      marginalia={options.marginalia ?? true}
      itemEstimateHeight={options.itemEstimateHeight ?? 120}
      overscan={options.overscan ?? 5}
      defaultViewportHeight={options.defaultViewportHeight ?? 800}
      exportEnabled={options.exportEnabled}
    />,
  );
  return {
    ...view,
    container: view.container,
    page: () => view.container.querySelector<HTMLElement>(".folio-page") as HTMLElement,
    scrollArea: () => view.container.querySelector<HTMLElement>("[data-folio-scroll]") as HTMLElement,
    rows: () =>
      [...view.container.querySelectorAll<HTMLElement>("[data-message-index]")].sort(
        (a, b) => Number(a.dataset.messageIndex) - Number(b.dataset.messageIndex),
      ),
  };
}

/** Give an element a layout height that jsdom cannot compute. */
export function setViewport(element: HTMLElement, height: number, scrollTop = 0) {
  Object.defineProperty(element, "clientHeight", { configurable: true, value: height });
  Object.defineProperty(element, "scrollTop", { configurable: true, writable: true, value: scrollTop });
}

export async function scrollTo(element: HTMLElement, top: number) {
  Object.defineProperty(element, "scrollTop", { configurable: true, writable: true, value: top });
  await act(async () => {
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

export function marginaliaIn(row: Element) {
  return [...row.querySelectorAll("[data-marginalia]")];
}

export function findInput(): HTMLInputElement {
  return screen.getByRole("textbox", { name: /find/i }) as HTMLInputElement;
}

export function tocNav(): HTMLElement {
  return screen.getByRole("navigation", { name: /contents/i }) as HTMLElement;
}

export function tocLinks(): HTMLElement[] {
  return [...tocNav().querySelectorAll<HTMLElement>("[role='listitem'] > a")];
}
