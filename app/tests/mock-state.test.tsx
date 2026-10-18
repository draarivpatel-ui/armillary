import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { FieldGuideView } from "../src/views/FieldGuide/FieldGuideView";
import { Launchpad } from "../src/views/Launchpad/Launchpad";
import { SwitchboardView } from "../src/views/SwitchboardView";
import { FolioView } from "../src/views/FolioView";

describe("Mock State & Core Absence Guarding (Finding 21)", () => {
  beforeEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
    delete (window as any).__TAURI__;
  });

  describe("Field Guide View when core is absent", () => {
    it("labels the data as Demo once in the head and disables Scan now", async () => {
      render(<FieldGuideView />);

      // Exactly one quiet Demo data mark, no Demo pills on the figures or the entries
      expect(screen.getAllByText("Demo data")).toHaveLength(1);
      expect(screen.queryByText(/\(Demo\)/)).not.toBeInTheDocument();

      // The "Scan now" button must be disabled because core is absent
      const scanBtn = screen.getByRole("button", { name: /Scan/i });
      expect(scanBtn).toBeDisabled();

      // Installed mock agents still read as installed, and the registry figures come from the data
      const cards = await screen.findAllByTestId(/^agent-card-/);
      expect(cards.length).toBeGreaterThan(0);
      expect(cards.find((card) => card.textContent?.includes("Installed"))).toBeDefined();
    });
  });

  describe("Launchpad View when core is absent", () => {
    it("says once that the terminal is unavailable, never presents PTY Ready as real, and disables launch with the reason", async () => {
      render(<Launchpad />);

      // One calm line near the Launch button, no pills in the head
      expect(await screen.findByText("Terminal unavailable in this window")).toBeInTheDocument();
      expect(screen.queryByText(/^PTY Ready$/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/Demo data|PTY Offline|PTY Unavailable/i)).not.toBeInTheDocument();

      // Launch button must be disabled when the core is absent
      const launchBtn = await screen.findByRole("button", { name: /^Launch/ });
      expect(launchBtn).toBeDisabled();
    });
  });

  describe("Unfinished actions in Switchboard and Folio views", () => {
    it("labels the Switchboard fixture as demo data and offers no write actions", async () => {
      render(<SwitchboardView />);
      expect(await screen.findByText(/Demo data/i)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Align/i })).toBeNull();
    });

    it("labels the mock document as demo data in the Folio", async () => {
      render(<FolioView />);
      expect(await screen.findByText("Demo data")).toBeInTheDocument();
      // R2-REV-2: no Export buttons in 0.1.0 (the feature is planned).
      expect(screen.queryByRole("button", { name: /Export Markdown/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /Redact & Share/i })).toBeNull();
    });
  });
});
