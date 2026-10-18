import { describe, expect, it } from "vitest";
import { mockSessions } from "../src/data/mockSessions";
import { marginaliaIn, renderFolio, screen, user } from "./helpers";

const { refactor, debugging, planning } = mockSessions;

describe("Folio blocks", () => {
  it("renders user prompts as headed paragraphs", () => {
    const { rows } = renderFolio(refactor);
    const heading = screen.getByRole("heading", {
      name: "Split src/payments.ts into an adapter for the gateway and a store for local",
    });
    expect(heading.closest("[data-block-kind='prompt']")).not.toBeNull();
    expect((heading.closest("[data-message-index]") as HTMLElement).dataset.messageIndex).toBe("0");
    expect(rows()).toHaveLength(refactor.messages.length);
  });

  it("renders assistant replies as body text with markdown", () => {
    const planningView = renderFolio(planning);
    const page = planningView.page();
    const h2 = page.querySelector("[data-block-kind='reply'] h2");
    const h3 = page.querySelector("[data-block-kind='reply'] h3");
    expect(h2?.textContent).toBe("Where it stands");
    expect(h3?.textContent).toBe("Risks");
    expect(page.querySelector("[data-block-kind='reply'] ul")).not.toBeNull();
    expect(page.querySelector("[data-block-kind='reply'] ol")).not.toBeNull();
    expect(page.querySelector("[data-block-kind='reply'] strong")).not.toBeNull();
    expect(page.querySelector("[data-block-kind='reply'] code")).not.toBeNull();
    expect(page.querySelector("[data-block-kind='reply'] em")).not.toBeNull();

    const refactorView = renderFolio(refactor);
    expect(refactorView.page().querySelector("[data-block-kind='reply'] blockquote")).not.toBeNull();
  });

  it("renders code blocks highlighted in the Observatory palette", () => {
    renderFolio(refactor);
    const code = screen.getByRole("region", { name: /code snippet/i });
    expect(code).toHaveAttribute("data-lang", "ts");
    expect(code.querySelector(".tok-key")).not.toBeNull();
    expect(code.querySelector(".tok-str")).not.toBeNull();
    expect(code.querySelector(".tok-com") || !code.textContent!.includes("//")).toBeTruthy();
    expect(code.textContent).toContain("createPendingStore");
  });

  it("renders system messages as folio notes", () => {
    renderFolio(refactor);
    const note = document.querySelector("[data-block-kind='system']")!;
    expect(note.textContent).toContain("4 files changed");
  });

  it("renders tool calls and file edits as marginalia", () => {
    renderFolio(refactor);
    const notes = document.querySelectorAll("[data-marginalia]");
    expect(notes).toHaveLength(refactor.toolCalls.length);
    expect(screen.getByText("read_file")).toBeInTheDocument();
    expect(screen.getAllByText(/edit_file/).length).toBeGreaterThan(2);
  });

  it("aligns every marginal note to the message row it happened under", () => {
    const { rows } = renderFolio(refactor);
    const all = rows();
    for (const row of all) {
      for (const note of marginaliaIn(row)) {
        const anchorSeq = Number(note.getAttribute("data-anchor-seq"));
        expect(Number(row.dataset.seq)).toBe(anchorSeq);
      }
    }
    // the read_file call (seq 3) sits in the row of the reply at seq 2
    const secondRow = all[1];
    expect(secondRow.dataset.seq).toBe("2");
    expect(marginaliaIn(secondRow).map((n) => n.getAttribute("data-tool"))).toEqual(["read_file"]);
    // planning: search_code (3) under reply 2, write_plan (5) under assistant 4
    const planRows = renderFolio(planning).rows();
    expect(marginaliaIn(planRows[1]).map((n) => n.getAttribute("data-tool"))).toEqual(["search_code"]);
    expect(marginaliaIn(planRows[2]).map((n) => n.getAttribute("data-tool"))).toEqual(["write_plan"]);
  });

  it("marks errors as vermilion marginal marks", () => {
    renderFolio(debugging);
    const errorNotes = document.querySelectorAll("[data-marginalia][data-error='true']");
    expect(errorNotes).toHaveLength(2);
    for (const note of errorNotes) {
      expect(note.getAttribute("class")).toContain("folio-note--error");
    }
    expect(screen.getAllByText(/address already in use/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("needs attention")).toHaveLength(2);
  });

  it("renders plans and to-do lists as checklists", async () => {
    const { page } = renderFolio(planning);
    const boxes = [...page().querySelectorAll<HTMLInputElement>(".folio-checklist__box")];
    // the live reader keeps a plan note to its first 5 items behind "more" (RV-DS compact notes), so the 6 from
    // the tool plan show 5 until the toggle is used; the 6 from the markdown task list in the reply always show
    expect(boxes).toHaveLength(11);
    await user.click(screen.getByRole("button", { name: /^Show \+1 more of / }));
    const all = [...page().querySelectorAll<HTMLInputElement>(".folio-checklist__box")];
    expect(all).toHaveLength(12);
    expect(all.filter((box) => box.checked)).toHaveLength(4);
    expect(screen.getAllByText("Build the mapping screen with a preview of the first ten rows")).toHaveLength(2);
    const list = screen.getByRole("list", { name: /plan/i });
    expect(list).toBeInTheDocument();
  });

  it("shows a footer with model and token usage", () => {
    renderFolio(refactor);
    // a labelled group, not a contentinfo landmark: inside the app the Folio sits within other landmarks
    const footer = screen.getByRole("group", { name: "Session details" });
    expect(screen.queryByRole("contentinfo")).toBeNull();
    expect(footer).toHaveTextContent("claude-sonnet-4.5");
    expect(footer).toHaveTextContent("41,230");
    expect(footer).toHaveTextContent("9,860");
    expect(footer).toHaveTextContent("7 turns");
  });

  it("keeps the parchment page on the ink background per theme", () => {
    const dark = renderFolio(refactor, { theme: "dark" });
    expect(dark.page().dataset.surface).toBe("parchment");
    expect(dark.container.querySelector("[data-theme='dark']")).not.toBeNull();

    const light = renderFolio(refactor, { theme: "light" });
    expect(light.page().dataset.surface).toBe("parchment");
    expect(light.container.querySelector("[data-theme='light']")).not.toBeNull();
    expect(light.container.querySelector("[data-theme='dark']")).toBeNull();
  });

  it("lets a reader collapse and expand a diff without losing alignment", async () => {
    renderFolio(refactor);
    const toggles = screen.getAllByRole("button", { name: /diff/i });
    expect(toggles).toHaveLength(4);
    const toggle = screen.getByRole("button", { name: /diff for payments\.ts/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector(".diff-line")).toBeNull();
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const lines = document.querySelectorAll(".diff-line");
    expect(lines.length).toBeGreaterThan(3);
    expect(document.querySelectorAll(".diff-line--add").length).toBeGreaterThan(0);
    expect(document.querySelectorAll(".diff-line--del").length).toBeGreaterThan(0);
    await user.click(toggle);
    expect(document.querySelector(".diff-line")).toBeNull();
  });

  it("keeps marginalia off when the reader asks for a plain page", () => {
    renderFolio(refactor, { marginalia: false });
    expect(document.querySelectorAll("[data-marginalia]")).toHaveLength(0);
  });

  it("hides the contents rail when asked", () => {
    renderFolio(refactor, { showContents: false });
    expect(screen.queryByRole("navigation", { name: /contents/i })).toBeNull();
  });

  it("never injects raw html from message text", () => {
    const evil = {
      ...debugging,
      messages: [
        {
          session_id: debugging.session.id,
          seq: 1,
          role: "assistant" as const,
          text: "<img src=x onerror=alert(1)>",
          at: 0,
        },
      ],
      toolCalls: [],
    };
    renderFolio(evil);
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
  });
});
