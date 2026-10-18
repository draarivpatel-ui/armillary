import { describe, expect, it } from "vitest";
import { highlight } from "../src/highlight";

describe("syntax highlighting", () => {
  it("tags keywords, strings, comments and numbers", () => {
    const tokens = highlight('const n = 42; // note\nconst s = "hi"', "ts");
    const kinds = tokens.map((t) => t.kind);
    expect(kinds).toContain("keyword");
    expect(kinds).toContain("number");
    expect(kinds).toContain("comment");
    expect(kinds).toContain("string");
    expect(tokens.map((t) => t.text).join("")).toBe('const n = 42; // note\nconst s = "hi"');
  });

  it("keeps every language lossless", () => {
    const samples: [string, string][] = [
      ["fn main() { let x: u32 = 1; }", "rust"],
      ["def go():\n    return None", "python"],
      ['{"a": 1, "b": true}', "json"],
      ["npm run build -- --watch", "bash"],
      ["unknown language body", "klingon"],
    ];
    for (const [source, lang] of samples) {
      expect(highlight(source, lang).map((t) => t.text).join("")).toBe(source);
    }
  });

  it("marks punctuation separately from identifiers so the palette can pick it up", () => {
    const tokens = highlight("call(a, b)", "js");
    expect(tokens.some((t) => t.kind === "function")).toBe(true);
    expect(tokens.some((t) => t.kind === "punctuation")).toBe(true);
  });

  it("does not treat a word inside a string as a keyword", () => {
    const tokens = highlight('const s = "return the money";', "js");
    const string = tokens.find((t) => t.kind === "string")!;
    expect(string.text).toBe('"return the money"');
  });
});
