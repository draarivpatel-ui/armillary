"""Hero sessions for Codex CLI, Gemini CLI, Cline and OpenCode."""

from .model import Sess, asst, at, bash, edit, glob, grep, read, todo, user, write


def bucket_refill():
    lib_old = '''    pub fn merge_remote(&mut self, remote_tokens: f64, now: Instant) {
        self.refill(now);
        // another replica reported how many tokens it still sees; keep the smaller view
        self.tokens = self.tokens.min(remote_tokens) + self.pending_refund;
        self.pending_refund = 0.0;
    }
'''
    lib_new = '''    pub fn merge_remote(&mut self, remote_tokens: f64, now: Instant) {
        self.refill(now);
        // another replica reported how many tokens it still sees; keep the smaller view
        let merged = self.tokens.min(remote_tokens) + self.pending_refund;
        // refunds may top the bucket up, never past what the burst allows
        self.tokens = merged.min(self.capacity as f64);
        self.pending_refund = 0.0;
    }
'''
    return Sess(
        key="hero/codex-nexus-bucket-refill", agent="codex-cli", project="nexus-gateway", hero=True,
        start=at("2026-10-01", "15:40"), minutes=48, model="gpt-6.1",
        turns=[
            user("In staging the token bucket rate limiter hands out about 1.3x the configured burst after a long idle gap, but only on replicas that sync with Redis. "
                 "Find the bug in crates/limiter, add a regression test first, and keep the public API as it is."),
            asst("I'll look at where tokens can be added to a bucket, since overshoot means something skips the capacity clamp.", [
                grep("tokens", "crates/limiter/src", "crates/limiter/src/bucket.rs:9:    tokens: f64,\ncrates/limiter/src/bucket.rs:27:            self.tokens -= n as f64;\ncrates/limiter/src/bucket.rs:38:        self.tokens = (self.tokens + elapsed.as_secs_f64() * self.refill_per_s as f64).min(self.capacity as f64);\ncrates/limiter/src/lib.rs:96:    pub fn merge_remote(&mut self, remote_tokens: f64, now: Instant) {\ncrates/limiter/src/lib.rs:99:        self.tokens = self.tokens.min(remote_tokens) + self.pending_refund;"),
                read("crates/limiter/src/lib.rs", '''impl Limiter {
    pub fn check(&mut self, key: &str, n: u64, now: Instant) -> Decision {
        let bucket = self.buckets.entry(key.to_owned()).or_insert_with(|| Bucket::new(self.burst, self.refill_per_s));
        if bucket.try_take(n, now) {
            Decision::Allow
        } else {
            Decision::Deny { retry_after: bucket.wait_for(n) }
        }
    }

    pub fn refund(&mut self, key: &str, n: u64) {
        if let Some(b) = self.buckets.get_mut(key) {
            b.pending_refund += n as f64;
        }
    }

''' + lib_old, start=88, limit=26),
            ]),
            asst("`merge_remote` adds `pending_refund` after the `min`, and unlike `refill` it never clamps to `capacity`. After an idle gap `refill` fills the bucket to the burst, and a refund of a few tokens then pushes it past that. I'll write the failing test first and share the plan.", [
                todo(
                    ("Write a regression test for refunds after an idle gap", "in_progress", "Writing a regression test for refunds after an idle gap"),
                    ("Clamp merged tokens to the bucket capacity", "pending", "Clamping merged tokens to the bucket capacity"),
                    ("Run the limiter tests and clippy", "pending", "Running the limiter tests and clippy"),
                ),
                edit("crates/limiter/src/lib.rs",
                     "    #[test]\n    fn refill_caps_at_capacity() {",
                     "    #[test]\n    fn idle_gap_then_merge_never_exceeds_capacity() {\n        let t0 = Instant::now();\n        let mut l = Limiter::new(10, 5);\n        assert_eq!(l.check(\"k\", 10, t0), Decision::Allow);\n        l.refund(\"k\", 3);\n        // a long idle gap refills to the burst, then the replica sync applies the refund\n        let later = t0 + Duration::from_secs(120);\n        l.merge_remote(\"k\", 10.0, later);\n        let mut allowed = 0;\n        while l.check(\"k\", 1, later) == Decision::Allow {\n            allowed += 1;\n        }\n        assert_eq!(allowed, 10, \"bucket handed out more than its burst\");\n    }\n\n    #[test]\n    fn refill_caps_at_capacity() {"),
                bash("cargo test -p nexus-limiter",
                     '''   Compiling nexus-limiter v0.9.4 (/Users/fictional-dev/projects/nexus-gateway/crates/limiter)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 2.71s
     Running unittests src/lib.rs (target/debug/deps/nexus_limiter-6c1d2f0b8e4a7a19)

running 10 tests
test bucket::tests::burst_is_capped ... ok
test bucket::tests::idle_time_is_measured ... ok
test tests::refill_caps_at_capacity ... ok
test tests::refill_rate_is_respected ... ok
test tests::take_more_than_capacity_fails ... ok
test tests::concurrent_takes_do_not_oversell ... ok
test tests::zero_refill_never_recovers ... ok
test tests::clock_going_backwards_is_ignored ... ok
test tests::large_take_is_rejected ... ok
test tests::idle_gap_then_merge_never_exceeds_capacity ... FAILED

failures:

---- tests::idle_gap_then_merge_never_exceeds_capacity stdout ----
thread 'tests::idle_gap_then_merge_never_exceeds_capacity' panicked at crates/limiter/src/lib.rs:214:9:
assertion `left == right` failed: bucket handed out more than its burst
  left: 13
 right: 10

failures:
    tests::idle_gap_then_merge_never_exceeds_capacity

test result: FAILED. 9 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.04s''', error=True),
            ]),
            asst("Reproduced exactly: 13 allowed against a burst of 10, which is the 1.3x from staging. Now the fix: clamp the merged value to `capacity`, so a refund can top the bucket up but never past the burst.", [
                edit("crates/limiter/src/lib.rs", lib_old, lib_new),
                todo(
                    ("Write a regression test for refunds after an idle gap", "completed", "Writing a regression test for refunds after an idle gap"),
                    ("Clamp merged tokens to the bucket capacity", "completed", "Clamping merged tokens to the bucket capacity"),
                    ("Run the limiter tests and clippy", "in_progress", "Running the limiter tests and clippy"),
                ),
                bash("cargo test -p nexus-limiter",
                     '''   Compiling nexus-limiter v0.9.4 (/Users/fictional-dev/projects/nexus-gateway/crates/limiter)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 2.64s
     Running unittests src/lib.rs (target/debug/deps/nexus_limiter-6c1d2f0b8e4a7a19)

running 10 tests
test bucket::tests::burst_is_capped ... ok
test bucket::tests::idle_time_is_measured ... ok
test tests::refill_caps_at_capacity ... ok
test tests::refill_rate_is_respected ... ok
test tests::take_more_than_capacity_fails ... ok
test tests::concurrent_takes_do_not_oversell ... ok
test tests::zero_refill_never_recovers ... ok
test tests::clock_going_backwards_is_ignored ... ok
test tests::large_take_is_rejected ... ok
test tests::idle_gap_then_merge_never_exceeds_capacity ... ok

test result: ok. 10 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.04s'''),
                bash("cargo clippy -p nexus-limiter --all-targets -- -D warnings",
                     "    Checking nexus-limiter v0.9.4 (/Users/fictional-dev/projects/nexus-gateway/crates/limiter)\n    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1.12s"),
                bash("git diff --stat", " crates/limiter/src/lib.rs | 24 ++++++++++++++++++++++--\n 1 file changed, 22 insertions(+), 2 deletions(-)"),
            ]),
            asst("Fixed. The limiter tests pass (10 of 10, including the new regression test) and clippy is clean with `-D warnings`.\n\n"
                 "**Root cause:** `Limiter::merge_remote` computed `min(local, remote) + pending_refund` and stored it without the capacity clamp that `Bucket::refill` applies. After a long idle gap the bucket was already full, so any pending refund pushed it past the burst. Only replicas that sync with Redis call `merge_remote`, which is why single replicas looked fine.\n\n"
                 "```rust\nlet merged = self.tokens.min(remote_tokens) + self.pending_refund;\nself.tokens = merged.min(self.capacity as f64);\n```\n\n"
                 "The public API did not change. One thing I did not touch: `refund` itself still lets `pending_refund` grow without bound if `merge_remote` is never called on a replica. That is harmless now that the merge clamps, but a cap there would be tidier if you want it as a follow-up."),
        ],
    )


