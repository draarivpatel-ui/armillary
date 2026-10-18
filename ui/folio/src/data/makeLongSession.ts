import type { Message, NormalizedSession, ToolCall } from "../types";

/** Deterministic synthetic session of any length, for virtualisation work. */
export function makeLongSession(messageCount: number, sessionId = "sess-long-01"): NormalizedSession {
  const startedAt = Date.parse("2026-10-06T00:00:00Z");
  const messages: Message[] = [];
  const toolCalls: ToolCall[] = [];
  let seq = 1;

  for (let i = 0; i < messageCount; i++) {
    const role = i % 3 === 0 ? "user" : "assistant";
    messages.push({
      session_id: sessionId,
      seq,
      role,
      text:
        role === "user"
          ? `Step ${i + 1}: check the worker queue and report what you find`
          : `Step ${i + 1}: looked at the queue. Depth is steady, no retries in the last window.`,
      at: startedAt + i * 1000,
    });
    seq += 1;
    if (i % 4 === 3) {
      toolCalls.push({
        session_id: sessionId,
        seq,
        name: i % 8 === 3 ? "run_tests" : "read_file",
        input_summary: `src/worker/queue_${i}.ts`,
        result_summary: i % 8 === 3 ? "84 passed, 0 failed" : "read 42 lines",
        files: [`/Users/harper/work/longrun/src/worker/queue_${i}.ts`],
        status: "ok",
        at: startedAt + i * 1000,
      });
      seq += 1;
    }
  }

  return {
    session: {
      id: sessionId,
      agent_id: "qwen-cli",
      project_root: "/Users/harper/work/longrun",
      title: "Long running sweep of the worker queue",
      started_at: startedAt,
      ended_at: startedAt + messageCount * 1000,
      model: "qwen-3.8-coder",
      status: "done",
      turns: Math.ceil(messageCount / 2),
      tokens_in: messageCount * 210,
      tokens_out: messageCount * 96,
      parent_id: null,
    },
    messages,
    toolCalls,
  };
}
