import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("Content text selection in App.css (Finding 22)", () => {
  const cssPath = path.resolve(__dirname, "../src/App.css");
  const cssContent = fs.readFileSync(cssPath, "utf-8");

  it("restores text selection for documents, code blocks, and paths instead of global blocking", () => {
    // Must contain explicit user-select: text (or -webkit-user-select: text) for content areas
    const hasContentTextSelection =
      cssContent.includes("user-select: text") ||
      cssContent.includes("-webkit-user-select: text");

    expect(hasContentTextSelection).toBe(true);

    // Specifically must restore user-select for folio reader / documents
    expect(cssContent).toMatch(/\.folio-document[^{]*\{[^}]*user-select:\s*text/s);

    // Must restore user-select for code blocks
    expect(cssContent).toMatch(/(\.code-block|pre|code)[^{]*\{[^}]*user-select:\s*text/s);
  });
});