def allocator_churn():
    runner_old = '''    pub fn run(&mut self, groups: &[RowGroup]) -> Result<Stats> {
        let mut stats = Stats::default();
        for group in groups {
            for chunk in group.chunks() {
                let mut buf = Vec::new();
                chunk.decode_into(&mut buf)?;
                stats.rows += self.sink.push(&buf)?;
            }
        }
        Ok(stats)
    }'''
    runner_new = '''    pub fn run(&mut self, groups: &[RowGroup]) -> Result<Stats> {
        let mut stats = Stats::default();
        // one scratch buffer for the whole run: decode_into clears it, capacity is kept
        let mut buf = Vec::with_capacity(self.opts.max_chunk_bytes);
        for group in groups {
            for chunk in group.chunks() {
                buf.clear();
                chunk.decode_into(&mut buf)?;
                stats.rows += self.sink.push(&buf)?;
            }
        }
        Ok(stats)
    }'''
    return Sess(
        key="hero/gemini-vortex-allocator", agent="gemini-cli", project="vortex-pipeline", hero=True,
        start=at("2026-10-02", "14:30"), minutes=72, model="gemini-3.8-pro",
        turns=[
            user("Profile the memory allocator churn in the batch runner of the parquet zero-copy deserializer. Throughput dropped about 18% after the dictionary page work and "
                 "I suspect we allocate per chunk again. Find it, fix it if it is what I think, and show me numbers before and after."),
            asst("I'll read the batch runner first, then measure allocations with the DHAT profile build so we are not guessing.", [
                read("crates/reader/src/batch.rs", '''pub struct BatchRunner<S: Sink> {
    sink: S,
    opts: RunnerOptions,
}

impl<S: Sink> BatchRunner<S> {
    pub fn new(sink: S, opts: RunnerOptions) -> Self {
        Self { sink, opts }
    }

''' + runner_old + "\n}\n", start=12, limit=30),
                grep("decode_into", "crates/reader/src", "crates/reader/src/chunk_iter.rs:57:    pub fn decode_into(&self, out: &mut Vec<u8>) -> Result<()> {\ncrates/reader/src/batch.rs:24:                chunk.decode_into(&mut buf)?;\ncrates/reader/benches/cache_profiling.rs:33:            chunk.decode_into(&mut scratch).unwrap();"),
            ]),
            asst("Confirmed by reading: `buf` is created inside the innermost loop, so every chunk allocates, grows and frees a `Vec<u8>`. The bench already reuses a `scratch` buffer, which is why the bench never showed the regression. Let me measure the real runner.", [
                bash("cargo run --release --features dhat-heap --bin batch_profile -- fixtures/events-4096x64.parquet",
                     '''dhat: Total:     1,482,331,904 bytes in 262,412 blocks
dhat: At t-gmax: 18,874,368 bytes in 41 blocks
dhat: At t-end:  1,048,576 bytes in 3 blocks
rows: 16384000  elapsed: 3.41s  (4.80M rows/s)'''),
            ]),
            asst("262,412 allocations for 4,096 row groups of 64 chunks: one per chunk, plus growth reallocations inside `decode_into`. 1.48 GB of allocator traffic to move 16 million rows. The fix is a single scratch buffer for the whole run, cleared per chunk so the capacity is kept.", [
                edit("crates/reader/src/batch.rs", runner_old, runner_new, line=21),
                grep("max_chunk_bytes", "crates/reader/src", "crates/reader/src/lib.rs:31:    pub max_chunk_bytes: usize,\ncrates/reader/src/lib.rs:44:            max_chunk_bytes: 1 << 20,"),
            ]),
            asst("`RunnerOptions` already has `max_chunk_bytes` (1 MiB default), a good starting capacity. Rebuilding and measuring again.", [
                bash("cargo run --release --features dhat-heap --bin batch_profile -- fixtures/events-4096x64.parquet",
                     '''dhat: Total:     1,058,013,184 bytes in 1,972 blocks
dhat: At t-gmax: 18,874,368 bytes in 41 blocks
dhat: At t-end:  1,048,576 bytes in 3 blocks
rows: 16384000  elapsed: 2.79s  (5.87M rows/s)'''),
            ]),
            asst("Allocations dropped from 262,412 to 1,972 and throughput rose from 4.80M to 5.87M rows/s (+22%). There are still ~1,970 allocations, which is more than one buffer should need, so something else allocates. Looking at the dictionary decode path.", [
                read("crates/reader/src/dict.rs", '''impl DictPage {
    pub fn lookup(&self, idx: u32) -> Result<&[u8]> {
        let (start, end) = self.offsets.get(idx as usize).copied().ok_or(Error::BadDictIndex(idx))?;
        Ok(&self.bytes[start..end])
    }

    pub fn materialize(&self, indices: &[u32], out: &mut Vec<u8>) -> Result<()> {
        let mut staged: Vec<Vec<u8>> = Vec::new();
        for &i in indices {
            staged.push(self.lookup(i)?.to_vec());
        }
        for s in staged {
            out.extend_from_slice(&s);
        }
        Ok(())
    }
}''', start=40, limit=20),
            ]),
            asst("`materialize` copies every dictionary value into its own `Vec` and then concatenates them: two copies and an allocation per value. This is the zero-copy deserializer, so it should write straight from the dictionary slice into `out`.", [
                edit("crates/reader/src/dict.rs",
                     '        let mut staged: Vec<Vec<u8>> = Vec::new();\n        for &i in indices {\n            staged.push(self.lookup(i)?.to_vec());\n        }\n        for s in staged {\n            out.extend_from_slice(&s);\n        }\n        Ok(())',
                     '        out.reserve(indices.len() * self.avg_value_len());\n        for &i in indices {\n            out.extend_from_slice(self.lookup(i)?);\n        }\n        Ok(())', line=47),
                bash("cargo test -p vortex-reader --release",
                     '''running 31 tests
test chunk_iter::tests::iterates_all_chunks ... ok
test dict::tests::materialize_matches_naive ... ok
test dict::tests::bad_index_is_an_error ... ok
test batch::tests::scratch_buffer_is_reused_between_chunks ... ok
...
test result: ok. 31 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.92s'''),
                bash("cargo run --release --features dhat-heap --bin batch_profile -- fixtures/events-4096x64.parquet",
                     '''dhat: Total:     1,049,624,576 bytes in 7 blocks
dhat: At t-gmax: 18,874,368 bytes in 4 blocks
dhat: At t-end:  1,048,576 bytes in 3 blocks
rows: 16384000  elapsed: 2.31s  (7.09M rows/s)'''),
            ]),
            asst("Done, and the numbers are clear:\n\n"
                 "| | allocations | throughput |\n|---|---|---|\n| before | 262,412 | 4.80M rows/s |\n| scratch buffer only | 1,972 | 5.87M rows/s |\n| plus dictionary fix | 7 | 7.09M rows/s |\n\n"
                 "Two separate causes:\n"
                 "1. `BatchRunner::run` created a fresh `Vec<u8>` for every chunk. It now reuses one buffer, cleared between chunks.\n"
                 "2. `DictPage::materialize` staged each value in its own `Vec` before concatenating. It now copies straight from the dictionary slice.\n\n"
                 "```rust\nout.reserve(indices.len() * self.avg_value_len());\nfor &i in indices {\n    out.extend_from_slice(self.lookup(i)?);\n}\n```\n\n"
                 "That is a 48% throughput gain over the regressed build, and about 18% better than before the dictionary work, which matches your suspicion. All 31 reader tests pass. I did not add a benchmark guard for allocations; a DHAT assertion in CI would stop this regressing again, if you want it."),
        ],
    )


