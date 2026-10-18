import { describe, expect, it } from "vitest";
import { exportHtml, exportMarkdown } from "../src/export";
import { mockSessions } from "../src/data/mockSessions";
import { screen, renderFolio, user } from "./helpers";

const { refactor, debugging, planning } = mockSessions;

describe("export to Markdown", () => {
  it("writes prompts as headings and replies as body text", () => {
    const out = exportMarkdown(refactor);
    expect(out).toContain("## Split `src/payments.ts` into an adapter");
    expect(out).toMatch(/#{2,4} Plan\b/);
    expect(out).toContain("I will do this in three steps.");
  });

  it("keeps code fences with their language", () => {
    expect(exportMarkdown(refactor)).toContain("```ts\nexport function createPendingStore");
    expect(exportMarkdown(debugging)).toContain("```py");
  });

  it("writes plans as task lists and tools as marginal notes", () => {
    const out = exportMarkdown(planning);
    expect(out).toContain("- [x] Reproduce their file locally");
    expect(out).toContain("- [ ] Build the mapping screen");
    expect(out).toContain("[note] search_code:");
    expect(out).toContain("6 items, 2 done");
  });

  it("includes diffs as fenced diff blocks", () => {
    const out = exportMarkdown(refactor);
    expect(out).toContain("```diff\n--- /dev/null");
    expect(out).toContain("+export function createAdapter(gateway: Gateway)");
  });

  it("marks errors and closes with the usage footer", () => {
    const out = exportMarkdown(debugging);
    expect(out).toContain("[!] run_command:");
    expect(out).toContain("address already in use");
    expect(out).toContain("**model** gpt-5.2-codex");
    expect(exportMarkdown(refactor)).toContain("41,230 in / 9,860 out");
  });
});

describe("export to a self contained HTML file", () => {
  it("produces a complete document with inlined styles and no external references", () => {
    const out = exportHtml(refactor);
    expect(out.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(out).toContain("<style>");
    expect(out).toContain("</html>");
    expect(out).not.toMatch(/<link\b/i);
    expect(out).not.toMatch(/<script\b/i);
    expect(out).not.toMatch(/@import/i);
    expect(out).not.toMatch(/url\(["']?https?:/i);
  });

  it("carries the palette tokens for the chosen theme", () => {
    const dark = exportHtml(refactor, { theme: "dark" });
    expect(dark).toContain("#0B1220");
    expect(dark).toContain("#F1E8D5");
    const light = exportHtml(refactor, { theme: "light" });
    expect(light).toContain("#F3EBDA");
  });

  it("renders every block type into HTML", () => {
    const plan = exportHtml(planning);
    expect(plan).toContain("<h2");
    expect(plan).toContain('class="folio-checklist"');
    expect(plan).toContain("data-marginalia");
    expect(plan).toContain("gemini-3.8-flash");

    const code = exportHtml(refactor);
    expect(code).toContain("<pre");
    expect(code).toContain('class="tok-');
    expect(code).toContain('class="diff-line diff-line--add"');
  });

  it("escapes markup coming from message text", () => {
    const out = exportHtml({
      ...refactor,
      messages: [
        { ...refactor.messages[0], text: "danger <script>alert(1)</script> & friends" },
      ],
    });
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toContain("<script>alert(1)</script>");
  });
});

describe("redaction pass", () => {
  it("masks paths, emails, tokens and keys in the Markdown export", () => {
    const out = exportMarkdown(debugging, { redact: true });
    expect(out).not.toContain("sk-live-9fd2c7a41b7e4a0c");
    expect(out).not.toContain("mailer@beacon.dev");
    expect(out).not.toContain("/Users/harper/");
    expect(out).toContain("[masked path]");
    expect(out).toContain("[masked email]");
    expect(out).toContain("[masked key]");
  });

  it("masks the same patterns in the HTML export", () => {
    const out = exportHtml(debugging, { redact: true });
    expect(out).not.toContain("sk-live-9fd2c7a41b7e4a0c");
    expect(out).not.toContain("mailer@beacon.dev");
    expect(out).not.toContain("/Users/harper/");
  });

  it("leaves the text alone when redaction is off", () => {
    const out = exportMarkdown(debugging, { redact: false });
    expect(out).toContain("sk-live-9fd2c7a41b7e4a0c");
    expect(out).toContain("mailer@beacon.dev");
    expect(out).toContain("/Users/harper/.local/state/beacon/collector.log");
  });

  it("masks bearer tokens, AWS keys and api_key pairs", async () => {
    const { redact } = await import("../src/redact");
    expect(redact("Authorization: Bearer abcdef123456")).toBe("Authorization: [masked token]");
    expect(redact("key AKIAIOSFODNN7EXAMPLE done")).toBe("key [masked key] done");
    expect(redact('api_key = "sk-proj-aabbccddeeff0011"')).toBe("api_key = [masked key]");
    expect(redact("mailto: somebody@example.org")).toBe("mailto: [masked email]");
    expect(redact("C:\\Users\\harper\\work\\ledger")).toBe("[masked path]");
    expect(redact("~/work/ledger/src/payments.ts")).toBe("[masked path]");
    expect(redact("nothing sensitive here")).toBe("nothing sensitive here");
  });

  it("keeps project roots out of exports but shows redaction in the page only when asked", () => {
    const out = exportMarkdown(refactor, { redact: true });
    expect(out).not.toContain("/Users/harper/work/ledger");
    renderFolio(refactor);
    // the reader page itself is not redacted
    expect(screen.getByRole("textbox", { name: /find/i })).toBeInTheDocument();
    expect(screen.getAllByText(/read_file/).length).toBeGreaterThan(0);
  });

  it("offers a redacted export from the toolbar when the export build flag is on", async () => {
    renderFolio(refactor, { exportEnabled: true });
    await user.click(screen.getByRole("button", { name: /export markdown/i }));
    expect(screen.getByRole("status", { name: /export/i })).toHaveTextContent(/markdown/i);
    await user.click(screen.getByRole("button", { name: /export html/i }));
    expect(screen.getByRole("status", { name: /export/i })).toHaveTextContent(/html/i);
    const toggle = screen.getByRole("checkbox", { name: /redact/i });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    expect(toggle).not.toBeChecked();
  });
});
