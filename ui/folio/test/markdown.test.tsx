import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../src/markdown";
import { renderMarkdown } from "../src/markdown/render";
import { container, screen } from "./helpers";

describe("markdown subset parser", () => {
  it("parses headings at every level", () => {
    const blocks = parseMarkdown("# One\n\n## Two\n\n###### Six");
    expect(blocks.map((b) => b.type)).toEqual(["heading", "heading", "heading"]);
    expect(blocks[0]).toMatchObject({ level: 1, text: "One" });
    expect(blocks[2]).toMatchObject({ level: 6, text: "Six" });
  });

  it("parses paragraphs, lists, quotes and rules", () => {
    const blocks = parseMarkdown("First line\nwrapped.\n\n- a\n- b\n\n1. one\n2. two\n\n> note\n\n---");
    expect(blocks.map((b) => b.type)).toEqual([
      "paragraph",
      "list",
      "list",
      "quote",
      "rule",
    ]);
    expect(blocks[1]).toMatchObject({ ordered: false, items: [{ text: "a" }, { text: "b" }] });
    expect(blocks[2]).toMatchObject({ ordered: true, items: [{ text: "one" }, { text: "two" }] });
  });

  it("parses task list items into checklist entries", () => {
    const blocks = parseMarkdown("- [ ] build it\n- [x] ship it");
    expect(blocks[0]).toMatchObject({
      type: "checklist",
      items: [
        { text: "build it", done: false },
        { text: "ship it", done: true },
      ],
    });
  });

  it("keeps fenced code blocks with their language and raw body", () => {
    const blocks = parseMarkdown("```ts\nconst x = 1;\n// done\n```");
    expect(blocks[0]).toMatchObject({ type: "code", lang: "ts", text: "const x = 1;\n// done" });
  });

  it("parses inline marks", () => {
    const blocks = parseMarkdown("Use **bold**, _italic_, `code` and [docs](https://example.com).");
    const inline = (blocks[0] as { children: unknown[] }).children;
    const types = JSON.stringify(inline);
    expect(types).toContain("bold");
    expect(types).toContain("italic");
    expect(types).toContain("code");
    expect(types).toContain("link");
  });
});

describe("markdown renderer", () => {
  it("renders semantic elements", () => {
    container(
      renderMarkdown(
        "## Title\n\nA paragraph with **bold**.\n\n- [ ] open\n- [x] closed\n\n```json\n{\"a\": 1}\n```",
      ),
    );
    expect(screen.getByRole("heading", { name: "Title" }).tagName).toBe("H2");
    const items = screen.getAllByRole("listitem");
    expect(items.map((item) => item.textContent?.trim())).toEqual(["open", "closed"]);
    // a list item carries no accessible name, so the box itself is labelled
    expect(screen.getByRole("checkbox", { name: /open/ })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /closed/ })).toBeChecked();
    expect(screen.getByRole("region", { name: /code/i })).toBeInTheDocument();
  });

  it("highlights code with the palette token classes and no HTML injection", () => {
    container(renderMarkdown("```js\nconst risky = '<img src=bad>';\n```"));
    const code = screen.getByRole("region", { name: /code/i }).querySelector("code")!;
    expect(code.querySelector("img")).toBeNull();
    expect(code.textContent).toContain("const risky = '<img src=bad>';");
    expect(code.querySelector(".tok-key")?.textContent).toBe("const");
    expect(code.querySelector(".tok-str")).toBeTruthy();
  });
});
