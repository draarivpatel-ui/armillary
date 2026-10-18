import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exportHtml, exportMarkdown } from "../src/export";
import { inlineText, parseInline, parseMarkdown, type Block, type Inline } from "../src/markdown";
import { renderBlocks, renderMarkdown } from "../src/markdown/render";
import type { NormalizedSession } from "../src/types";
import { container } from "./helpers";

/** Every attribute that can make a webview navigate, fetch or run something. */
const ACTIVE_ATTRIBUTES = /^(href|src|srcset|action|formaction|xlink:href|poster|data|background|ping|style|on.*)$/i;

function renderText(source: string): HTMLElement {
  return container(renderMarkdown(source));
}

function renderInline(children: Inline[]): HTMLElement {
  const block: Block = { type: "paragraph", text: "", children };
  return container(renderBlocks([block], { keyPrefix: "x" }));
}

function expectInert(root: HTMLElement) {
  expect(root.querySelector("a")).toBeNull();
  expect(root.querySelector("img")).toBeNull();
  expect(root.querySelector("script")).toBeNull();
  expect(root.querySelector("iframe, object, embed, form, link, style, svg, video, audio, source")).toBeNull();
  for (const el of root.querySelectorAll("*")) {
    for (const attr of el.getAttributeNames()) {
      expect(attr, `<${el.tagName.toLowerCase()} ${attr}>`).not.toMatch(ACTIVE_ATTRIBUTES);
    }
  }
}

describe("raw HTML in Markdown stays visible text", () => {
  const hostile = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    '<a href="javascript:alert(1)">x</a>',
    "<iframe src=https://evil.example></iframe>",
    '<svg onload="alert(1)"></svg>',
  ];

  for (const payload of hostile) {
    it(`paragraph: ${payload}`, () => {
      const root = renderText(`before ${payload} after`);
      expectInert(root);
      expect(root.textContent).toContain(payload);
    });

    it(`inline code: ${payload}`, () => {
      const root = renderText(`\`${payload}\``);
      expectInert(root);
      expect(root.querySelector("code.inline-code")?.textContent).toBe(payload);
    });

    it(`code block: ${payload}`, () => {
      const root = renderText(`\`\`\`html\n${payload}\n\`\`\``);
      expectInert(root);
      expect(root.querySelector("code")?.textContent).toBe(payload);
    });

    it(`heading, list, quote and checklist: ${payload}`, () => {
      const root = renderText(`# ${payload}\n\n- ${payload}\n\n> ${payload}\n\n- [ ] ${payload}`);
      expectInert(root);
      expect(root.textContent?.split(payload).length).toBeGreaterThanOrEqual(5);
    });
  }
});

