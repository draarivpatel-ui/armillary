"""Hero sessions for Claude Code: the Folio hero (skyline-weather), a compile error and retry (nexus-gateway),
and a plan that is ticked off over time (zenith-cli)."""

from .model import Sess, asst, at, bash, edit, glob, grep, read, task, todo, user, write


def radar_jitter():
    sweep_old = '''export class RadarSweep {
  private angle = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly cache: TileCache,
    private readonly opts: SweepOptions,
  ) {}

  onSweep(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.frameIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    // refresh first so the new frame always paints on fresh tiles
    await this.cache.refresh();
    this.angle = (this.angle + this.opts.degreesPerFrame) % 360;
    for (const fn of this.listeners) fn(this.angle);
  }
}'''
    sweep_new = '''export class RadarSweep {
  private angle = 0;
  private startedAt = 0;
  private refreshing = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly cache: TileCache,
    private readonly opts: SweepOptions,
  ) {}

  onSweep(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Sweep angle at a point in time, independent of how long tile refreshes take. */
  angleAt(now: number): number {
    const degreesPerMs = this.opts.degreesPerFrame / this.opts.frameIntervalMs;
    return (now - this.startedAt) * degreesPerMs;
  }

  start(now: number = Date.now()): void {
    if (this.timer) return;
    this.startedAt = now;
    this.timer = setInterval(() => this.tick(Date.now()), this.opts.frameIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(now: number): void {
    this.angle = this.angleAt(now);
    for (const fn of this.listeners) fn(this.angle);
    // tiles refresh beside the sweep, never in front of it
    if (!this.refreshing) {
      this.refreshing = true;
      void this.cache.refresh().finally(() => {
        this.refreshing = false;
      });
    }
  }
}'''
    cache_old = '''  async refresh(): Promise<void> {
    const now = Date.now();
    for (const tile of this.tiles.values()) {
      if (now - tile.fetchedAt < this.ttlMs) continue;
      tile.bitmap = await this.fetchTile(tile.url);
      tile.fetchedAt = Date.now();
    }
  }'''
    cache_new = '''  async refresh(): Promise<void> {
    const now = Date.now();
    const stale = [...this.tiles.values()].filter((t) => now - t.fetchedAt >= this.ttlMs);
    for (let i = 0; i < stale.length; i += REFRESH_BATCH) {
      const batch = stale.slice(i, i + REFRESH_BATCH);
      const results = await Promise.allSettled(batch.map((t) => this.fetchTile(t.url)));
      results.forEach((res, j) => {
        // a failed fetch keeps the old bitmap on screen and is retried on the next refresh
        if (res.status === "fulfilled") {
          batch[j].bitmap = res.value;
          batch[j].fetchedAt = Date.now();
        }
      });
    }
  }'''
    test_file = '''import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RadarSweep } from "./RadarSweep";
import type { TileCache } from "./TileCache";

function slowCache(delayMs: number): TileCache {
  return { refresh: () => new Promise<void>((resolve) => setTimeout(resolve, delayMs)) } as unknown as TileCache;
}

describe("RadarSweep timing", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("advances the sweep angle on its own clock", async () => {
    const sweep = new RadarSweep(slowCache(0), { degreesPerFrame: 6, frameIntervalMs: 50 });
    const angles: number[] = [];
    sweep.onSweep((a) => angles.push(a));
    sweep.start();
    await vi.advanceTimersByTimeAsync(200);
    sweep.stop();
    expect(angles.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps sweeping while the tile cache refreshes", async () => {
    const sweep = new RadarSweep(slowCache(400), { degreesPerFrame: 6, frameIntervalMs: 50 });
    const angles: number[] = [];
    sweep.onSweep((a) => angles.push(a));
    sweep.start();
    await vi.advanceTimersByTimeAsync(300);
    sweep.stop();
    // 300 ms at 6 degrees per 50 ms should have swept 36 degrees
    expect(angles.at(-1) ?? 0).toBeGreaterThan(30);
  });

  it("wraps the angle at 360 degrees", () => {
    const sweep = new RadarSweep(slowCache(0), { degreesPerFrame: 6, frameIntervalMs: 50 });
    sweep.start(0);
    sweep.stop();
    expect(sweep.angleAt(61_000)).toBeLessThan(360);
  });
});
'''
    return Sess(
        key="hero/claude-skyline-radar-jitter", agent="claude-code", project="skyline-weather",
        start=at("2026-10-07", "15:12"), minutes=64, model="claude-sonnet-5-5", hero=True, branch="fix/radar-sweep-stutter",
        turns=[
            user("The radar sweep line freezes for about half a second roughly once a minute, right when the tiles refresh. "
                 "Can you find out why and fix it? The Doppler radar sweep should stay smooth at 30fps even while tiles load. "
                 "Tests live next to the files and run with `npm test -- radar`."),
            asst("I'll start by finding what drives the sweep and what the tile refresh does.", [
                grep("sweep|refresh\\(", "src", "src/radar/RadarSweep.ts:12:export class RadarSweep {\nsrc/radar/RadarSweep.ts:34:    await this.cache.refresh();\nsrc/radar/TileCache.ts:22:  async refresh(): Promise<void> {\nsrc/components/RadarLayer.tsx:41:  const sweep = useMemo(() => new RadarSweep(cache, SWEEP), [cache]);\nsrc/components/RadarLayer.tsx:58:    return sweep.onSweep((deg) => map.setPaintProperty('radar-sweep', 'line-rotate', deg));\nsrc/alerts/cellTracker.ts:17:    await cache.refresh();"),
                glob("src/radar/**/*.ts", "src/radar/RadarSweep.ts\nsrc/radar/RadarSweep.test.ts\nsrc/radar/TileCache.ts\nsrc/radar/TileCache.test.ts\nsrc/radar/legend.ts\nsrc/radar/legend.test.ts"),
            ]),
            asst("`tick()` in `RadarSweep` awaits the cache refresh before it advances the angle. Let me read both files in full.", [
                read("src/radar/RadarSweep.ts", '''import type { TileCache } from "./TileCache";

export interface SweepOptions {
  degreesPerFrame: number;
  frameIntervalMs: number;
}

type Listener = (angleDeg: number) => void;

''' + sweep_old + "\n"),
                read("src/radar/TileCache.ts", '''export interface Tile {
  key: string;
  url: string;
  fetchedAt: number;
  bitmap: ImageBitmap | null;
}

export class TileCache {
  private readonly tiles = new Map<string, Tile>();

  constructor(
    private readonly fetchTile: (url: string) => Promise<ImageBitmap>,
    private readonly ttlMs = 60_000,
  ) {}

  get(key: string): Tile | undefined {
    return this.tiles.get(key);
  }

  register(key: string, url: string): void {
    if (!this.tiles.has(key)) this.tiles.set(key, { key, url, fetchedAt: 0, bitmap: null });
  }

''' + cache_old + "\n}\n"),
            ]),
            asst("That explains it. The sweep clock is chained to the network: every `tick()` waits for each stale tile to download one after another, so a refresh of 40 tiles at ~12 ms each parks the angle for about half a second. Here is the plan.", [
                todo(
                    ("Reproduce the freeze with a fake-timer test", "in_progress", "Reproducing the freeze with a fake-timer test"),
                    ("Decouple the sweep clock from the tile refresh", "pending", "Decoupling the sweep clock from the tile refresh"),
                    ("Fetch stale tiles in parallel batches", "pending", "Fetching stale tiles in parallel batches"),
                    ("Check the other callers of TileCache.refresh", "pending", "Checking the other callers of TileCache.refresh"),
                    ("Run the radar suite and the type check", "pending", "Running the radar suite and the type check"),
                ),
            ]),
            asst("`cellTracker.ts` also calls `refresh()`. Before I change its contract I want to know every caller and what it assumes, so I'll hand that survey to a subagent while I write the failing test.", [
                task("Survey callers of TileCache.refresh",
                     "In /Users/fictional-dev/projects/skyline-weather find every caller of TileCache.refresh() and report, for each, whether it relies on the promise resolving only AFTER all stale tiles are fresh (for example reads tile.bitmap right after awaiting). Do not edit anything. Reply with a short table: file, line, what it assumes.",
                     "Three callers of `TileCache.refresh()`:\n\n| file | line | assumes |\n|---|---|---|\n| src/radar/RadarSweep.ts | 34 | nothing; awaits only to pace the next frame |\n| src/components/RadarLayer.tsx | 63 | nothing; fire and forget on map `moveend` |\n| src/alerts/cellTracker.ts | 17 | **yes**: reads `cache.get(key).bitmap` on the next line, expects fresh tiles |\n\nSo `refresh()` must keep resolving only after the batch is done, and the sweep must simply stop awaiting it. `cellTracker` needs no change if `refresh()` still resolves after all fetches settle."),
            ]),
            asst("Good: `refresh()` has to keep its contract (resolve once the batch has settled), so the fix belongs in `RadarSweep`, which should stop awaiting it. First the failing test.", [
                write("src/radar/RadarSweep.timing.test.ts", test_file),
                bash("npm test -- radar",
                     ''' RUN  v2.1.8 /Users/fictional-dev/projects/skyline-weather

 ✓ src/radar/TileCache.test.ts (6 tests) 14ms
 ✓ src/radar/legend.test.ts (4 tests) 9ms
 ✓ src/radar/RadarSweep.test.ts (3 tests) 11ms
 ❯ src/radar/RadarSweep.timing.test.ts (3 tests | 2 failed) 318ms
   ✓ advances the sweep angle on its own clock 4ms
   × keeps sweeping while the tile cache refreshes 301ms
     → expected 0 to be greater than 30
   × wraps the angle at 360 degrees 2ms
     → sweep.angleAt is not a function

 FAIL  src/radar/RadarSweep.timing.test.ts > RadarSweep timing > keeps sweeping while the tile cache refreshes
AssertionError: expected 0 to be greater than 30
 ❯ src/radar/RadarSweep.timing.test.ts:32:36
     30|     sweep.stop();
     31|     // 300 ms at 6 degrees per 50 ms should have swept 36 degrees
     32|     expect(angles.at(-1) ?? 0).toBeGreaterThan(30);
       |                                ^

 FAIL  src/radar/RadarSweep.timing.test.ts > RadarSweep timing > wraps the angle at 360 degrees
TypeError: sweep.angleAt is not a function
 ❯ src/radar/RadarSweep.timing.test.ts:40:18

 Test Files  1 failed | 3 passed (4)
      Tests  2 failed | 13 passed (15)
   Start at  15:19:08
   Duration  1.41s''', error=True, desc="Run the radar tests"),
            ]),
            asst("Reproduced: with a 400 ms refresh the sweep never moves in 300 ms. The second failure is just my new `angleAt` API that does not exist yet. Now the fix.\n\n"
                 "The sweep angle becomes a pure function of elapsed time, so a late or slow frame can never stall it, and the cache refresh runs beside it with a guard so refreshes do not pile up:\n\n"
                 "```ts\nangleAt(now: number): number {\n  const degreesPerMs = this.opts.degreesPerFrame / this.opts.frameIntervalMs;\n  return (now - this.startedAt) * degreesPerMs;\n}\n```\n\n"
                 "In `TileCache` I fetch stale tiles in parallel batches of 6 with `Promise.allSettled`, so one failing tile no longer blocks the rest and keeps its old bitmap.", [
                edit("src/radar/RadarSweep.ts", sweep_old, sweep_new, line=12),
                edit("src/radar/TileCache.ts", cache_old, cache_new, line=28),
                edit("src/radar/TileCache.ts", "export interface Tile {", "const REFRESH_BATCH = 6;\n\nexport interface Tile {", line=1),
                todo(
                    ("Reproduce the freeze with a fake-timer test", "completed", "Reproducing the freeze with a fake-timer test"),
                    ("Decouple the sweep clock from the tile refresh", "completed", "Decoupling the sweep clock from the tile refresh"),
                    ("Fetch stale tiles in parallel batches", "completed", "Fetching stale tiles in parallel batches"),
                    ("Check the other callers of TileCache.refresh", "in_progress", "Checking the other callers of TileCache.refresh"),
                    ("Run the radar suite and the type check", "pending", "Running the radar suite and the type check"),
                ),
                bash("npm test -- radar",
                     ''' RUN  v2.1.8 /Users/fictional-dev/projects/skyline-weather

 ✓ src/radar/TileCache.test.ts (6 tests) 17ms
 ✓ src/radar/legend.test.ts (4 tests) 8ms
 ✓ src/radar/RadarSweep.test.ts (3 tests) 10ms
 ❯ src/radar/RadarSweep.timing.test.ts (3 tests | 1 failed) 52ms
   ✓ advances the sweep angle on its own clock 3ms
   ✓ keeps sweeping while the tile cache refreshes 4ms
   × wraps the angle at 360 degrees 2ms
     → expected 366 to be less than 360

 FAIL  src/radar/RadarSweep.timing.test.ts > RadarSweep timing > wraps the angle at 360 degrees
AssertionError: expected 366 to be less than 360
 ❯ src/radar/RadarSweep.timing.test.ts:41:41
     39|     sweep.start(0);
     40|     sweep.stop();
     41|     expect(sweep.angleAt(61_000)).toBeLessThan(360);
       |                                   ^

 Test Files  1 failed | 3 passed (4)
      Tests  1 failed | 14 passed (15)
   Start at  15:31:44
   Duration  1.18s''', error=True, desc="Run the radar tests again"),
            ]),
            asst("The freeze is gone (the first two tests pass), and the third test caught a real bug I just introduced: the old code wrapped with `% 360` on every tick, my `angleAt` does not, so after 61 s the angle is 366. One line.", [
                edit("src/radar/RadarSweep.ts",
                     "    return (now - this.startedAt) * degreesPerMs;",
                     "    return ((now - this.startedAt) * degreesPerMs) % 360;", line=29),
                bash("npm test -- radar",
                     ''' RUN  v2.1.8 /Users/fictional-dev/projects/skyline-weather

 ✓ src/radar/TileCache.test.ts (6 tests) 15ms
 ✓ src/radar/legend.test.ts (4 tests) 8ms
 ✓ src/radar/RadarSweep.test.ts (3 tests) 9ms
 ✓ src/radar/RadarSweep.timing.test.ts (3 tests) 47ms

 Test Files  4 passed (4)
      Tests  15 passed (15)
   Start at  15:38:20
   Duration  1.09s''', desc="Run the radar tests"),
            ]),
            user("nice. while you are in there, the legend colour bar also flickers when tiles refresh, same cause?", think=140),
            asst("Different cause, I think, but the same trigger. Let me look at how the legend is built.", [
                read("src/radar/legend.ts", '''import { VELOCITY_STOPS } from "./palette";

export function buildLegendGradient(ctx: CanvasRenderingContext2D, width: number): CanvasGradient {
  const gradient = ctx.createLinearGradient(0, 0, width, 0);
  VELOCITY_STOPS.forEach(([offset, color]) => gradient.addColorStop(offset, color));
  return gradient;
}

export function drawLegend(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = buildLegendGradient(ctx, width);
  ctx.fillRect(0, 0, width, height);
}'''),
                grep("drawLegend", "src", "src/components/RadarLayer.tsx:52:    drawLegend(legendCtx, LEGEND_W, LEGEND_H);\nsrc/components/RadarLayer.tsx:53:  }, [tiles.version]);"),
            ]),
            asst("`drawLegend` clears and rebuilds the gradient every time `tiles.version` changes, which is every refresh, so the bar blanks for a frame between `clearRect` and `fillRect` on slow GPUs. The palette never changes, so I'll build the gradient once per context and only repaint when the size changes.", [
                edit("src/radar/legend.ts",
                     'export function drawLegend(ctx: CanvasRenderingContext2D, width: number, height: number): void {\n  ctx.clearRect(0, 0, width, height);\n  ctx.fillStyle = buildLegendGradient(ctx, width);\n  ctx.fillRect(0, 0, width, height);\n}',
                     'const painted = new WeakMap<CanvasRenderingContext2D, string>();\n\nexport function drawLegend(ctx: CanvasRenderingContext2D, width: number, height: number): void {\n  const size = `${width}x${height}`;\n  // the palette is constant: repaint only when the canvas size changed, never per tile refresh\n  if (painted.get(ctx) === size) return;\n  ctx.fillStyle = buildLegendGradient(ctx, width);\n  ctx.fillRect(0, 0, width, height);\n  painted.set(ctx, size);\n}', line=8),
                bash("npm run typecheck && npm test -- radar",
                     '''> skyline-weather@2.3.0 typecheck
> tsc --noEmit

 RUN  v2.1.8 /Users/fictional-dev/projects/skyline-weather

 ✓ src/radar/TileCache.test.ts (6 tests) 14ms
 ✓ src/radar/legend.test.ts (4 tests) 8ms
 ✓ src/radar/RadarSweep.test.ts (3 tests) 9ms
 ✓ src/radar/RadarSweep.timing.test.ts (3 tests) 44ms

 Test Files  4 passed (4)
      Tests  15 passed (15)
   Start at  15:52:03
   Duration  1.31s''', desc="Type check and run the radar tests"),
                bash("git diff --stat",
                     ' src/radar/RadarSweep.timing.test.ts | 44 ++++++++++++++++++++++++++++++++++++++++\n src/radar/RadarSweep.ts               | 32 ++++++++++++++++++++++-------\n src/radar/TileCache.ts                | 21 ++++++++++++++-----\n src/radar/legend.ts                   | 10 +++++++--\n 4 files changed, 85 insertions(+), 22 deletions(-)', desc="Summarise the change"),
                todo(
                    ("Reproduce the freeze with a fake-timer test", "completed", "Reproducing the freeze with a fake-timer test"),
                    ("Decouple the sweep clock from the tile refresh", "completed", "Decoupling the sweep clock from the tile refresh"),
                    ("Fetch stale tiles in parallel batches", "completed", "Fetching stale tiles in parallel batches"),
                    ("Check the other callers of TileCache.refresh", "completed", "Checking the other callers of TileCache.refresh"),
                    ("Run the radar suite and the type check", "completed", "Running the radar suite and the type check"),
                ),
            ]),
            asst("Both are fixed and the radar suite is green (15 tests, type check clean).\n\n"
                 "### What was wrong\n"
                 "- **Sweep stutter:** `RadarSweep.tick()` awaited `TileCache.refresh()` before advancing the angle, and `refresh()` downloaded stale tiles one after another. A refresh of ~40 tiles froze the sweep for about 500 ms.\n"
                 "- **Legend flicker:** `drawLegend` cleared and repainted the gradient on every tile version bump, leaving a blank frame.\n\n"
                 "### What changed\n"
                 "- `RadarSweep` now derives the angle from elapsed time (`angleAt(now)`), wraps it with `% 360`, and starts the cache refresh *beside* the tick with an in-flight guard.\n"
                 "- `TileCache.refresh()` fetches stale tiles in batches of 6 with `Promise.allSettled`; a failed tile keeps its old bitmap and is retried next time. It still resolves only after the batch settles, which `cellTracker.ts` relies on.\n"
                 "- `drawLegend` repaints only when the canvas size changes.\n\n"
                 "```ts\n// RadarSweep.ts\nprivate tick(now: number): void {\n  this.angle = this.angleAt(now);\n  for (const fn of this.listeners) fn(this.angle);\n  if (!this.refreshing) {\n    this.refreshing = true;\n    void this.cache.refresh().finally(() => { this.refreshing = false; });\n  }\n}\n```\n\n"
                 "One thing to watch: `REFRESH_BATCH = 6` is a guess that matches the browser's per-host connection limit. If the tile host moves to HTTP/2 you can raise it. The new `RadarSweep.timing.test.ts` pins the behaviour so a future change that awaits the cache in the tick will fail loudly."),
        ],
    )