def copy_button():
    return Sess(
        key="hero/cline-aurora-copy-button", agent="cline", project="aurora-docs", hero=True,
        start=at("2026-09-29", "17:15"), minutes=52, model="claude-sonnet-5-5",
        title="Add a copy button to the response pane of the interactive API playground",
        turns=[
            user("Add a copy-to-clipboard button to the response pane of the interactive API playground. It should copy the pretty-printed JSON body, "
                 "show a Copied confirmation for 2 seconds, and be keyboard accessible."),
            asst("I'll read the playground's response pane first.", [
                read("src/components/ApiPlayground.tsx", '''export function ResponsePane({ response }: { response: PlaygroundResponse | null }) {
  if (!response) return <p className="pg-empty">Send a request to see the response.</p>;
  const body = JSON.stringify(response.body, null, 2);
  return (
    <section className="pg-response" aria-label="Response">
      <header className="pg-response-header">
        <span className={`pg-status pg-status-${Math.floor(response.status / 100)}xx`}>{response.status}</span>
        <span className="pg-time">{response.elapsedMs} ms</span>
      </header>
      <pre className="pg-body"><code>{body}</code></pre>
    </section>
  );
}'''),
                glob("src/components/*.test.tsx", "src/components/ApiPlayground.test.tsx\nsrc/components/CodeSnippet.test.tsx\nsrc/components/TabSwitcher.test.tsx"),
            ]),
            asst("`CodeSnippet` already renders a code block, so I'll check how it handles copying before I add a second implementation.", [
                read("src/components/CodeSnippet.tsx", '''export function CodeSnippet({ code, language }: { code: string; language: string }) {
  return (
    <div className="snippet">
      <pre data-language={language}><code>{code}</code></pre>
    </div>
  );
}'''),
            ]),
            asst("No copy support anywhere yet, so I'll write a small reusable `CopyButton` with a `useCopy` hook, then use it in the response header.", [
                edit("src/components/ApiPlayground.tsx",
                     '        <span className="pg-time">{response.elapsedMs} ms</span>\n      </header>',
                     '        <span className="pg-time">{response.elapsedMs} ms</span>\n        <CopyButton text={body} label="Copy response body" />\n      </header>'),
                edit("src/components/ApiPlayground.tsx", "export function ResponsePane(", 'import { CopyButton } from "./CopyButton";\n\nexport function ResponsePane('),
            ]),
            asst("Now the component itself, with the confirmation announced to screen readers through a polite live region.", [
                write("src/components/CopyButton.tsx", '''import { useEffect, useRef, useState } from "react";

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button type="button" className="pg-copy" onClick={copy} aria-label={label}>
      {copied ? "Copied" : "Copy"}
      <span className="sr-only" role="status" aria-live="polite">{copied ? "Copied to clipboard" : ""}</span>
    </button>
  );
}
'''),
                write("src/components/CopyButton.test.tsx", '''import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CopyButton } from "./CopyButton";

describe("CopyButton", () => {
  it("copies the text and shows Copied for two seconds", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CopyButton text='{"ok":true}' label="Copy response body" />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy response body" })));
    expect(writeText).toHaveBeenCalledWith('{"ok":true}');
    expect(screen.getByRole("button")).toHaveTextContent("Copied");
    await act(async () => vi.advanceTimersByTime(2100));
    expect(screen.getByRole("button")).toHaveTextContent("Copy");
    vi.useRealTimers();
  });
});
'''),
                bash("npm test -- CopyButton ApiPlayground",
                     ''' RUN  v2.1.8 /Users/fictional-dev/projects/aurora-docs

 ✓ src/components/CopyButton.test.tsx (1 test) 38ms
 ❯ src/components/ApiPlayground.test.tsx (7 tests | 1 failed) 214ms
   × shows the response body after Send 41ms
     → Cannot read properties of undefined (reading 'writeText')

 FAIL  src/components/ApiPlayground.test.tsx > ApiPlayground > shows the response body after Send
TypeError: Cannot read properties of undefined (reading 'writeText')
 ❯ copy src/components/CopyButton.tsx:9:30
 ❯ src/components/ApiPlayground.test.tsx:88:21

 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 7 passed (8)''', error=True),
            ]),
            asst("My new test passes, but an older playground test now fails: jsdom has no `navigator.clipboard`, and my first version assumed it exists. That is also a real-world problem, since the Clipboard API is missing on non-secure origins (a docs preview served over plain HTTP). The button should fall back to a hidden textarea and `execCommand('copy')` instead of throwing.", [
                edit("src/components/CopyButton.tsx",
                     "  async function copy() {\n    await navigator.clipboard.writeText(text);\n    setCopied(true);",
                     "  async function copy() {\n    if (navigator.clipboard?.writeText) {\n      await navigator.clipboard.writeText(text);\n    } else {\n      // non-secure origins have no Clipboard API: fall back to a selected textarea\n      const area = document.createElement(\"textarea\");\n      area.value = text;\n      area.setAttribute(\"readonly\", \"\");\n      area.style.position = \"fixed\";\n      area.style.opacity = \"0\";\n      document.body.appendChild(area);\n      area.select();\n      document.execCommand(\"copy\");\n      document.body.removeChild(area);\n    }\n    setCopied(true);"),
                bash("npm test -- CopyButton ApiPlayground",
                     ''' RUN  v2.1.8 /Users/fictional-dev/projects/aurora-docs

 ✓ src/components/CopyButton.test.tsx (1 test) 36ms
 ✓ src/components/ApiPlayground.test.tsx (7 tests) 187ms

 Test Files  2 passed (2)
      Tests  8 passed (8)'''),
                bash("npm run lint -- src/components", "> aurora-docs@1.4.0 lint\n> eslint src/components\n\n(no problems)"),
            ]),
            asst("The copy button is in the response pane of the interactive API playground.\n\n"
                 "- **Behaviour:** copies the pretty-printed JSON body, shows `Copied` for 2 seconds, then resets. A polite live region announces `Copied to clipboard` to screen readers.\n"
                 "- **Keyboard:** it is a real `<button>`, so Tab focuses it and Enter or Space activates it. No custom key handling needed.\n"
                 "- **Fallback:** when `navigator.clipboard` is missing (plain HTTP previews, jsdom) it copies through a temporary readonly textarea.\n\n"
                 "```tsx\n<CopyButton text={body} label=\"Copy response body\" />\n```\n\n"
                 "Tests: 8 pass, lint is clean. I did not style the button; it uses the existing `.pg-copy` class name, which has no CSS yet, so it will look like a plain button until you decide on the design."),
        ],
    )


