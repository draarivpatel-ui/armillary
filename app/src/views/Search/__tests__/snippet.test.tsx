import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Snippet, snippetSegments } from "../snippet";

// The core returns a hit as plain text plus [start, end) highlight ranges in UTF-16 code units
// (the archive's FTS5 markers are private-use sentinels that never reach the UI). Nothing is HTML.

const seg = (text: string, marked: boolean) => ({ text, marked });

describe("snippetSegments", () => {
  it("splits on the highlight ranges only", () => {
    expect(snippetSegments("a b c", [[2, 3]])).toEqual([seg("a ", false), seg("b", true), seg(" c", false)]);
    expect(snippetSegments("x", [[0, 1]])).toEqual([seg("x", true)]);
    expect(snippetSegments("plain", [])).toEqual([seg("plain", false)]);
    expect(snippetSegments("", [])).toEqual([]);
  });

  it("handles several hits and merges adjacent ones", () => {
    expect(snippetSegments("a and bc", [[0, 1], [6, 7], [7, 8]])).toEqual([
      seg("a", true),
      seg(" and ", false),
      seg("bc", true),
    ]);
  });

  it("uses UTF-16 offsets, so text after a non-BMP character lines up", () => {
    expect(snippetSegments("\u{1F600} radar", [[3, 8]])).toEqual([seg("\u{1F600} ", false), seg("radar", true)]);
  });

  it("never throws on unsorted, overlapping, empty or out of range ranges and stays flat", () => {
    expect(snippetSegments("abcdef", [[4, 99], [0, 2], [1, 3], [5, 5], [-4, -1]])).toEqual([
      seg("abc", true),
      seg("d", false),
      seg("ef", true),
    ]);
    const long = "x".repeat(5000);
    const many = Array.from({ length: 1000 }, (_, i) => [i * 3, i * 3 + 2] as [number, number]);
    const out = snippetSegments(long, many);
    expect(out.map((p) => p.text).join("")).toBe(long);
  });

  it("treats a literal <mark> in the content as content, never as a highlight", () => {
    const text = "he wrote <mark>bold</mark> and found it";
    const at = text.lastIndexOf("found");
    expect(snippetSegments(text, [[at, at + 5]])).toEqual([
      seg("he wrote <mark>bold</mark> and ", false),
      seg("found", true),
      seg(" it", false),
    ]);
  });
});

describe("Snippet", () => {
  it("renders hits as mark elements with text children", () => {
    const { container } = render(<Snippet text="the quick fox" highlights={[[4, 9]]} />);
    const marks = container.querySelectorAll("mark");
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe("quick");
    expect(marks[0].children).toHaveLength(0);
    expect(container.textContent).toBe("the quick fox");
  });

  const hostile = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    '<a href="javascript:alert(1)">x</a>',
    "&lt;script&gt;",
    "&amp; &#60;b&#62;",
    "<iframe src=https://evil.example></iframe>",
    '<svg onload="alert(1)"></svg>',
    "<mark>fake</mark>",
  ];

  for (const payload of hostile) {
    it(`shows ${payload} as inert text, inside and outside a hit`, () => {
      const text = `before ${payload} ${payload} after`;
      const start = "before ".length + payload.length + 1;
      const { container } = render(<Snippet text={text} highlights={[[start, start + payload.length]]} />);
      expect(container.querySelector("script, img, a, iframe, svg")).toBeNull();
      for (const el of container.querySelectorAll("*")) {
        expect(el.tagName).toBe("MARK");
        expect(el.getAttributeNames()).toEqual([]);
        expect(el.children).toHaveLength(0);
      }
      expect(container.textContent).toBe(text);
      expect(container.querySelectorAll("mark")).toHaveLength(1);
    });
  }

  it("renders a literal <mark> from the content as visible text, not a highlight", () => {
    const { container } = render(<Snippet text="he wrote <mark>bold</mark> and <b>more</b>" highlights={[]} />);
    expect(container.querySelectorAll("*")).toHaveLength(0);
    expect(container.textContent).toBe("he wrote <mark>bold</mark> and <b>more</b>");
  });
});

describe("Search view source", () => {
  it("no longer builds HTML from snippets", () => {
    const source = readFileSync(join(__dirname, "..", "Search.tsx"), "utf8");
    expect(source).not.toMatch(/dangerouslySetInnerHTML/);
    expect(source).not.toMatch(/sanitizeSnippet/);
    expect(source).toMatch(/<Snippet\b/);
    expect(source).toMatch(/highlights=\{/);
  });
});