def burst_multiplier():
    bucket = '''use std::time::{Duration, Instant};

/// A token bucket: `capacity` tokens, refilled at `refill_per_s`.
pub struct Bucket {
    pub burst: u64,
    pub capacity: u64,
    pub refill_per_s: u64,
    tokens: f64,
    last: Instant,
}

impl Bucket {
    pub fn new(burst: u64, refill_per_s: u64) -> Self {
        Self { burst, capacity: burst, refill_per_s, tokens: burst as f64, last: Instant::now() }
    }

    pub fn try_take(&mut self, n: u64, now: Instant) -> bool {
        self.refill(now);
        if self.tokens >= n as f64 {
            self.tokens -= n as f64;
            true
        } else {
            false
        }
    }

    fn refill(&mut self, now: Instant) {
        let elapsed = now.saturating_duration_since(self.last);
        self.tokens = (self.tokens + elapsed.as_secs_f64() * self.refill_per_s as f64).min(self.capacity as f64);
        self.last = now;
    }

    pub fn idle_for(&self, now: Instant) -> Duration {
        now.saturating_duration_since(self.last)
    }
}
'''
    scale_old = '''    pub fn new(burst: u64, refill_per_s: u64) -> Self {
        Self { burst, capacity: burst, refill_per_s, tokens: burst as f64, last: Instant::now() }
    }
'''
    scale_new1 = '''    pub fn new(burst: u64, refill_per_s: u64) -> Self {
        Self { burst, capacity: burst, refill_per_s, tokens: burst as f64, last: Instant::now() }
    }

    /// Scale the bucket for a client tier, for example 2.0 for premium clients.
    pub fn with_multiplier(mut self, multiplier: f64) -> Self {
        let scaled = self.burst as f64 * multiplier;
        self.capacity = scaled;
        self.tokens = scaled;
        self
    }
'''
    scale_new2 = '''    pub fn new(burst: u64, refill_per_s: u64) -> Self {
        Self { burst, capacity: burst, refill_per_s, tokens: burst as f64, last: Instant::now() }
    }

    /// Scale the bucket for a client tier, for example 2.0 for premium clients.
    /// Capacity rounds to the nearest whole token and is never below one token.
    pub fn with_multiplier(mut self, multiplier: f64) -> Self {
        let scaled = (self.burst as f64 * multiplier).round().max(1.0);
        self.capacity = scaled as u64;
        self.tokens = scaled;
        self
    }
'''
    return Sess(
        key="hero/claude-nexus-burst-multiplier", agent="claude-code", project="nexus-gateway",
        start=at("2026-10-06", "16:05"), minutes=47, model="claude-sonnet-5-5", hero=True, branch="feat/client-tier-burst",
        turns=[
            user("premium clients should get a bigger burst on the token bucket rate limiter, say a per-client multiplier (2.0 for premium, 0.5 for the free tier). "
                 "Add it to Bucket in crates/limiter without breaking the existing callers, with tests."),
            asst("I'll read the bucket first and see who constructs it.", [
                read("crates/limiter/src/bucket.rs", bucket),
                grep("Bucket::new", "crates", "crates/limiter/src/lib.rs:41:        Bucket::new(cfg.burst, cfg.refill_per_s)\ncrates/limiter/src/bucket.rs:12:    pub fn new(burst: u64, refill_per_s: u64) -> Self {\ncrates/router/src/tier.rs:29:            .map(|c| Bucket::new(c.burst, c.refill_per_s))\ncrates/limiter/tests/burst.rs:8:    let mut b = Bucket::new(10, 5);"),
            ]),
            asst("Three constructors call `Bucket::new(burst, refill)`, so I will leave that signature alone and add a builder method, `with_multiplier`, that scales capacity and the starting tokens. Adding it, then checking it compiles.", [
                edit("crates/limiter/src/bucket.rs", scale_old, scale_new1, line=12),
                bash("cargo check -p nexus-limiter",
                     '''    Checking nexus-limiter v0.9.4 (/Users/fictional-dev/projects/nexus-gateway/crates/limiter)
error[E0308]: mismatched types
  --> crates/limiter/src/bucket.rs:21:25
   |
21 |         self.capacity = scaled;
   |         -------------   ^^^^^^ expected `u64`, found `f64`
   |         |
   |         expected due to the type of this binding

For more information about this error, try `rustc --explain E0308`.
error: could not compile `nexus-limiter` (lib) due to 1 previous error''', error=True, desc="Type check the limiter crate"),
            ]),
            asst("`capacity` is a `u64` but the multiplied value is an `f64`. A bare `as u64` would truncate (0.5 on a burst of 3 gives 1, 1.5 gives 1) and could produce a zero-capacity bucket that rejects everything. I'll round to the nearest token and floor at 1.", [
                edit("crates/limiter/src/bucket.rs", scale_new1, scale_new2, line=12),
                bash("cargo check -p nexus-limiter",
                     "    Checking nexus-limiter v0.9.4 (/Users/fictional-dev/projects/nexus-gateway/crates/limiter)\n    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1.84s", desc="Type check again"),
            ]),
            asst("It compiles. Now tests for the cases that matter: premium doubles, free tier halves and rounds, and a tiny multiplier never reaches zero.", [
                edit("crates/limiter/tests/burst.rs",
                     '#[test]\nfn refills_over_time() {',
                     '#[test]\nfn premium_multiplier_doubles_the_burst() {\n    let mut b = Bucket::new(10, 5).with_multiplier(2.0);\n    let now = Instant::now();\n    assert!(b.try_take(20, now));\n    assert!(!b.try_take(1, now));\n}\n\n#[test]\nfn free_tier_rounds_and_never_hits_zero() {\n    assert_eq!(Bucket::new(3, 1).with_multiplier(0.5).capacity, 2);\n    assert_eq!(Bucket::new(1, 1).with_multiplier(0.1).capacity, 1);\n}\n\n#[test]\nfn refills_over_time() {', line=14),
                bash("cargo test -p nexus-limiter",
                     '''   Compiling nexus-limiter v0.9.4 (/Users/fictional-dev/projects/nexus-gateway/crates/limiter)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 3.02s
     Running unittests src/lib.rs (target/debug/deps/nexus_limiter-6c1d2f0b8e4a7a19)

running 9 tests
test bucket::tests::burst_is_capped ... ok
test bucket::tests::idle_time_is_measured ... ok
test tests::refill_rate_is_respected ... ok
test tests::take_more_than_capacity_fails ... ok
test tests::concurrent_takes_do_not_oversell ... ok
test tests::zero_refill_never_recovers ... ok
test tests::refill_caps_at_capacity ... ok
test tests::clock_going_backwards_is_ignored ... ok
test tests::large_take_is_rejected ... ok

test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.11s

     Running tests/burst.rs (target/debug/deps/burst-3a90c7e1d2b55f60)

running 5 tests
test free_tier_rounds_and_never_hits_zero ... ok
test premium_multiplier_doubles_the_burst ... ok
test refills_over_time ... ok
test starts_full ... ok
test take_exactly_capacity ... ok

test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s''', desc="Run the limiter tests"),
            ]),
            asst("`with_multiplier` is in and the crate builds and passes (14 tests).\n\n"
                 "- `Bucket::new(burst, refill)` is unchanged, so `lib.rs`, `router/src/tier.rs` and the existing tests need no edits.\n"
                 "- The first attempt did not compile (`E0308`, `u64` field vs `f64` product). The fix rounds with `.round()` and floors at `1.0`, so a free tier of `0.5` on a burst of 1 still gets one token instead of a bucket that rejects everything.\n"
                 "- The refill rate is **not** scaled. A premium client gets a bigger burst but the same sustained rate. If you also want the rate to scale, that is a one-line change in `refill()`, but it changes capacity planning, so I left it for you to decide.\n\n"
                 "```rust\nlet bucket = Bucket::new(cfg.burst, cfg.refill_per_s).with_multiplier(tier.multiplier);\n```\n\n"
                 "I did not wire `tier.rs` to call it yet; say the word and I will do that next."),
        ],
    )