describe("links never become anchors", () => {
  const safe = [
    "https://example.com/a?b=c#d",
    "http://example.com",
    "HTTPS://EXAMPLE.COM/UP",
    "mailto:someone@example.com",
  ];

  for (const href of safe) {
    it(`shows ${href} as visible, non-clickable text`, () => {
      const root = renderText(`see [the docs](${href}) now`);
      expectInert(root);
      const link = root.querySelector(".folio-link");
      expect(link).not.toBeNull();
      expect(link?.querySelector(".folio-link__url")?.textContent).toBe(` (${href})`);
      expect(link?.textContent).toContain("the docs");
      expect(link?.textContent).toContain(href);
      expect(root.textContent).toContain("see ");
    });
  }

  const unsafe = [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "data:text/html;base64,PHNjcmlwdD4=",
    "file:///etc/passwd",
    "vbscript:msgbox(1)",
    "./relative/path",
    "../up/one",
    "/absolute/path",
    "//evil.example/x",
    "#fragment",
    "ftp://example.com/x",
    "tel:+15551234567",
    "",
  ];

  for (const href of unsafe) {
    it(`renders ${JSON.stringify(href)} as inert text`, () => {
      const root = renderText(`open [click me](${href}) please`);
      expectInert(root);
      expect(root.querySelector(".folio-link")).toBeNull();
      expect(root.textContent).toContain("click me");
    });
  }

  const sneaky = [
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "java\r\nscript:alert(1)",
    " javascript:alert(1)",
    "\u0000javascript:alert(1)",
    "\u0001java\u0002script:alert(1)",
    "jav" + String.fromCharCode(0x200b) + "ascript:alert(1)",
    String.fromCharCode(0xa0) + "javascript:alert(1)",
    "data\t:text/html,hi",
    "not a url at all",
    "http://",
    "https:///nohost",
  ];

  for (const href of sneaky) {
    it(`treats the node href ${JSON.stringify(href)} as inert`, () => {
      const root = renderInline([{ type: "link", text: "gotcha", href }]);
      expectInert(root);
      expect(root.querySelector(".folio-link")).toBeNull();
      expect(root.textContent).toContain("gotcha");
    });
  }

  it("normalises whitespace and control characters hidden inside an accepted scheme", () => {
    const root = renderInline([{ type: "link", text: "ok", href: "  ht\ttps://example.com/x\n" }]);
    expectInert(root);
    expect(root.querySelector(".folio-link__url")?.textContent).toBe(" (https://example.com/x)");
  });

  it("keeps links usable inside bold and italic marks", () => {
    const root = renderText("**[a](https://example.com)** and _[b](javascript:alert(1))_");
    expectInert(root);
    expect(root.querySelectorAll(".folio-link")).toHaveLength(1);
    expect(root.querySelector("strong .folio-link")).not.toBeNull();
    expect(root.querySelector("em")?.textContent).toContain("b");
  });
});

describe("images never load", () => {
  it("parses ![alt](src) into an image node of its own", () => {
    expect(parseInline("![a cat](https://example.com/cat.png)")).toEqual([
      { type: "image", alt: "a cat", src: "https://example.com/cat.png" },
    ]);
    expect(parseInline("hi ![](x.png)!")).toEqual([
      { type: "text", text: "hi " },
      { type: "image", alt: "", src: "x.png" },
      { type: "text", text: "!" },
    ]);
  });

  it("leaves a plain exclamation mark and a plain link alone", () => {
    expect(parseInline("wow! [d](https://x.example)")).toEqual([
      { type: "text", text: "wow! " },
      { type: "link", text: "d", href: "https://x.example" },
    ]);
    expect(parseInline("![alt] no source")).toEqual([{ type: "text", text: "![alt] no source" }]);
  });

  const sources = [
    "https://tracker.example/pixel.png?u=1",
    "http://tracker.example/pixel.png",
    "data:image/png;base64,iVBORw0KGgo=",
    "data:image/svg+xml,<svg/onload=alert(1)>",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "./local.png",
    "//evil.example/x.png",
  ];

  for (const src of sources) {
    it(`shows a placeholder for ${src}`, () => {
      const root = renderText(`![diagram](${src})`);
      expectInert(root);
      const placeholder = root.querySelector(".folio-image-placeholder");
      expect(placeholder).not.toBeNull();
      expect(placeholder?.getAttribute("role")).toBe("img");
      expect(placeholder?.textContent).toBe("[image: diagram]");
      expect(root.innerHTML).not.toContain("example");
      expect(root.innerHTML).not.toContain("passwd");
    });
  }

  it("uses [image] when there is no alt text and escapes a hostile alt", () => {
    const empty = renderText("![](https://tracker.example/p.png)");
    expect(empty.querySelector(".folio-image-placeholder")?.textContent).toBe("[image]");
    const hostile = renderText("![<img src=x onerror=alert(1)>](https://tracker.example/p.png)");
    expectInert(hostile);
    expect(hostile.querySelector(".folio-image-placeholder")?.textContent).toBe("[image: <img src=x onerror=alert(1)>]");
  });

  it("keeps titles and exports sensible through inlineText", () => {
    expect(inlineText(parseInline("see ![a cat](x.png) and ![](y.png)"))).toBe("see [image: a cat] and [image]");
    expect(inlineText(parseInline("[the docs](https://example.com)"))).toBe("the docs");
  });
});