def ping_timeout():
    ping_old = '''pub fn ping_node(addr: SocketAddr, timeout: Duration) -> PingResult {
    let started = Instant::now();
    match probe(addr, timeout) {
        Ok(()) => PingResult::Ok { rtt: started.elapsed() },
        Err(_) => PingResult::TimedOut,
    }
}'''
    ping_new = '''pub fn ping_node(addr: SocketAddr, base_timeout: Duration, rtt: &mut RttEstimate) -> PingResult {
    // a fixed timeout fails healthy nodes on high latency links: scale it with the smoothed round trip
    let timeout = rtt.timeout(base_timeout);
    let started = Instant::now();
    match probe(addr, timeout) {
        Ok(()) => {
            let sample = started.elapsed();
            rtt.observe(sample);
            PingResult::Ok { rtt: sample }
        }
        Err(_) => PingResult::TimedOut,
    }
}

/// Smoothed round trip estimate, in the style of TCP's SRTT: srtt = 7/8 srtt + 1/8 sample.
#[derive(Default)]
pub struct RttEstimate {
    srtt: Option<Duration>,
}

impl RttEstimate {
    pub fn observe(&mut self, sample: Duration) {
        self.srtt = Some(match self.srtt {
            None => sample,
            Some(s) => (s * 7 + sample) / 8,
        });
    }

    pub fn timeout(&self, base: Duration) -> Duration {
        match self.srtt {
            None => base,
            Some(s) => base.max(s * 3),
        }
    }
}'''
    return Sess(
        key="hero/opencode-zenith-ping-timeout", agent="opencode", project="zenith-cli", hero=True,
        start=at("2026-10-08", "14:50"), minutes=55, model="claude-sonnet-5-5",
        title="Adaptive timeout for the distributed consensus ping on slow links",
        turns=[
            user("`zenith cluster ping` reports healthy nodes in the eu-west zone as timed out. Those links are 400 ms away and our timeout is a fixed 500 ms, so the distributed consensus ping "
                 "fails whenever there is a little jitter. Make the timeout adapt to the link."),
            asst("I'll read the ping implementation and where the 500 ms comes from.", [
                grep("500|timeout", "src", "src/consensus.rs:18:const DEFAULT_TIMEOUT: Duration = Duration::from_millis(500);\nsrc/consensus.rs:44:pub fn ping_node(addr: SocketAddr, timeout: Duration) -> PingResult {\nsrc/commands/ping.rs:27:        let r = ping_node(node.addr, DEFAULT_TIMEOUT);\nsrc/commands/ping.rs:39:    // quorum needs a majority of Ok results"),
                read("src/consensus.rs", ping_old, start=44, limit=8),
            ]),
            asst("The timeout is a constant passed straight through. I'll plan the change so the quorum logic stays untouched.", [
                todo(
                    ("Add an RttEstimate (smoothed round trip) to consensus.rs", "in_progress", "Adding an RttEstimate to consensus.rs"),
                    ("Use 3x srtt as the timeout, never below the base", "pending", "Using 3x srtt as the timeout"),
                    ("Keep one estimate per node across a ping run", "pending", "Keeping one estimate per node"),
                    ("Test slow-but-healthy nodes and genuinely dead nodes", "pending", "Testing slow-but-healthy and dead nodes"),
                ),
                edit("src/consensus.rs", ping_old, ping_new, line=44),
            ]),
            asst("Now the caller has to keep one `RttEstimate` per node for the whole run, otherwise every ping starts cold.", [
                read("src/commands/ping.rs", '''pub fn run(cluster: &Cluster, rounds: u32) -> anyhow::Result<()> {
    for round in 0..rounds {
        let mut ok = 0;
        for node in cluster.nodes() {
            let r = ping_node(node.addr, DEFAULT_TIMEOUT);
            if matches!(r, PingResult::Ok { .. }) {
                ok += 1;
            }
        }
        // quorum needs a majority of Ok results
        report_round(round, ok, cluster.nodes().len());
    }
    Ok(())
}''', start=20, limit=14),
                edit("src/commands/ping.rs",
                     "    for round in 0..rounds {\n        let mut ok = 0;\n        for node in cluster.nodes() {\n            let r = ping_node(node.addr, DEFAULT_TIMEOUT);",
                     "    let mut estimates: HashMap<String, RttEstimate> = HashMap::new();\n    for round in 0..rounds {\n        let mut ok = 0;\n        for node in cluster.nodes() {\n            let est = estimates.entry(node.name.clone()).or_default();\n            let r = ping_node(node.addr, DEFAULT_TIMEOUT, est);", line=21),
                bash("cargo test --test consensus_failover",
                     '''   Compiling zenith v0.7.2 (/Users/fictional-dev/projects/zenith-cli)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 4.30s
     Running tests/consensus_failover.rs (target/debug/deps/consensus_failover-2e8a44c7b1d90f35)

running 4 tests
test dead_node_is_reported_after_timeout ... ok
test quorum_survives_one_disconnected_node ... ok
test slow_link_is_not_reported_dead ... FAILED
test leader_change_is_detected ... ok

failures:

---- slow_link_is_not_reported_dead stdout ----
thread 'slow_link_is_not_reported_dead' panicked at tests/consensus_failover.rs:71:5:
assertion failed: matches!(second, PingResult::Ok { .. })
note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace

failures:
    slow_link_is_not_reported_dead

test result: FAILED. 3 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 2.14s''', error=True),
            ]),
            asst("The slow-link test is the one that matters, and it fails on the second ping. The first ping has no estimate, so it still uses the 500 ms base, and a 640 ms reply times out before it ever teaches the estimator anything. A node that never answers within the base can never get a longer timeout. The first ping of a cold node needs a more generous floor.", [
                edit("src/consensus.rs",
                     "    pub fn timeout(&self, base: Duration) -> Duration {\n        match self.srtt {\n            None => base,\n            Some(s) => base.max(s * 3),\n        }\n    }",
                     "    pub fn timeout(&self, base: Duration) -> Duration {\n        match self.srtt {\n            // no sample yet: be generous once, so one slow first reply can seed the estimate\n            None => base * 4,\n            Some(s) => base.max(s * 3),\n        }\n    }", line=62),
                todo(
                    ("Add an RttEstimate (smoothed round trip) to consensus.rs", "completed", "Adding an RttEstimate to consensus.rs"),
                    ("Use 3x srtt as the timeout, never below the base", "completed", "Using 3x srtt as the timeout"),
                    ("Keep one estimate per node across a ping run", "completed", "Keeping one estimate per node"),
                    ("Test slow-but-healthy nodes and genuinely dead nodes", "in_progress", "Testing slow-but-healthy and dead nodes"),
                ),
                bash("cargo test --test consensus_failover --test cli",
                     '''running 4 tests
test dead_node_is_reported_after_timeout ... ok
test quorum_survives_one_disconnected_node ... ok
test slow_link_is_not_reported_dead ... ok
test leader_change_is_detected ... ok

test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 2.31s

running 6 tests
test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.29s'''),
            ]),
            asst("The distributed consensus ping now adapts to the link, and all 10 tests pass (the slow-link test failed first, which is how I found the cold-start problem).\n\n"
                 "- `RttEstimate` keeps a smoothed round trip (`srtt = 7/8 srtt + 1/8 sample`, as TCP does) per node for the whole ping run.\n"
                 "- The timeout is `max(base, 3 x srtt)`. With no sample yet it is `4 x base`, so a healthy node 600 ms away answers its first ping and seeds the estimate.\n"
                 "- A dead node still times out, just after 2 s the first time instead of 500 ms; the failover tests confirm it is reported dead.\n\n"
                 "```rust\nlet est = estimates.entry(node.name.clone()).or_default();\nlet r = ping_node(node.addr, DEFAULT_TIMEOUT, est);\n```\n\n"
                 "Trade-off to be aware of: a one-shot `zenith cluster ping` against a dead node now waits up to 2 seconds on that node. If that feels slow for scripts, we can cap the cold-start multiplier with a `--cold-timeout` flag."),
        ],
    )


def sessions():
    return [bucket_refill(), allocator_churn(), copy_button(), ping_timeout()]