def diagnostics_plan():
    plan_md = '''# Diagnostics export plan

Goal: `zenith diagnostics` can hand a machine readable health report to the monitoring stack.

## Checklist

- [ ] `--format json|text` flag on `zenith health` (default text)
- [ ] Stable JSON schema, versioned (`schema_version`)
- [ ] Prometheus text exposition at `zenith health --format prom`
- [ ] TLS certificate verification summary per node (expiry, issuer, days left)
- [ ] 5 second timeout flag, default from config
- [ ] Integration test per format
- [ ] Document the schema in docs/health-schema.md

## Order of work

1. JSON first: everything else builds on the same `HealthReport` struct.
2. Prometheus is a different rendering of the same struct, no new probes.
3. TLS verification adds probes, so it goes last behind its own flag.
'''
    return Sess(
        key="hero/claude-zenith-diagnostics-plan", agent="claude-code", project="zenith-cli",
        start=at("2026-10-09", "15:30"), minutes=38, model="claude-sonnet-5-5", hero=True, branch="feat/health-export",
        turns=[
            user("Make a plan and a checklist for adding health exports to zenith diagnostics: JSON, Prometheus metrics and a TLS verification summary. "
                 "Write it to docs/DIAGNOSTICS_PLAN.md and then start on the first item."),
            asst("I'll look at what `zenith health` prints today before planning around it.", [
                read("src/commands/health.rs", '''use crate::cluster::Cluster;
use crate::output::table;

pub struct NodeHealth {
    pub node: String,
    pub reachable: bool,
    pub latency_ms: Option<u64>,
    pub leader: bool,
}

pub fn run(cluster: &Cluster) -> anyhow::Result<()> {
    let nodes = cluster.probe_all()?;
    let rows: Vec<NodeHealth> = nodes
        .into_iter()
        .map(|n| NodeHealth { node: n.name, reachable: n.ok, latency_ms: n.latency_ms, leader: n.leader })
        .collect();
    table::print_health(&rows);
    Ok(())
}
'''),
                glob("src/output/*.rs", "src/output/mod.rs\nsrc/output/json.rs\nsrc/output/table.rs\nsrc/output/yaml.rs"),
            ]),
            asst("There is already an `output` module with JSON and table renderers, so the first item is mostly wiring. Writing the plan down with the order of work.", [
                write("docs/DIAGNOSTICS_PLAN.md", plan_md),
                todo(
                    ("Add --format json|text flag to zenith health", "in_progress", "Adding the --format flag to zenith health"),
                    ("Define a versioned JSON schema (HealthReport)", "pending", "Defining the versioned JSON schema"),
                    ("Prometheus text exposition", "pending", "Adding Prometheus text exposition"),
                    ("TLS certificate verification summary", "pending", "Adding the TLS verification summary"),
                    ("Integration test per format", "pending", "Writing integration tests per format"),
                ),
            ]),
            asst("Starting with the flag and a `HealthReport` struct that every format will render from. The report carries a `schema_version` from day one, because a monitoring job that parses it will outlive this change.", [
                todo(
                    ("Add --format json|text flag to zenith health", "in_progress", "Adding the --format flag to zenith health"),
                    ("Define a versioned JSON schema (HealthReport)", "in_progress", "Defining the versioned JSON schema"),
                    ("Prometheus text exposition", "pending", "Adding Prometheus text exposition"),
                    ("TLS certificate verification summary", "pending", "Adding the TLS verification summary"),
                    ("Integration test per format", "pending", "Writing integration tests per format"),
                ),
                read("src/output/json.rs", '''use serde::Serialize;

pub fn print<T: Serialize>(value: &T) -> anyhow::Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}
'''),
                edit("src/commands/health.rs",
                     'pub fn run(cluster: &Cluster) -> anyhow::Result<()> {\n    let nodes = cluster.probe_all()?;\n    let rows: Vec<NodeHealth> = nodes\n        .into_iter()\n        .map(|n| NodeHealth { node: n.name, reachable: n.ok, latency_ms: n.latency_ms, leader: n.leader })\n        .collect();\n    table::print_health(&rows);\n    Ok(())\n}',
                     '#[derive(Clone, Copy, PartialEq, Eq, clap::ValueEnum)]\npub enum Format {\n    Text,\n    Json,\n}\n\n#[derive(serde::Serialize)]\npub struct HealthReport {\n    pub schema_version: u32,\n    pub nodes: Vec<NodeHealth>,\n}\n\npub fn run(cluster: &Cluster, format: Format) -> anyhow::Result<()> {\n    let nodes = cluster.probe_all()?;\n    let rows: Vec<NodeHealth> = nodes\n        .into_iter()\n        .map(|n| NodeHealth { node: n.name, reachable: n.ok, latency_ms: n.latency_ms, leader: n.leader })\n        .collect();\n    match format {\n        Format::Text => table::print_health(&rows),\n        Format::Json => json::print(&HealthReport { schema_version: 1, nodes: rows })?,\n    }\n    Ok(())\n}', line=14),
                edit("src/commands/health.rs", "use crate::output::table;", "use crate::output::{json, table};", line=2),
                edit("src/commands/health.rs", "pub struct NodeHealth {", "#[derive(serde::Serialize)]\npub struct NodeHealth {", line=4),
            ]),
            asst("Now the CLI argument, and a test that checks the JSON shape instead of only checking that it parses: the version field, the node count and that `reachable` is a real boolean. That is the contract a dashboard will depend on, so it is worth pinning from the first commit.", [
                edit("src/main.rs",
                     "    Health,",
                     "    Health {\n        /// Output format: text (default) or json\n        #[arg(long, value_enum, default_value = \"text\")]\n        format: health::Format,\n    },", line=31),
                write("tests/health_json.rs", '''use assert_cmd::Command;
use serde_json::Value;

#[test]
fn health_json_has_a_versioned_schema() {
    let out = Command::cargo_bin("zenith")
        .unwrap()
        .args(["health", "--format", "json", "--cluster", "tests/fixtures/three-nodes.toml"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let v: Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["schema_version"], 1);
    assert_eq!(v["nodes"].as_array().unwrap().len(), 3);
    assert!(v["nodes"][0]["reachable"].is_boolean());
}
'''),
                bash("cargo test --test health_json --test cli",
                     '''   Compiling zenith v0.7.2 (/Users/fictional-dev/projects/zenith-cli)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 6.41s
     Running tests/cli.rs (target/debug/deps/cli-91b3c52e0d7f1a64)

running 6 tests
test help_lists_every_command ... ok
test ping_requires_a_cluster ... ok
test inspect_json_flag ... ok
test version_prints_semver ... ok
test unknown_flag_exits_with_usage_error ... ok
test health_text_matches_snapshot ... ok

test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.34s

     Running tests/health_json.rs (target/debug/deps/health_json-5d0c88e3a21b7f90)

running 1 test
test health_json_has_a_versioned_schema ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.21s''', desc="Run the CLI and the new JSON test"),
                todo(
                    ("Add --format json|text flag to zenith health", "completed", "Adding the --format flag to zenith health"),
                    ("Define a versioned JSON schema (HealthReport)", "completed", "Defining the versioned JSON schema"),
                    ("Prometheus text exposition", "in_progress", "Adding Prometheus text exposition"),
                    ("TLS certificate verification summary", "pending", "Adding the TLS verification summary"),
                    ("Integration test per format", "in_progress", "Writing integration tests per format"),
                ),
            ]),
            asst("The first two items are done and tested. Where things stand:\n\n"
                 "- [x] `--format json|text` on `zenith health` (default text)\n"
                 "- [x] Versioned JSON: `{ \"schema_version\": 1, \"nodes\": [...] }`\n"
                 "- [ ] Prometheus exposition (next: it renders the same `HealthReport`, no new probes)\n"
                 "- [ ] TLS verification summary (adds probes, so it goes behind its own flag)\n"
                 "- [ ] Integration test per format (JSON done)\n\n"
                 "```bash\nzenith health --format json | jq '.nodes[] | select(.reachable == false)'\n```\n\n"
                 "The plan is in `docs/DIAGNOSTICS_PLAN.md` and the checklist there matches this list. One decision for you: the schema starts at `schema_version: 1` with `reachable`, `latency_ms`, `leader` per node. Once a monitoring job depends on it we should only add fields, so tell me now if you want anything else in v1 (for example the node's software version)."),
        ],
    )


def sessions():
    return [radar_jitter(), burst_multiplier(), diagnostics_plan()]
