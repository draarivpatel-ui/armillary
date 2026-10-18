import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import fs from "fs";
import path from "path";
import { App } from "../src/App";

describe("Brand & Product Renaming to Armillary (FX3)", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("data-theme");
  });

  it("checks sidebar brand reads Armillary (engraved small caps via CSS) and keeps Orrery as the live view name", () => {
    render(<App />);

    const brand = screen.getByRole("heading", { name: /^armillary$/i, level: 1 });
    expect(brand).toBeInTheDocument();

    const nav = screen.getByRole("navigation", { name: "Observatory Views" });
    expect(within(nav).getByRole("button", { name: /Orrery/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Orrery/i, level: 2 })).toBeInTheDocument();
  });

  it("checks tauri.conf.json has productName Armillary, identifier com.armillary.app, and title Armillary", () => {
    const tauriConfigPath = path.resolve(__dirname, "../src-tauri/tauri.conf.json");
    const tauriConfig = JSON.parse(fs.readFileSync(tauriConfigPath, "utf-8"));

    expect(tauriConfig.productName).toBe("Armillary");
    expect(tauriConfig.identifier).toBe("com.armillary.app");
    expect(tauriConfig.app.windows[0].title).toBe("Armillary");
  });

  it("checks index.html title contains Armillary and no en or em dashes", () => {
    const indexPath = path.resolve(__dirname, "../index.html");
    const indexHtml = fs.readFileSync(indexPath, "utf-8");

    // Must contain Armillary in <title>
    expect(indexHtml).toMatch(/<title>Armillary<\/title>/i);

    // No em dash (—) or en dash (–)
    expect(indexHtml).not.toContain("—");
    expect(indexHtml).not.toContain("–");
  });

  it("theme control names both themes, Night and Day almanac, each with an engraved icon", async () => {
    render(<App />);
    const group = screen.getByRole("radiogroup", { name: "Theme" });
    const day = within(group).getByRole("radio", { name: /Day almanac/i });
    const night = within(group).getByRole("radio", { name: /Night/i });
    expect(day.querySelector("svg")).not.toBeNull();
    expect(night.querySelector("svg")).not.toBeNull();
    await userEvent.click(day);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});