describe("source never reaches dangerouslySetInnerHTML", () => {
  it("no component in ui/folio/src uses it", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name) && /dangerouslySetInnerHTML|\.innerHTML\s*=/.test(readFileSync(path, "utf8"))) {
          offenders.push(path);
        }
      }
    };
    walk(join(__dirname, "..", "src"));
    expect(offenders).toEqual([]);
  });
});

describe("very long lines", () => {
  const cases: [string, string][] = [
    ["200,000 plain characters", "word ".repeat(40_000)],
    ["200,000 characters without spaces", "a".repeat(200_000)],
    ["50,000 open square brackets", "[".repeat(50_000)],
    ["50,000 asterisks after a word", "x " + "*".repeat(50_000)],
    ["50,000 backticks after a word", "x " + "`".repeat(50_000)],
    ["25,000 spaced underscores", "x " + "_ ".repeat(25_000)],
    ["25,000 spaced asterisks", "x " + "* ".repeat(25_000)],
    ["16,000 unclosed italics", "x " + "*a ".repeat(16_000)],
    ["12,000 unclosed bold marks", "x " + "**a ".repeat(12_000)],
    ["20,000 image openers", "x ![".repeat(20_000)],
    ["12,500 dangling link openers", "[a](".repeat(12_500)],
    ["12,500 dangling image openers", "![a](".repeat(10_000)],
    ["50,000 bracketed words", "[x ".repeat(16_000)],
  ];

  for (const [name, line] of cases) {
    it(`parses ${name} quickly`, () => {
      const started = performance.now();
      const blocks = parseMarkdown(line);
      const elapsed = performance.now() - started;
      expect(blocks.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(1000);
    });
  }

  it("parses a run of brackets as one plain text node", () => {
    expect(parseInline("[".repeat(50_000))).toEqual([{ type: "text", text: "[".repeat(50_000) }]);
  });

  it("renders a 200,000 character line and a long fenced line without hanging", () => {
    const started = performance.now();
    const root = renderText(`${"x".repeat(200_000)}\n\n\`\`\`\n${"y ".repeat(5_000)}\n\`\`\``);
    expect(root.textContent?.length).toBeGreaterThan(200_000);
    expect(performance.now() - started).toBeLessThan(3000);
  });
});

const hostileSession: NormalizedSession = {
  session: {
    id: "sess-hostile",
    agent_id: '"><script>alert(4)</script>',
    project_root: "/Users/h/work/ledger",
    title: "</title><script>alert(1)</script><img src=x onerror=alert(2)>",
    started_at: 1_700_000_000_000,
    ended_at: 1_700_000_600_000,
    model: "<b onmouseover=alert(5)>model</b>",
    status: "done",
    turns: 2,
    tokens_in: 1,
    tokens_out: 2,
    parent_id: null,
  },
  messages: [
    {
      session_id: "sess-hostile",
      seq: 1,
      role: "user",
      text: "Look at <script>alert(3)</script> and [x](javascript:alert(1)) and ![p](https://tracker.example/p.png)",
      at: 1_700_000_000_000,
    },
    {
      session_id: "sess-hostile",
      seq: 2,
      role: "assistant",
      text: [
        "Here is [a link](https://example.com/page) and [data](data:text/html,<script>1</script>) and [rel](../x).",
        "",
        "![chart](data:image/png;base64,AAAA) and <img src=https://tracker.example/q.png>",
        "",
        "```html",
        "<script src=https://evil.example/x.js></script>",
        "```",
      ].join("\n"),
      at: 1_700_000_100_000,
    },
  ],
  toolCalls: [
    {
      session_id: "sess-hostile",
      seq: 2,
      name: '"><img src=x onerror=alert(6)>',
      input_summary: "cat <script>alert(7)</script>",
      result_summary: "<iframe src=https://evil.example></iframe>",
      files: ['/tmp/"><script>alert(8)</script>.ts'],
      edits: [
        {
          path: "src/a.ts",
          diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+<script>alert(9)</script>",
        },
      ],
    },
  ],
};

function parseDocument(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("HTML export of hostile input", () => {
  for (const redact of [true, false]) {
    describe(`redact: ${redact}`, () => {
      const html = exportHtml(hostileSession, { redact });
      const doc = parseDocument(html);

      it("starts the head with a Content-Security-Policy meta tag", () => {
        const first = doc.head.firstElementChild;
        expect(first?.tagName).toBe("META");
        expect(first?.getAttribute("http-equiv")?.toLowerCase()).toBe("content-security-policy");
        expect(first?.getAttribute("content")).toBe(
          "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
        );
        const cspAt = html.indexOf('http-equiv="Content-Security-Policy"');
        expect(cspAt).toBeGreaterThan(-1);
        expect(cspAt).toBeLessThan(html.indexOf("<style>"));
      });

      it("has no script, image, frame or link element anywhere", () => {
        expect(doc.querySelectorAll("script, img, iframe, object, embed, form, link, svg, video, audio, source, base")).toHaveLength(0);
        expect(html).not.toMatch(/<script/i);
        expect(html).not.toMatch(/<img/i);
      });

      it("has no anchor with a non-fragment href and no href or src from the source", () => {
        for (const a of doc.querySelectorAll("a")) {
          expect(a.getAttribute("href") ?? "").toMatch(/^#/);
        }
        expect(doc.querySelectorAll("[src], [srcset], [action], [formaction], [poster]")).toHaveLength(0);
        for (const el of doc.querySelectorAll("*")) {
          for (const name of el.getAttributeNames()) {
            expect(name, `<${el.tagName.toLowerCase()} ${name}>`).not.toMatch(/^on/i);
            expect(el.getAttribute(name) ?? "", `<${el.tagName.toLowerCase()} ${name}>`).not.toMatch(/https?:\/\//i);
          }
        }
      });

      it("shows the hostile strings as text", () => {
        expect(doc.title).toBe(hostileSession.session.title);
        expect(doc.body.textContent).toContain("<script>alert(3)</script>");
        expect(doc.body.textContent).toContain("javascript:alert(1)");
        expect(doc.body.textContent).toContain("[image: p]");
        expect(doc.body.textContent).toContain("[image: chart]");
        expect(doc.body.textContent).toContain("<script src=https://evil.example/x.js></script>");
        expect(doc.body.textContent).toContain("https://example.com/page");
      });
    });
  }

  it("keeps the theme attribute inside the closed set", () => {
    const html = exportHtml(hostileSession, { theme: '"><script>alert(1)</script>' as never });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain('<body data-theme="dark">');
    expect(exportHtml(hostileSession, { theme: "light" })).toContain('<body data-theme="light">');
  });
});

describe("Markdown export of hostile input", () => {
  it("passes message text through verbatim: it is the archive's own Markdown, so nothing is added or removed", () => {
    const out = exportMarkdown(hostileSession, { redact: false });
    expect(out).toContain("Look at <script>alert(3)</script> and [x](javascript:alert(1))");
    expect(out.startsWith("# ")).toBe(true);
    expect(out).toContain("**model** <b onmouseover=alert(5)>model</b>");
  });

  it("cannot be broken out of a diff fence by backticks inside a file edit", () => {
    const session: NormalizedSession = {
      ...hostileSession,
      toolCalls: [
        {
          ...hostileSession.toolCalls[0],
          edits: [
            {
              path: "src/a.ts",
              diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n ```\n+![x](https://tracker.example/p.png)\n ```",
            },
          ],
        },
      ],
    };
    const out = exportMarkdown(session, { redact: false });
    const opening = /^(`{3,})diff$/m.exec(out);
    expect(opening).not.toBeNull();
    const fence = opening![1];
    const closing = new RegExp(`^${fence}$`, "m");
    const start = (opening!.index ?? 0) + opening![0].length;
    const end = out.slice(start).search(closing) + start;
    expect(out.slice(start, end)).toContain("![x](https://tracker.example/p.png)");
    expect(fence.length).toBeGreaterThan(3);
  });
});
