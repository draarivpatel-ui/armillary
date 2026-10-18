import { describe, it, expect, beforeEach } from "vitest";
import {
  sessions_query,
  search,
  resetArchiveClient,
  generateSyntheticSessions,
  formatDuration,
  formatDateHeading,
} from "../src/api/archive";

describe("Archive API Client and Mock Data", () => {
  beforeEach(() => {
    resetArchiveClient();
  });

  it("queries sessions with default pagination", async () => {
    const page = await sessions_query();
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.total).toBeGreaterThanOrEqual(page.items.length);
    expect(page.limit).toBe(50);
    expect(page.offset).toBe(0);

    const first = page.items[0];
    expect(first).toHaveProperty("id");
    expect(first).toHaveProperty("agent_id");
    expect(first).toHaveProperty("project_root");
    expect(first).toHaveProperty("title");
    expect(first).toHaveProperty("started_at");
    expect(first).toHaveProperty("turns");
    expect(first).toHaveProperty("usage");
    expect(first).toHaveProperty("provenance");
  });

  it("filters sessions by agent", async () => {
    const page = await sessions_query({ agent: "claude-code" });
    expect(page.items.length).toBeGreaterThan(0);
    page.items.forEach((s) => {
      expect(s.agent_id).toBe("claude-code");
    });
  });

  it("filters sessions by project", async () => {
    const page = await sessions_query({ project: "agent-hub" });
    expect(page.items.length).toBeGreaterThan(0);
    page.items.forEach((s) => {
      expect(s.project_root).toContain("agent-hub");
    });
  });

  it("filters sessions by status", async () => {
    const page = await sessions_query({ status: "done" });
    expect(page.items.length).toBeGreaterThan(0);
    page.items.forEach((s) => {
      expect(s.status).toBe("done");
    });
  });

  it("filters sessions by model", async () => {
    const page = await sessions_query({ model: "claude-3-5-sonnet" });
    expect(page.items.length).toBeGreaterThan(0);
    page.items.forEach((s) => {
      expect(s.model).toContain("claude-3-5-sonnet");
    });
  });

  it("filters sessions by date range (from and to)", async () => {
    const all = await sessions_query({ limit: 100 });
    const mid = all.items[Math.floor(all.items.length / 2)].started_at ?? 0;

    const pageFrom = await sessions_query({ from: mid });
    pageFrom.items.forEach((s) => {
      expect(s.started_at ?? 0).toBeGreaterThanOrEqual(mid);
    });

    const pageTo = await sessions_query({ to: mid });
    pageTo.items.forEach((s) => {
      expect(s.started_at ?? 0).toBeLessThanOrEqual(mid);
    });
  });

  it("supports pagination with limit and offset", async () => {
    const page1 = await sessions_query({ limit: 2, offset: 0 });
    const page2 = await sessions_query({ limit: 2, offset: 2 });

    expect(page1.items.length).toBe(2);
    expect(page2.items.length).toBe(2);
    expect(page1.items[0].id).not.toBe(page2.items[0].id);
  });

  it("searches prompts, tools, and files with ranked snippets", async () => {
    const hits = await search("contrast");
    expect(hits.length).toBeGreaterThan(0);

    const hit = hits[0];
    expect(hit).toHaveProperty("session_id");
    expect(hit).toHaveProperty("seq");
    expect(hit).toHaveProperty("kind");
    expect(hit).toHaveProperty("text");
    expect(hit.text).not.toContain("<mark>");
    expect(hit.highlights.length).toBeGreaterThan(0);
    for (const [a, b] of hit.highlights) expect(hit.text.slice(a, b).toLowerCase()).toBe("contrast");
    expect(hit).toHaveProperty("score");
    expect(hit.score).toBeGreaterThan(0);
    expect(hit).toHaveProperty("at");
  });

  it("filters search by agent and project", async () => {
    const hits = await search("archive", {
      agent: "codex-cli",
      project: "agent-hub",
    });
    hits.forEach((h) => {
      if (h.agent_id) expect(h.agent_id).toBe("codex-cli");
      if (h.project_root) expect(h.project_root).toContain("agent-hub");
    });
  });

  it("generates 10,000 synthetic sessions efficiently", () => {
    const start = performance.now();
    const largeDataset = generateSyntheticSessions(10000);
    const elapsed = performance.now() - start;

    expect(largeDataset.length).toBe(10000);
    expect(elapsed).toBeLessThan(1000); // Must generate 10k items well under 1 second
  });

  it("formats durations without em or en dashes", () => {
    const d1 = formatDuration(1000, 75000);
    expect(d1).toBe("1m 14s");
    expect(d1).not.toContain("—");
    expect(d1).not.toContain("–");

    const ongoing = formatDuration(1000, null);
    // No end time recorded is unknown, not "active": the archive cannot know the session is still running.
    expect(ongoing).toBe("No end recorded");
    expect(formatDuration(null, 5000)).toBe("Unknown");
  });

  it("formats date headings cleanly", () => {
    const heading = formatDateHeading(1776096000000);
    expect(heading).toBeTruthy();
    expect(heading).not.toContain("—");
    expect(heading).not.toContain("–");
  });
});
