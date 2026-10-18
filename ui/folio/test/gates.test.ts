import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { mockSessionList, mockSessions } from "../src/data/mockSessions";

const here = dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx|css)$/.test(full)) out.push(full);
  }
  return out;
}

describe("review gates", () => {
  const files = sourceFiles(join(here, "../src"));

  it("reads every source file", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("makes no network calls from the library", () => {
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/\bfetch\s*\(/);
      expect(text, file).not.toMatch(/XMLHttpRequest/);
      expect(text, file).not.toMatch(/WebSocket/);
      expect(text, file).not.toMatch(/EventSource/);
      expect(text, file).not.toMatch(/navigator\.sendBeacon/);
    }
  });

  it("never names a credential file", () => {
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/auth\.json|\.credentials\.json|keychain/i);
    }
  });

  it("keeps em and en dashes out of the source", () => {
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/[–—−]/u);
    }
  });

  it("uses synthetic fixture data only", () => {
    expect(Object.values(mockSessions).map((s) => s.session.id)).toEqual([
      "sess-refactor-01",
      "sess-debug-01",
      "sess-plan-01",
    ]);
    const text = JSON.stringify(mockSessions);
    expect(text).not.toMatch(/sk-ant-[A-Za-z0-9]{8,}/);
    expect(text).not.toMatch(/api[_-]?key["']?\s*[:=]\s*["'][A-Za-z0-9]{16,}/i);
  });

  it("ships three rich mock sessions", () => {
    expect(mockSessionList).toHaveLength(3);
    const [refactor, debugging, planning] = mockSessionList;
    expect(refactor.messages.length).toBeGreaterThanOrEqual(7);
    expect(refactor.toolCalls.filter((c) => c.edits && c.edits.length > 0)).toHaveLength(4);
    expect(debugging.toolCalls.filter((c) => c.status === "error")).toHaveLength(2);
    expect(planning.toolCalls.filter((c) => c.items && c.items.length > 0)).toHaveLength(1);
  });
});
