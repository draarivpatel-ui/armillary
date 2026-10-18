import { describe, expect, it } from "vitest";
import { buildBlocks } from "../src/blockify";
import { mockSessions } from "../src/data/mockSessions";

const keys = Object.keys(mockSessions);

describe("buildBlocks", () => {
  it("covers all three mock sessions and every message becomes a block", () => {
    expect(keys).toEqual(["refactor", "debugging", "planning"]);
    for (const key of keys) {
      const session = mockSessions[key];
      const { blocks } = buildBlocks(session.messages, session.toolCalls);
      expect(blocks).toHaveLength(session.messages.length);
      expect(blocks.every((block) => block.messageId.startsWith("m-"))).toBe(true);
      // blocks keep message order
      expect(blocks.map((b) => b.seq)).toEqual(session.messages.map((m) => m.seq));
    }
  });

  it("classifies roles and gives user prompts a heading title", () => {
    const { blocks } = buildBlocks(mockSessions.refactor.messages, mockSessions.refactor.toolCalls);
    expect(blocks[0].kind).toBe("prompt");
    expect(blocks[0].title).toBe("Split src/payments.ts into an adapter for the gateway and a store for local");
    expect(blocks[1].kind).toBe("reply");
    expect(blocks[5].kind).toBe("prompt");
    expect(blocks[blocks.length - 1]?.kind).toBe("system");
  });

  it("attaches every tool call as marginalia anchored to the block before it", () => {
    const { blocks, marginalia } = buildBlocks(mockSessions.refactor.messages, mockSessions.refactor.toolCalls);
    expect(marginalia).toHaveLength(mockSessions.refactor.toolCalls.length);
    for (const note of marginalia) {
      expect(note.anchorIndex).not.toBeNull();
      expect(note.anchorSeq).not.toBeNull();
      const anchor = blocks[note.anchorIndex!];
      expect(anchor.seq).toBe(note.anchorSeq);
      // the note never attaches to a later message than itself
      expect(note.seq).toBeGreaterThan(anchor.seq);
    }
    // seq 3 read_file sits under reply seq 2
    const read = marginalia.find((n) => n.seq === 3)!;
    expect(blocks[read.anchorIndex!].seq).toBe(2);
  });

  it("marks errors and plans", () => {
    const { marginalia } = buildBlocks(mockSessions.debugging.messages, mockSessions.debugging.toolCalls);
    const failed = marginalia.filter((note) => note.isError);
    expect(failed.map((n) => n.seq)).toEqual([3, 9]);
    expect(failed[0].error).toContain("address already in use");

    const plan = buildBlocks(mockSessions.planning.messages, mockSessions.planning.toolCalls).marginalia.find(
      (note) => note.plan,
    );
    expect(plan!.plan!.items).toHaveLength(6);
    expect(plan!.plan!.items.filter((item) => item.done)).toHaveLength(2);
  });

  it("carries edits with diffs and files", () => {
    const { marginalia } = buildBlocks(mockSessions.refactor.messages, mockSessions.refactor.toolCalls);
    const edit = marginalia.find((note) => note.edits.length > 0)!;
    expect(edit.edits[0].path).toContain("adapter.ts");
    expect(edit.edits[0].lines.length).toBeGreaterThan(3);
  });

  it("finds checklists inside assistant text", () => {
    const { blocks } = buildBlocks(mockSessions.refactor.messages, mockSessions.refactor.toolCalls);
    const planBlock = blocks[1];
    expect(planBlock.checklists?.[0].items).toHaveLength(4);
  });
});
