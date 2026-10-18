"""skyline-weather: nine filler sessions across five agents.

Files are tracked while the sessions are built (class F), so reads, greps, edits and test output
refer to the same text and the same line numbers throughout a session.
"""

import re

from .model import Call, Sess, asst, at, bash, edit, read, user, write


class F:
    """A fictional file whose content follows the edits made to it."""

    def __init__(self, path, text):
        self.path = path
        self.text = text.strip("\n") + "\n"

    def read(self, start=1, limit=None):
        lines = self.text.split("\n")[:-1]
        sel = lines[start - 1:(start - 1 + limit) if limit else None]
        return read(self.path, "\n".join(sel) + "\n", start=start, limit=limit)

    def edit(self, old, new):
        assert self.text.count(old) == 1, (self.path, old[:50], self.text.count(old))
        idx = self.text.index(old)
        line = self.text[:idx].count("\n") + 1
        self.text = self.text.replace(old, new)
        return edit(self.path, old, new, line=line)

    def between(self, start, end):
        i = self.text.index(start)
        j = self.text.index(end, i) + len(end)
        return self.text[i:j]

    def ln(self, sub, nth=0):
        hits = [i + 1 for i, l in enumerate(self.text.split("\n")) if sub in l]
        return hits[nth]

    def lines(self, a, b):
        ls = self.text.split("\n")
        return "\n".join(f"{i:>6}|{ls[i - 1]}" for i in range(a, b + 1))


def gr(pattern, path, *files, glob=None):
    from .model import grep
    out = []
    for f in files:
        for i, l in enumerate(f.text.split("\n")[:-1], 1):
            if re.search(pattern, l):
                out.append(f"{f.path}:{i}:{l}")
    return grep(pattern, path, "\n".join(out), glob=glob)


# ---------------------------------------------------------------------------
# 1. claude-code: retry with backoff and a rate limiter in the forecast client
# ---------------------------------------------------------------------------

def _forecast_backoff():
    api = F("src/api/forecast.ts", r'''
import { FORECAST_BASE_URL } from "../ingest/config";

export interface ForecastPoint {
  time: string;
  tempC: number;
  precipMm: number;
  windKph: number;
}

export interface Forecast {
  locationId: string;
  points: ForecastPoint[];
  fetchedAt: number;
}

export class ForecastError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ForecastError";
  }
}

export async function fetchForecast(
  locationId: string,
  signal?: AbortSignal,
): Promise<Forecast> {
  const url = `${FORECAST_BASE_URL}/v3/forecast/${encodeURIComponent(locationId)}?hours=48`;
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new ForecastError(res.status, `forecast request failed: ${res.status}`);
  }
  const body = await res.json();
  return { locationId, points: body.hourly, fetchedAt: Date.now() };
}
''')
    tst = F("src/api/forecast.test.ts", r'''
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchForecast, ForecastError } from "./forecast";

const okBody = {
  hourly: [{ time: "2026-09-30T15:00:00Z", tempC: 21.4, precipMm: 0, windKph: 12 }],
};

function jsonResponse(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchForecast", () => {
  it("returns parsed points on 200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, okBody));
    const f = await fetchForecast("hou-001");
    expect(f.locationId).toBe("hou-001");
    expect(f.points).toHaveLength(1);
  });

  it("throws ForecastError on a 500", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(500));
    await expect(fetchForecast("hou-001")).rejects.toBeInstanceOf(ForecastError);
  });
});
''')
    poller = F("src/ingest/poller.ts", "// stand-in so the callers grep below has real line numbers\n"
               "import { fetchForecast } from \"../api/forecast\";\n\n"
               "export async function refreshAll(ids: string[], signal: AbortSignal) {\n"
               "  return Promise.all(ids.map((id) => fetchForecast(id, signal)));\n}\n")
    chart = F("src/components/ForecastChart.tsx", "import { useEffect, useState } from \"react\";\n"
              "import { fetchForecast, type Forecast } from \"../api/forecast\";\n\n"
              "export function ForecastChart({ locationId }: { locationId: string }) {\n"
              "  const [data, setData] = useState<Forecast | null>(null);\n"
              "  useEffect(() => {\n"
              "    const ctl = new AbortController();\n"
              "    fetchForecast(locationId, ctl.signal).then(setData).catch(() => {});\n"
              "    return () => ctl.abort();\n"
              "  }, [locationId]);\n"
              "  return data ? <svg /> : null;\n}\n")

    t = []
    t.append(user("forecast client keeps getting 429s from the provider during the morning refresh, we fan out about 40 "
                  "locations at once. add exponential backoff with jitter and a client-side rate limiter in "
                  "src/api/forecast.ts, and honour Retry-After if they send it. vitest tests please"))
    t.append(asst("I'll read the client and its test, and see who calls it, before deciding where the limiter has to live.", [
        api.read(), tst.read(),
        gr(r"fetchForecast", "src", poller, chart),
    ]))

    # tests first
    c1 = tst.edit('import { fetchForecast, ForecastError } from "./forecast";',
                  'import { backoffDelay, fetchForecast, ForecastError, RateLimiter } from "./forecast";')
    c2 = tst.edit("afterEach(() => {\n  vi.restoreAllMocks();\n});",
                  "afterEach(() => {\n  vi.restoreAllMocks();\n  vi.useRealTimers();\n});")
    new_tests = r'''
    await expect(fetchForecast("hou-001")).rejects.toBeInstanceOf(ForecastError);
  });

  it("retries a 429 with backoff and then succeeds", async () => {
    vi.useFakeTimers();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(429))
      .mockResolvedValueOnce(jsonResponse(503))
      .mockResolvedValueOnce(jsonResponse(200, okBody));
    const pending = fetchForecast("hou-001", undefined, new RateLimiter(100, 100));
    await vi.runAllTimersAsync();
    const f = await pending;
    expect(spy).toHaveBeenCalledTimes(3);
    expect(f.points).toHaveLength(1);
  });

  it("honours Retry-After over the computed delay", async () => {
    vi.useFakeTimers();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(429, {}, { "retry-after": "2" }))
      .mockResolvedValueOnce(jsonResponse(200, okBody));
    const pending = fetchForecast("hou-001", undefined, new RateLimiter(100, 100));
    await vi.advanceTimersByTimeAsync(1999);
    expect(spy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(spy).toHaveBeenCalledTimes(2);
    await expect(pending).resolves.toMatchObject({ locationId: "hou-001" });
  });

  it("gives up after 4 retries and surfaces the status", async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse(503));
    const pending = fetchForecast("hou-001", undefined, new RateLimiter(100, 100));
    const assertion = expect(pending).rejects.toMatchObject({ status: 503 });
    await vi.runAllTimersAsync();
    await assertion;
    expect(spy).toHaveBeenCalledTimes(5);
  });
});

describe("backoffDelay", () => {
  it("grows with the attempt but never exceeds the cap", () => {
    expect(backoffDelay(0, undefined, () => 0.999)).toBeLessThan(400);
    expect(backoffDelay(2, undefined, () => 0.999)).toBeLessThan(1600);
    expect(backoffDelay(10, undefined, () => 0.999)).toBeLessThan(8000);
    expect(backoffDelay(3, undefined, () => 0)).toBe(0);
  });
});

describe("RateLimiter", () => {
  it("delays acquires beyond its burst capacity", async () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter(2, 1);
    const done: number[] = [];
    for (let i = 0; i < 3; i++) void limiter.acquire().then(() => done.push(i));
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toEqual([0, 1]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(done).toEqual([0, 1, 2]);
  });
});
'''.strip("\n")
    c3 = tst.edit('    await expect(fetchForecast("hou-001")).rejects.toBeInstanceOf(ForecastError);\n  });\n});',
                  new_tests)
    t.append(asst("Writing the tests first: retry on 429/503, Retry-After, the retry cap, the delay curve and the limiter's burst behaviour.", [
        c1, c2, c3,
        bash("npx vitest run src/api/forecast.test.ts",
             " RUN  v3.2.4 /Users/fictional-dev/projects/skyline-weather\n\n"
             " ❯ src/api/forecast.test.ts (7 tests | 5 failed) 29ms\n"
             "   ✓ fetchForecast > returns parsed points on 200\n"
             "   ✓ fetchForecast > throws ForecastError on a 500\n"
             "   × fetchForecast > retries a 429 with backoff and then succeeds\n"
             "     → forecast request failed: 429\n"
             "   × fetchForecast > honours Retry-After over the computed delay\n"
             "     → forecast request failed: 429\n"
             "   × fetchForecast > gives up after 4 retries and surfaces the status\n"
             "     → expected \"fetch\" to be called 5 times, but got 1 times\n"
             "   × backoffDelay > grows with the attempt but never exceeds the cap\n"
             "     → (0 , backoffDelay) is not a function\n"
             "   × RateLimiter > delays acquires beyond its burst capacity\n"
             "     → RateLimiter is not a constructor\n\n"
             " FAIL  src/api/forecast.test.ts > fetchForecast > retries a 429 with backoff and then succeeds\n"
             "ForecastError: forecast request failed: 429\n"
             " ❯ fetchForecast src/api/forecast.ts:" + str(api.ln("throw new ForecastError")) + ":11\n"
             + api.lines(api.ln("throw new ForecastError") - 2, api.ln("throw new ForecastError") + 1)+ "\n\n"
             " Test Files  1 failed (1)\n"
             "      Tests  5 failed | 2 passed (7)\n"
             "   Duration  611ms (transform 48ms, setup 0ms, collect 61ms, tests 29ms, environment 0ms, prepare 83ms)",
             error=True, desc="Run the forecast tests (expect red)"),
    ]))

    # implementation, with the seconds-vs-milliseconds slip
    old_fn = api.between("export async function fetchForecast(", "  return { locationId, points: body.hourly, fetchedAt: Date.now() };\n}\n")
    new_impl = r'''
const MAX_RETRIES = 4;
const BASE_DELAY_MS = 400;
const MAX_DELAY_MS = 8_000;
const RETRYABLE = new Set([429, 502, 503, 504]);

/** Full-jitter exponential backoff: a random delay in [0, min(cap, base * 2^attempt)). */
export function backoffDelay(
  attempt: number,
  retryAfterMs?: number,
  rand: () => number = Math.random,
): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, MAX_DELAY_MS * 4);
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.floor(rand() * ceiling);
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return secs;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Token bucket: `capacity` requests in a burst, then `refillPerSec` sustained. */
export class RateLimiter {
  private tokens: number;
  private last: number;
  private queue: Array<() => void> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  acquire(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.drain();
    });
  }

  private refill() {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.refillPerSec);
    this.last = t;
  }

  private drain() {
    this.refill();
    while (this.queue.length > 0 && this.tokens >= 1) {
      this.tokens -= 1;
      this.queue.shift()!();
    }
    if (this.queue.length > 0 && this.timer === null) {
      const waitMs = Math.ceil(((1 - this.tokens) / this.refillPerSec) * 1000);
      this.timer = setTimeout(() => {
        this.timer = null;
        this.drain();
      }, waitMs);
    }
  }
}

const defaultLimiter = new RateLimiter(8, 4);

export async function fetchForecast(
  locationId: string,
  signal?: AbortSignal,
  limiter: RateLimiter = defaultLimiter,
): Promise<Forecast> {
  const url = `${FORECAST_BASE_URL}/v3/forecast/${encodeURIComponent(locationId)}?hours=48`;
  for (let attempt = 0; ; attempt++) {
    await limiter.acquire();
    const res = await fetch(url, { signal });
    if (res.ok) {
      const body = await res.json();
      return { locationId, points: body.hourly, fetchedAt: Date.now() };
    }
    if (!RETRYABLE.has(res.status) || attempt >= MAX_RETRIES) {
      throw new ForecastError(res.status, `forecast request failed: ${res.status}`);
    }
    await sleep(backoffDelay(attempt, parseRetryAfter(res.headers.get("retry-after"))));
  }
}
'''.strip("\n") + "\n"
    c4 = api.edit(old_fn, new_impl)
    l_ra = tst.ln("expect(spy).toHaveBeenCalledTimes(1);")
    t.append(asst("Now the client: a token bucket in front of every attempt, full-jitter backoff between attempts, and Retry-After taking priority when the provider sends one.", [
        c4,
        bash("npx vitest run src/api/forecast.test.ts",
             " RUN  v3.2.4 /Users/fictional-dev/projects/skyline-weather\n\n"
             " ❯ src/api/forecast.test.ts (7 tests | 1 failed) 44ms\n"
             "   × fetchForecast > honours Retry-After over the computed delay\n"
             "     → expected \"fetch\" to be called 1 times, but got 2 times\n\n"
             " FAIL  src/api/forecast.test.ts > fetchForecast > honours Retry-After over the computed delay\n"
             "AssertionError: expected \"fetch\" to be called 1 times, but got 2 times\n"
             " ❯ src/api/forecast.test.ts:" + str(l_ra) + ":19\n"
             + tst.lines(l_ra - 2, l_ra + 1) + "\n"
             "                  ^\n\n"
             " Test Files  1 failed (1)\n"
             "      Tests  1 failed | 6 passed (7)\n"
             "   Duration  587ms (transform 41ms, setup 0ms, collect 58ms, tests 44ms, environment 0ms, prepare 79ms)",
             error=True, desc="Run the forecast tests again"),
    ]))
    c5 = api.edit("  if (Number.isFinite(secs)) return secs;", "  if (Number.isFinite(secs)) return secs * 1000;")
    t.append(asst("Six of seven pass. The Retry-After failure is mine: the header is in seconds and `parseRetryAfter` handed it back unconverted, so a 2 second wait became 2 ms.", [
        c5,
        bash("npx vitest run src/api/forecast.test.ts",
             " RUN  v3.2.4 /Users/fictional-dev/projects/skyline-weather\n\n"
             " ✓ src/api/forecast.test.ts (7 tests) 38ms\n\n"
             " Test Files  1 passed (1)\n"
             "      Tests  7 passed (7)\n"
             "   Start at  15:33:09\n"
             "   Duration  574ms (transform 39ms, setup 0ms, collect 55ms, tests 38ms, environment 0ms, prepare 77ms)",
             desc="Run the forecast tests again"),
    ]))
    t.append(asst("All seven pass. `fetchForecast` now waits for a token before every attempt (burst of 8, then 4 per second by default), "
                  "retries 429, 502, 503 and 504 up to 4 times with full-jitter backoff capped at 8 s, and uses `Retry-After` when present."))

    t.append(user("is the limiter shared between the radar poller and the ForecastChart, or does each call get its own? "
                  "if one request gets a 429 I'd want everyone to slow down, not just that one", think=55))
    old_f = api.between("  private timer: ReturnType<typeof setTimeout> | null = null;\n", "  constructor(")
    e1 = api.edit(old_f, "  private timer: ReturnType<typeof setTimeout> | null = null;\n  private blockedUntil = 0;\n\n  constructor(")
    old_drain = api.between("  private drain() {", "      }, waitMs);\n    }\n  }\n")
    new_drain = r'''
  /** A 429 means the provider wants everyone to back off, not just the request that got it. */
  penalize(ms: number) {
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + ms);
  }

  private drain() {
    this.refill();
    const blockedMs = this.blockedUntil - this.now();
    if (blockedMs > 0) {
      this.schedule(blockedMs);
      return;
    }
    while (this.queue.length > 0 && this.tokens >= 1) {
      this.tokens -= 1;
      this.queue.shift()!();
    }
    if (this.queue.length > 0) {
      this.schedule(Math.ceil(((1 - this.tokens) / this.refillPerSec) * 1000));
    }
  }

  private schedule(waitMs: number) {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.drain();
    }, waitMs);
  }
'''.strip("\n") + "\n"
    e2 = api.edit(old_drain, new_drain)
    e3 = api.edit('    await sleep(backoffDelay(attempt, parseRetryAfter(res.headers.get("retry-after"))));',
                  '    const delay = backoffDelay(attempt, parseRetryAfter(res.headers.get("retry-after")));\n'
                  '    if (res.status === 429) limiter.penalize(delay);\n'
                  '    await sleep(delay);')
    shared_test = r'''
  it("a 429 pauses other callers that share the limiter", async () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter(100, 100);
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(429, {}, { "retry-after": "2" }))
      .mockResolvedValueOnce(jsonResponse(200, okBody))
      .mockResolvedValueOnce(jsonResponse(200, okBody));
    const a = fetchForecast("hou-001", undefined, limiter);
    await vi.advanceTimersByTimeAsync(10);
    const b = fetchForecast("hou-002", undefined, limiter);
    await vi.advanceTimersByTimeAsync(1989);
    expect(spy).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    await expect(Promise.all([a, b])).resolves.toHaveLength(2);
    expect(spy).toHaveBeenCalledTimes(3);
  });
'''
    e4 = tst.edit('  it("gives up after 4 retries and surfaces the status", async () => {',
                  shared_test.strip("\n") + '\n\n  it("gives up after 4 retries and surfaces the status", async () => {')
    t.append(asst("Both callers use the module-level default limiter, so the bucket is shared. But a 429 only slows the request that got it, and the others keep draining tokens. I'll add `penalize()` so a 429 blocks the whole bucket until the provider's window has passed.", [
        gr(r"fetchForecast\(", "src", poller, chart),
        e1, e2, e3, e4,
        bash("npx vitest run src/api src/ingest",
             " RUN  v3.2.4 /Users/fictional-dev/projects/skyline-weather\n\n"
             " ✓ src/api/forecast.test.ts (8 tests) 47ms\n"
             " ✓ src/ingest/poller.test.ts (5 tests) 22ms\n\n"
             " Test Files  2 passed (2)\n"
             "      Tests  13 passed (13)\n"
             "   Start at  15:49:26\n"
             "   Duration  702ms (transform 66ms, setup 0ms, collect 94ms, tests 69ms, environment 0ms, prepare 120ms)",
             desc="Run the api and ingest tests"),
        bash("npx tsc --noEmit", "(no output)", desc="Typecheck"),
    ]))
    t.append(asst(
        "Yes, it is shared, and a 429 now slows everyone down.\n\n"
        "- `fetchForecast` takes an optional `limiter` and defaults to one module-level `RateLimiter(8, 4)`, so `poller.ts` and `ForecastChart.tsx` draw from the same bucket.\n"
        "- On a 429 the request calls `limiter.penalize(delay)`, which blocks every queued `acquire()` until that delay has passed. Other retryable statuses (502, 503, 504) only back off the request that saw them.\n"
        "- `Retry-After` accepts seconds or an HTTP date; it was returning raw seconds at first and the test caught it.\n"
        "- New test: a second location requested during the pause does not reach `fetch` until the pause is over.\n\n"
        "```ts\n"
        "const delay = backoffDelay(attempt, parseRetryAfter(res.headers.get(\"retry-after\")));\n"
        "if (res.status === 429) limiter.penalize(delay);\n"
        "await sleep(delay);\n"
        "```\n\n"
        "`vitest` is green (13 tests across `src/api` and `src/ingest`) and `tsc --noEmit` is clean. One gap: `sleep` ignores the `AbortSignal`, "
        "so a component that unmounts mid-backoff leaves a timer behind until it fires. Easy to add if you want it."))
    return Sess(key="skyline-weather/claude-code/forecast-backoff", agent="claude-code", project="skyline-weather",
                start=at("2026-09-30", "15:10"), minutes=52, model="claude-sonnet-5-5", branch="forecast-retry",
                title="Retry with backoff and rate limiter in forecast client", turns=t)


# ---------------------------------------------------------------------------
# 2. claude-code: double storm alert + flaky dedupe test
# ---------------------------------------------------------------------------

def _storm_dedupe():
    dd = F("src/alerts/dedupe.ts", r'''
import type { StormCell } from "./types";

export interface DedupeOptions {
  ttlMs: number;
}

export class AlertDedupe {
  private seen = new Map<string, number>();

  constructor(private readonly opts: DedupeOptions = { ttlMs: 10 * 60_000 }) {}

  key(cell: StormCell): string {
    return `${cell.id}:${cell.maxDbz}`;
  }

  shouldFire(cell: StormCell): boolean {
    const k = this.key(cell);
    const now = Date.now();
    const last = this.seen.get(k);
    if (last !== undefined && now - last < this.opts.ttlMs) return false;
    this.seen.set(k, now);
    return true;
  }
}
''')
    mon = F("src/alerts/stormAlert.ts", r'''
import { AlertDedupe } from "./dedupe";
import { SEVERE_DBZ } from "./thresholds";
import type { StormAlert, StormCell } from "./types";

export interface AlertSink {
  push(alert: StormAlert): void;
}

export class StormAlertMonitor {
  constructor(
    private readonly dedupe: AlertDedupe,
    private readonly sink: AlertSink,
  ) {}

  /** Called for every radar frame with the tracked cells. */
  onFrame(cells: StormCell[]): void {
    for (const cell of cells) {
      if (cell.maxDbz < SEVERE_DBZ) continue;
      if (!this.dedupe.shouldFire(cell)) continue;
      this.sink.push({ cellId: cell.id, maxDbz: cell.maxDbz, at: Date.now() });
    }
  }
}
''')
    th = F("src/alerts/thresholds.ts", "/** Reflectivity (dBZ) at which a cell becomes a severe storm alert. */\n"
           "export const SEVERE_DBZ = 50;\n\n/** Reflectivity at which the alert is upgraded to extreme. */\nexport const EXTREME_DBZ = 60;\n")
    tst = F("src/alerts/dedupe.test.ts", r'''
import { describe, expect, it } from "vitest";
import { AlertDedupe } from "./dedupe";
import type { StormCell } from "./types";

const cell: StormCell = { id: "cell-17", maxDbz: 52.4, lat: 29.78, lon: -95.82 };

describe("AlertDedupe", () => {
  it("suppresses a repeat inside the ttl", () => {
    const d = new AlertDedupe({ ttlMs: 60_000 });
    expect(d.shouldFire(cell)).toBe(true);
    expect(d.shouldFire(cell)).toBe(false);
  });

  it("fires again after the ttl expires", async () => {
    const d = new AlertDedupe({ ttlMs: 50 });
    expect(d.shouldFire(cell)).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(d.shouldFire(cell)).toBe(true);
  });

  it("keeps different cells apart", () => {
    const d = new AlertDedupe({ ttlMs: 60_000 });
    expect(d.shouldFire(cell)).toBe(true);
    expect(d.shouldFire({ ...cell, id: "cell-18" })).toBe(true);
  });
});
''')
    t = []
    t.append(user("Got a report from the Katy beta group: two push alerts for the same storm cell about a minute apart. "
                  "dedupe is supposed to stop that. can you figure out why? the dedupe test has also been a flaky test on CI "
                  "all week so it might be related"))
    t.append(asst("Starting with the dedupe module, the monitor that calls it, and the test that keeps failing on CI.", [
        gr(r"shouldFire", "src", dd, mon, tst),
        dd.read(), mon.read(), th.read(), tst.read(),
    ]))
    t.append(asst("Two separate problems already visible. `key()` includes the raw `maxDbz`, so a cell wobbling from 52.4 to 52.9 dBZ gets a new key and a new alert. "
                  "And the ttl test sleeps for exactly its 50 ms ttl on the real clock. I'll check the second one actually flakes before I trust that reading.", [
        bash("for i in $(seq 1 12); do npx vitest run src/alerts/dedupe.test.ts 2>&1 | grep -E \"^\\s+Tests\"; done | sort | uniq -c",
             "     10      Tests  3 passed (3)\n      2      Tests  1 failed | 2 passed (3)",
             desc="Run the dedupe test 12 times and count outcomes"),
    ]))
    t.append(user("ok so two bugs. fix both, test first please, and no sleeping in tests", think=40))

    ttl_old = tst.between('  it("fires again after the ttl expires", async () => {', "    expect(d.shouldFire(cell)).toBe(true);\n  });\n\n  it(\"keeps different")
    ttl_old = ttl_old[: ttl_old.rindex("\n\n  it(\"keeps different")] + "\n"
    ttl_new = r'''
  it("fires again after the ttl expires", () => {
    let t = 1_000;
    const d = new AlertDedupe({ ttlMs: 50 }, () => t);
    expect(d.shouldFire(cell)).toBe(true);
    t += 49;
    expect(d.shouldFire(cell)).toBe(false);
    t += 1;
    expect(d.shouldFire(cell)).toBe(true);
  });

  it("treats one cell as one alert while maxDbz jitters inside a band", () => {
    const d = new AlertDedupe({ ttlMs: 60_000 });
    expect(d.shouldFire({ ...cell, maxDbz: 52.4 })).toBe(true);
    expect(d.shouldFire({ ...cell, maxDbz: 52.9 })).toBe(false);
    expect(d.shouldFire({ ...cell, maxDbz: 51.2 })).toBe(false);
  });

  it("fires again when the cell escalates to extreme", () => {
    const d = new AlertDedupe({ ttlMs: 60_000 });
    expect(d.shouldFire({ ...cell, maxDbz: 55 })).toBe(true);
    expect(d.shouldFire({ ...cell, maxDbz: 61.5 })).toBe(true);
  });
'''.strip("\n") + "\n"
    et = tst.edit(ttl_old, ttl_new)
    l_jit = tst.ln("expect(d.shouldFire({ ...cell, maxDbz: 52.9 })).toBe(false);")
    l_ttl = tst.ln("t += 49;") + 1
    t.append(asst("Replacing the sleep with an injected clock, and adding the jitter and escalation cases.", [
        et,
        bash("npx vitest run src/alerts/dedupe.test.ts",
             " RUN  v3.2.4 /Users/fictional-dev/projects/skyline-weather\n\n"
             " ❯ src/alerts/dedupe.test.ts (5 tests | 2 failed) 9ms\n"
             "   × AlertDedupe > fires again after the ttl expires\n"
             "   × AlertDedupe > treats one cell as one alert while maxDbz jitters inside a band\n\n"
             " FAIL  src/alerts/dedupe.test.ts > AlertDedupe > fires again after the ttl expires\n"
             "AssertionError: expected false to be true\n"
             " ❯ src/alerts/dedupe.test.ts:" + str(l_ttl + 2) + ":36\n\n"
             " FAIL  src/alerts/dedupe.test.ts > AlertDedupe > treats one cell as one alert while maxDbz jitters inside a band\n"
             "AssertionError: expected true to be false\n"
             " ❯ src/alerts/dedupe.test.ts:" + str(l_jit) + ":50\n"
             + tst.lines(l_jit - 1, l_jit + 1) + "\n\n"
             " Test Files  1 failed (1)\n"
             "      Tests  2 failed | 3 passed (5)",
             error=True, desc="Run the dedupe tests (expect red)"),
    ]))
    dedupe_new = r'''
import { EXTREME_DBZ, SEVERE_DBZ } from "./thresholds";
import type { StormCell } from "./types";

export interface DedupeOptions {
  ttlMs: number;
}

/** Alerts are per cell and per severity band, never per raw reflectivity reading. */
function band(dbz: number): "watch" | "severe" | "extreme" {
  if (dbz >= EXTREME_DBZ) return "extreme";
  return dbz >= SEVERE_DBZ ? "severe" : "watch";
}

export class AlertDedupe {
  private seen = new Map<string, number>();

  constructor(
    private readonly opts: DedupeOptions = { ttlMs: 10 * 60_000 },
    private readonly now: () => number = Date.now,
  ) {}

  key(cell: StormCell): string {
    return `${cell.id}:${band(cell.maxDbz)}`;
  }

  shouldFire(cell: StormCell): boolean {
    const k = this.key(cell);
    const now = this.now();
    const last = this.seen.get(k);
    if (last !== undefined && now - last < this.opts.ttlMs) return false;
    this.seen.set(k, now);
    return true;
  }
}
'''.strip("\n") + "\n"
    ed1 = dd.edit('import type { StormCell } from "./types";\n\nexport interface DedupeOptions {\n  ttlMs: number;\n}\n',
                  dedupe_new.split("export class AlertDedupe")[0])
    ed2 = dd.edit('  constructor(private readonly opts: DedupeOptions = { ttlMs: 10 * 60_000 }) {}',
                  '  constructor(\n    private readonly opts: DedupeOptions = { ttlMs: 10 * 60_000 },\n    private readonly now: () => number = Date.now,\n  ) {}')
    ed3 = dd.edit('    return `${cell.id}:${cell.maxDbz}`;', '    return `${cell.id}:${band(cell.maxDbz)}`;')
    ed4 = dd.edit('    const now = Date.now();\n', '    const now = this.now();\n')
    t.append(asst("Both reds are the two bugs. The key now uses the severity band, so jitter inside a band is one alert and a jump to 60+ dBZ is a new one. The clock is injectable.", [
        ed1, ed2, ed3, ed4,
        bash("npx vitest run src/alerts/dedupe.test.ts",
             " RUN  v3.2.4 /Users/fictional-dev/projects/skyline-weather\n\n"
             " ✓ src/alerts/dedupe.test.ts (5 tests) 6ms\n\n"
             " Test Files  1 passed (1)\n"
             "      Tests  5 passed (5)\n"
             "   Duration  412ms",
             desc="Run the dedupe tests"),
        bash("for i in $(seq 1 20); do npx vitest run src/alerts/dedupe.test.ts --reporter=dot 2>&1 | grep -c failed; done | sort | uniq -c",
             "     20 0", desc="Run the dedupe test 20 times and count failures"),
    ]))
    t.append(asst("Green, and 20 runs in a row with no failures (it was failing 2 in 12 before). `StormAlertMonitor` itself needs no change."))
    t.append(user("what about the seen map, does it ever shrink? this runs all day in the background tab", think=35))
    pr_old = "    const k = this.key(cell);\n    const now = this.now();\n    const last = this.seen.get(k);\n"
    e5 = dd.edit(pr_old, "    const now = this.now();\n    if (this.seen.size > MAX_ENTRIES) this.prune(now);\n    const k = this.key(cell);\n    const last = this.seen.get(k);\n")
    e6 = dd.edit("export class AlertDedupe {", "const MAX_ENTRIES = 256;\n\nexport class AlertDedupe {")
    e7 = dd.edit("    this.seen.set(k, now);\n    return true;\n  }\n}\n",
                 "    this.seen.set(k, now);\n    return true;\n  }\n\n  get size(): number {\n    return this.seen.size;\n  }\n\n"
                 "  private prune(now: number): void {\n    for (const [k, at] of this.seen) {\n"
                 "      if (now - at >= this.opts.ttlMs) this.seen.delete(k);\n    }\n  }\n}\n")
    e8 = tst.edit('  it("keeps different cells apart", () => {',
                  '  it("drops expired entries once the map gets large", () => {\n    let t = 0;\n'
                  '    const d = new AlertDedupe({ ttlMs: 1_000 }, () => t);\n'
                  '    for (let i = 0; i < 300; i++) d.shouldFire({ ...cell, id: `cell-${i}` });\n'
                  '    expect(d.size).toBe(300);\n    t += 1_000;\n    d.shouldFire({ ...cell, id: "cell-new" });\n'
                  '    expect(d.size).toBe(1);\n  });\n\n  it("keeps different cells apart", () => {')
    t.append(asst("It never shrinks, entries only get overwritten. I'll prune expired keys whenever the map passes 256 entries, with a test.", [
        e5, e6, e7, e8,
        bash("npx vitest run src/alerts",
             " RUN  v3.2.4 /Users/fictional-dev/projects/skyline-weather\n\n"
             " ✓ src/alerts/dedupe.test.ts (6 tests) 8ms\n"
             " ✓ src/alerts/stormAlert.test.ts (4 tests) 11ms\n\n"
             " Test Files  2 passed (2)\n"
             "      Tests  10 passed (10)\n"
             "   Duration  448ms",
             desc="Run all alert tests"),
    ]))
    t.append(asst(
        "Fixed the double alert and the flaky test, and capped the dedupe map.\n\n"
        "- **Double alert:** `AlertDedupe.key()` used the raw `maxDbz` (`cell-17:52.4`), so any change in the reading was a new key. It now uses the severity band, so `cell-17:severe` stays one alert until the cell reaches 60 dBZ and becomes `cell-17:extreme`, which does fire again.\n"
        "- **Flaky test:** the ttl test slept 50 ms on the real clock against a 50 ms ttl, so a timer firing at 49.x ms on a busy CI box failed it. `AlertDedupe` now takes a `now()` function and the test advances a plain number.\n"
        "- **Memory:** expired entries are pruned once the map passes 256 keys.\n\n"
        "```ts\n"
        "key(cell: StormCell): string {\n"
        "  return `${cell.id}:${band(cell.maxDbz)}`;\n"
        "}\n"
        "```\n\n"
        "`src/alerts` is at 10 passing tests. I did not touch `stormAlert.ts`."))
    return Sess(key="skyline-weather/claude-code/storm-alert-dedupe", agent="claude-code", project="skyline-weather",
                start=at("2026-10-08", "19:05"), minutes=44, model="claude-sonnet-5-5", branch="fix-double-alert",
                title="Fix double storm alert and flaky dedupe test", turns=t)


# ---------------------------------------------------------------------------
# shared original of RadarSweep.ts (sessions 3 and 6)
# ---------------------------------------------------------------------------

def _radar_sweep():
    return F("src/radar/RadarSweep.ts", r'''
import type { CustomLayerInterface, Map as MapLibreMap } from "maplibre-gl";
import { createProgram } from "./gl";
import { projectGate } from "./geo";
import type { RadarFrame } from "./types";
import sweepVert from "./shaders/sweep.vert.glsl?raw";
import sweepFrag from "./shaders/sweep.frag.glsl?raw";

export interface ColorStop {
  value: number; // radial velocity in m/s, negative is toward the radar
  color: [number, number, number];
}

export const VELOCITY_STOPS: ReadonlyArray<ColorStop> = [
  { value: -30, color: [0, 158, 96] },
  { value: -10, color: [102, 204, 153] },
  { value: 0, color: [150, 150, 150] },
  { value: 10, color: [230, 140, 120] },
  { value: 30, color: [200, 30, 40] },
];

const RAYS = 360;
const GATES_PER_RAY = 460;

export class RadarSweep implements CustomLayerInterface {
  readonly id = "doppler-sweep";
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;

  private gl!: WebGLRenderingContext;
  private program!: WebGLProgram;
  private positions = new Float32Array(RAYS * GATES_PER_RAY * 2);
  private positionBuffer!: WebGLBuffer;
  private velocityBuffer!: WebGLBuffer;
  private frame: RadarFrame | null = null;

  onAdd(_map: MapLibreMap, gl: WebGLRenderingContext) {
    this.gl = gl;
    this.program = createProgram(gl, sweepVert, sweepFrag);
    this.positionBuffer = gl.createBuffer()!;
    this.velocityBuffer = gl.createBuffer()!;
  }

  setFrame(frame: RadarFrame) {
    this.frame = frame;
    this.rebuildGeometry(frame);
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.velocityBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, frame.velocities, gl.DYNAMIC_DRAW);
  }

  private rebuildGeometry(frame: RadarFrame) {
    let o = 0;
    for (let ray = 0; ray < RAYS; ray++) {
      const azimuth = (ray * Math.PI) / 180;
      for (let gate = 0; gate < GATES_PER_RAY; gate++) {
        const [x, y] = projectGate(frame.origin, azimuth, gate * frame.gateSpacingM);
        this.positions[o++] = x;
        this.positions[o++] = y;
      }
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.positions, gl.DYNAMIC_DRAW);
  }

  render(gl: WebGLRenderingContext, matrix: number[]) {
    if (!this.frame) return;
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.program, "u_matrix"), false, matrix);
    this.bindAttribute("a_position", this.positionBuffer, 2);
    this.bindAttribute("a_velocity", this.velocityBuffer, 1);
    gl.drawArrays(gl.POINTS, 0, RAYS * GATES_PER_RAY);
  }

  private bindAttribute(name: string, buffer: WebGLBuffer, size: number) {
    const gl = this.gl;
    const loc = gl.getAttribLocation(this.program, name);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  }
}
''')


# ---------------------------------------------------------------------------
# 3. cursor-cli: colour gradient legend for the velocity map
# ---------------------------------------------------------------------------

def _legend():
    sweep = _radar_sweep()
    panel = F("src/components/RadarPanel.tsx", "import { RadarMap } from \"./RadarMap\";\n"
              "import { Toolbar } from \"./Toolbar\";\n\nexport function RadarPanel() {\n"
              "  return (\n    <section className=\"radar-panel\">\n      <Toolbar />\n      <RadarMap />\n    </section>\n  );\n}\n")
    legend = r'''
import { VELOCITY_STOPS, type ColorStop } from "./RadarSweep";

export type SpeedUnit = "m/s" | "kt";

const MS_TO_KT = 1.943844;

export interface LegendTick {
  /** radial velocity in m/s */
  value: number;
  /** 0 at the left end of the bar, 1 at the right */
  offset: number;
  label: string;
}

/** CSS gradient with the same stops, in the same order, as the shader ramp. */
export function gradientCss(stops: ReadonlyArray<ColorStop> = VELOCITY_STOPS): string {
  const lo = stops[0].value;
  const span = stops[stops.length - 1].value - lo;
  const parts = stops.map((s) => {
    const pct = (((s.value - lo) / span) * 100).toFixed(1);
    return `rgb(${s.color.join(", ")}) ${pct}%`;
  });
  return `linear-gradient(to right, ${parts.join(", ")})`;
}

export function legendTicks(
  count = 7,
  unit: SpeedUnit = "m/s",
  stops: ReadonlyArray<ColorStop> = VELOCITY_STOPS,
): LegendTick[] {
  const lo = stops[0].value;
  const hi = stops[stops.length - 1].value;
  return Array.from({ length: count }, (_, i) => {
    const offset = i / (count - 1);
    const ms = lo + offset * (hi - lo);
    return { value: ms, offset, label: formatTick(unit === "kt" ? ms * MS_TO_KT : ms) };
  });
}

function formatTick(v: number): string {
  const r = Math.round(v);
  return r > 0 ? `+${r}` : String(r);
}
'''.strip("\n") + "\n"
    test = r'''
import { describe, expect, it } from "vitest";
import { gradientCss, legendTicks } from "./legend";

describe("velocity legend", () => {
  it("builds a gradient from the shader stops", () => {
    expect(gradientCss()).toBe(
      "linear-gradient(to right, rgb(0, 158, 96) 0.0%, rgb(102, 204, 153) 33.3%, rgb(150, 150, 150) 50.0%, " +
        "rgb(230, 140, 120) 66.7%, rgb(200, 30, 40) 100.0%)",
    );
  });

  it("labels seven ticks from -30 to +30 m/s", () => {
    expect(legendTicks().map((t) => t.label)).toEqual(["-30", "-20", "-10", "0", "+10", "+20", "+30"]);
  });

  it("converts to knots", () => {
    expect(legendTicks(3, "kt").map((t) => t.label)).toEqual(["-58", "0", "+58"]);
  });
});
'''.strip("\n") + "\n"
    t = []
    t.append(user("Add a colour gradient legend for the Doppler radar sweep velocity map. New file src/radar/legend.ts, "
                  "should use exactly the stops the shader uses (green toward the radar, grey at zero, red away), "
                  "range -30 to +30 m/s, with tick labels. Knots as an option too."))
    t.append(asst("First the stop table the shader ramp is built from, and where the radar panel is mounted.", [
        gr(r"VELOCITY_STOPS|ColorStop", "src", sweep, panel),
        sweep.read(11, 12),
    ]))
    t.append(asst("The stops are exported from `RadarSweep.ts` as `VELOCITY_STOPS`, so the legend can import them and never drift from the shader. "
                  "Writing `legend.ts` with a CSS gradient builder and a tick generator, plus tests.", [
        write("src/radar/legend.ts", legend),
        write("src/radar/legend.test.ts", test),
        bash("npx vitest run src/radar/legend.test.ts",
             " RUN  v3.2.4 /Users/fictional-dev/projects/skyline-weather\n\n"
             " ✓ src/radar/legend.test.ts (3 tests) 4ms\n\n Test Files  1 passed (1)\n      Tests  3 passed (3)\n   Duration  301ms",
             desc="Run the legend tests"),
    ]))
    t.append(user("good. 7 ticks will be too crowded on a phone, what happens at 320px wide?", think=45))
    t.append(asst(
        "`legendTicks(count)` takes the tick count, so the panel decides. At 320px I'd pass `3` (-30, 0, +30) and keep 7 above roughly 480px.\n\n"
        "- `gradientCss()` is independent of the tick count, the bar always shows the full ramp.\n"
        "- Offsets are fractions of the bar width, so the labels can be positioned with `left: calc(offset * 100%)` and no width maths.\n"
        "- I have not mounted it in `RadarPanel.tsx` yet; that needs a decision on where the bar sits relative to the toolbar.\n\n"
        "```ts\n"
        "const ticks = legendTicks(width < 480 ? 3 : 7, unit);\n"
        "```\n\n"
        "Three tests pass: gradient string, m/s labels and knot labels (-58, 0, +58)."))
    return Sess(key="skyline-weather/cursor-cli/velocity-legend", agent="cursor-cli", project="skyline-weather",
                start=at("2026-09-28", "16:30"), minutes=26, model="claude-sonnet-5-5",
                title="Add velocity legend for Doppler radar map", turns=t)


# ---------------------------------------------------------------------------
# 4. cursor-cli: tile cache to IndexedDB
# ---------------------------------------------------------------------------

def _tile_idb():
    tc = F("src/radar/TileCache.ts", r'''
export interface TileKey {
  z: number;
  x: number;
  y: number;
  product: string;
}

export interface CachedTile {
  key: string;
  data: ArrayBuffer;
  fetchedAt: number;
}

const MAX_TILES = 512;
const TILE_TTL_MS = 6 * 60_000;

export const tileId = (k: TileKey) => `${k.product}/${k.z}/${k.x}/${k.y}`;

export class TileCache {
  private tiles = new Map<string, CachedTile>();

  get(key: TileKey): CachedTile | undefined {
    const id = tileId(key);
    const hit = this.tiles.get(id);
    if (!hit) return undefined;
    if (Date.now() - hit.fetchedAt > TILE_TTL_MS) {
      this.tiles.delete(id);
      return undefined;
    }
    // refresh recency
    this.tiles.delete(id);
    this.tiles.set(id, hit);
    return hit;
  }

  set(key: TileKey, data: ArrayBuffer): void {
    const id = tileId(key);
    this.tiles.set(id, { key: id, data, fetchedAt: Date.now() });
    if (this.tiles.size > MAX_TILES) {
      const oldest = this.tiles.keys().next().value as string;
      this.tiles.delete(oldest);
    }
  }
}
''')
    user_f = F("src/radar/RadarSource.ts", "import { TileCache, type TileKey } from \"./TileCache\";\n\n"
               "const cache = new TileCache();\n\nexport async function loadTile(key: TileKey): Promise<ArrayBuffer> {\n"
               "  const hit = cache.get(key);\n  if (hit) return hit.data;\n  const data = await fetchTileBytes(key);\n"
               "  cache.set(key, data);\n  return data;\n}\n\ndeclare function fetchTileBytes(key: TileKey): Promise<ArrayBuffer>;\n")
    store = r'''
import type { CachedTile } from "./TileCache";

export const OFFLINE_TTL_MS = 6 * 60 * 60_000;

export interface OfflineStore {
  get(id: string): Promise<CachedTile | undefined>;
  put(tile: CachedTile): Promise<void>;
  /** Delete tiles older than the offline ttl. Returns how many were removed. */
  prune(now?: number): Promise<number>;
}

const STORE = "tiles";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function createIdbStore(dbName = "skyline-tiles"): OfflineStore {
  let opened: Promise<IDBDatabase> | null = null;

  const open = () =>
    (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        const os = req.result.createObjectStore(STORE, { keyPath: "key" });
        os.createIndex("fetchedAt", "fetchedAt");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));

  return {
    async get(id) {
      const db = await open();
      const tile = await request<CachedTile | undefined>(db.transaction(STORE).objectStore(STORE).get(id));
      return tile && Date.now() - tile.fetchedAt <= OFFLINE_TTL_MS ? tile : undefined;
    },
    async put(tile) {
      const db = await open();
      await request(db.transaction(STORE, "readwrite").objectStore(STORE).put(tile));
    },
    async prune(now = Date.now()) {
      const db = await open();
      const os = db.transaction(STORE, "readwrite").objectStore(STORE);
      const stale = await request<IDBValidKey[]>(
        os.index("fetchedAt").getAllKeys(IDBKeyRange.upperBound(now - OFFLINE_TTL_MS)),
      );
      await Promise.all(stale.map((k) => request(os.delete(k))));
      return stale.length;
    },
  };
}
'''.strip("\n") + "\n"
    test_no_import = r'''
import { describe, expect, it } from "vitest";
import { createIdbStore, OFFLINE_TTL_MS } from "./idbStore";
import { TileCache, tileId } from "./TileCache";

const key = { z: 6, x: 14, y: 26, product: "bvel" };
const bytes = () => new Uint8Array([1, 2, 3]).buffer;
let n = 0;
const freshStore = () => createIdbStore(`skyline-tiles-test-${n++}`);

describe("idbStore", () => {
  it("round-trips a tile", async () => {
    const store = freshStore();
    await store.put({ key: tileId(key), data: bytes(), fetchedAt: Date.now() });
    const hit = await store.get(tileId(key));
    expect(new Uint8Array(hit!.data)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("ignores tiles older than the offline ttl", async () => {
    const store = freshStore();
    await store.put({ key: tileId(key), data: bytes(), fetchedAt: Date.now() - OFFLINE_TTL_MS - 1 });
    expect(await store.get(tileId(key))).toBeUndefined();
    expect(await store.prune()).toBe(1);
  });
});

describe("TileCache with an offline store", () => {
  it("serves a tile after a cold start", async () => {
    const store = freshStore();
    new TileCache(store).set(key, bytes());
    await new Promise((r) => setTimeout(r, 10));
    const cold = new TileCache(store);
    expect(cold.get(key)).toBeUndefined();
    const hit = await cold.getOrLoad(key);
    expect(hit?.key).toBe(tileId(key));
    expect(cold.get(key)).toBeDefined();
  });
});
'''.strip("\n") + "\n"
    t = []
    t.append(user("move the weather tile cache to an IndexedDB offline store so the radar still shows the last frames when the "
                  "connection drops. keep the in-memory LRU in front of it though, scrubbing the timeline hits it constantly"))
    t.append(asst("I'll read the current cache and who uses it, then add the store as a second layer behind the in-memory map.", [
        tc.read(), gr(r"TileCache|cache\.(get|set)", "src", user_f, tc),
    ]))
    ed1 = tc.edit("export interface TileKey {", 'import type { OfflineStore } from "./idbStore";\n\nexport interface TileKey {')
    ed2 = tc.edit("  private tiles = new Map<string, CachedTile>();\n",
                  "  private tiles = new Map<string, CachedTile>();\n\n  constructor(private readonly store?: OfflineStore) {}\n")
    ed3 = tc.edit("    if (this.tiles.size > MAX_TILES) {\n      const oldest = this.tiles.keys().next().value as string;\n      this.tiles.delete(oldest);\n    }\n  }\n}\n",
                  "    if (this.tiles.size > MAX_TILES) {\n      const oldest = this.tiles.keys().next().value as string;\n      this.tiles.delete(oldest);\n    }\n"
                  "    // write through; a blocked or full IndexedDB must never break the live map\n"
                  "    void this.store?.put({ key: id, data, fetchedAt: Date.now() }).catch(() => {});\n  }\n\n"
                  "  /** Memory first, then the offline store (cold start or offline). */\n"
                  "  async getOrLoad(key: TileKey): Promise<CachedTile | undefined> {\n"
                  "    const mem = this.get(key);\n    if (mem) return mem;\n"
                  "    const stored = await this.store?.get(tileId(key)).catch(() => undefined);\n"
                  "    if (stored) this.tiles.set(stored.key, stored);\n    return stored;\n  }\n}\n")
    t.append(asst("The store goes into a new `idbStore.ts` with an `OfflineStore` interface so `TileCache` can be tested with a fake. `set()` writes through and swallows storage errors (private browsing, quota). `getOrLoad()` is the async path for a cold start or offline.", [
        write("src/radar/idbStore.ts", store),
        ed1, ed2, ed3,
        write("src/radar/idbStore.test.ts", test_no_import),
        bash("npx vitest run src/radar/idbStore.test.ts",
             " RUN  v3.2.4 /Users/fictional-dev/projects/skyline-weather\n\n"
             " ❯ src/radar/idbStore.test.ts (3 tests | 3 failed) 6ms\n"
             "   × idbStore > round-trips a tile\n     → indexedDB is not defined\n"
             "   × idbStore > ignores tiles older than the offline ttl\n     → indexedDB is not defined\n"
             "   × TileCache with an offline store > serves a tile after a cold start\n     → indexedDB is not defined\n\n"
             " FAIL  src/radar/idbStore.test.ts > idbStore > round-trips a tile\n"
             "ReferenceError: indexedDB is not defined\n ❯ src/radar/idbStore.ts:29:20\n\n"
             " Test Files  1 failed (1)\n      Tests  3 failed (3)",
             error=True, desc="Run the idbStore tests"),
        bash("npm install --save-dev --save-exact fake-indexeddb",
             "added 1 package, and audited 613 packages in 2s\n\n112 packages are looking for funding\n  run `npm fund` for details\n\nfound 0 vulnerabilities",
             desc="Add fake-indexeddb for tests"),
        edit("src/radar/idbStore.test.ts", 'import { describe, expect, it } from "vitest";\nimport { createIdbStore',
             'import "fake-indexeddb/auto";\nimport { describe, expect, it } from "vitest";\nimport { createIdbStore'),
        bash("npx vitest run src/radar",
             " RUN  v3.2.4 /Users/fictional-dev/projects/skyline-weather\n\n"
             " ✓ src/radar/idbStore.test.ts (3 tests) 31ms\n ✓ src/radar/legend.test.ts (3 tests) 4ms\n ✓ src/radar/TileCache.test.ts (6 tests) 9ms\n\n"
             " Test Files  3 passed (3)\n      Tests  12 passed (12)\n   Duration  655ms",
             desc="Run the radar tests"),
    ]))
    t.append(user("what happens if the browser blocks IndexedDB, like private mode in some browsers?", think=50))
    t.append(asst(
        "The map keeps working, it just loses the offline layer.\n\n"
        "- `set()` ignores a rejected `put()`, and `getOrLoad()` turns a rejected `get()` into `undefined`, so a blocked or full database falls back to the in-memory LRU.\n"
        "- I have not added a visible \"offline cache unavailable\" notice. That is a UI call for you.\n"
        "- `prune()` exists but nothing calls it yet. I'd run it once at startup from `RadarSource.ts`.\n\n"
        "```ts\n"
        "void this.store?.put({ key: id, data, fetchedAt: Date.now() }).catch(() => {});\n"
        "```\n\n"
        "Tests need `fake-indexeddb` (added as a pinned dev dependency); all 12 radar tests pass."))
    return Sess(key="skyline-weather/cursor-cli/tile-cache-idb", agent="cursor-cli", project="skyline-weather",
                start=at("2026-10-06", "17:15"), minutes=38, model="claude-sonnet-5-5",
                title="Move tile cache to IndexedDB offline store", turns=t)


# ---------------------------------------------------------------------------
# 5. cursor-cli: flaky chart snapshot test
# ---------------------------------------------------------------------------

def _chart_flaky():
    tst = F("src/components/ForecastChart.test.ts", r'''
import { describe, expect, it } from "vitest";
import { renderChartSvg } from "./ForecastChart";
import { sampleForecast } from "../test/fixtures";

describe("ForecastChart", () => {
  it("renders the 48h temperature and precipitation chart", () => {
    const svg = renderChartSvg(sampleForecast, { width: 640, height: 220 });
    expect(svg).toMatchSnapshot();
  });
});
''')
    fx = F("src/test/fixtures.ts", r'''
import type { Forecast } from "../api/forecast";

const HOUR = 3_600_000;

function makePoints(startMs: number) {
  return Array.from({ length: 48 }, (_, i) => ({
    time: new Date(startMs + i * HOUR).toISOString(),
    tempC: 22 + 5 * Math.sin(i / 7.6),
    precipMm: i % 9 === 4 ? 1.2 : 0,
    windKph: 10 + (i % 5),
  }));
}

const now = Date.now();
export const sampleForecast: Forecast = {
  locationId: "hou-001",
  points: makePoints(now - (now % HOUR)),
  fetchedAt: now - 3 * 60_000,
};
''')
    t = []
    t.append(user("the forecast chart snapshot test is a flaky test, fails on CI maybe once an hour. looks time related, can you look"))
    t.append(asst("Reading the test, then where the chart and the fixtures touch the clock.", [
        tst.read(),
        gr(r"Date\.now|new Date\(\)", "src", fx),
    ]))
    t.append(asst("The fixture is built from `Date.now()` at import: the points start at the top of the current hour and `fetchedAt` is three minutes ago. "
                  "The snapshot therefore changes whenever the wall clock crosses an hour (the \"now\" marker moves) or a minute (\"Updated 3 min ago\"). Reproducing by moving the clock.", [
        bash("faketime '2026-10-06 15:59:30' npx vitest run src/components/ForecastChart.test.ts",
             " ❯ src/components/ForecastChart.test.ts (1 test | 1 failed) 18ms\n\n"
             " FAIL  src/components/ForecastChart.test.ts > ForecastChart > renders the 48h temperature and precipitation chart\n"
             "Error: Snapshot `ForecastChart > renders the 48h temperature and precipitation chart 1` mismatched\n\n"
             "- Expected\n+ Received\n\n@@ -3,7 +3,7 @@\n"
             "-  <line class=\"now-marker\" x1=\"13.3\" x2=\"13.3\" y1=\"12\" y2=\"196\" />\n"
             "+  <line class=\"now-marker\" x1=\"26.7\" x2=\"26.7\" y1=\"12\" y2=\"196\" />\n"
             "-  <text class=\"updated\" x=\"628\" y=\"212\">Updated 3 min ago</text>\n"
             "+  <text class=\"updated\" x=\"628\" y=\"212\">Updated 4 min ago</text>\n\n"
             " Test Files  1 failed (1)",
             error=True, desc="Run the chart test with the clock near an hour boundary"),
        fx.edit("function makePoints(startMs: number) {", "export function makePoints(startMs: number) {"),
        fx.edit("const now = Date.now();\nexport const sampleForecast: Forecast = {\n  locationId: \"hou-001\",\n  points: makePoints(now - (now % HOUR)),\n  fetchedAt: now - 3 * 60_000,\n};\n",
                "/** Fixed reference time for tests: 2026-10-06 15:20 UTC. */\nexport const FIXTURE_NOW = Date.UTC(2026, 9, 6, 15, 20);\n\n"
                "export function makeSampleForecast(now: number): Forecast {\n  return {\n    locationId: \"hou-001\",\n"
                "    points: makePoints(now - (now % HOUR)),\n    fetchedAt: now - 3 * 60_000,\n  };\n}\n"),
        tst.edit('import { describe, expect, it } from "vitest";\nimport { renderChartSvg } from "./ForecastChart";\nimport { sampleForecast } from "../test/fixtures";\n',
                 'import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";\nimport { renderChartSvg } from "./ForecastChart";\nimport { FIXTURE_NOW, makeSampleForecast } from "../test/fixtures";\n'),
        tst.edit('describe("ForecastChart", () => {\n  it(',
                 'describe("ForecastChart", () => {\n  beforeEach(() => {\n    vi.useFakeTimers({ toFake: ["Date"] });\n    vi.setSystemTime(FIXTURE_NOW);\n  });\n\n  afterEach(() => {\n    vi.useRealTimers();\n  });\n\n  it('),
        tst.edit("renderChartSvg(sampleForecast,", "renderChartSvg(makeSampleForecast(FIXTURE_NOW),"),
        bash("npx vitest run src/components/ForecastChart.test.ts -u && faketime '2026-10-06 15:59:30' npx vitest run src/components/ForecastChart.test.ts && faketime '2026-10-07 03:00:10' npx vitest run src/components/ForecastChart.test.ts",
             " ✓ src/components/ForecastChart.test.ts (1 test) 12ms\n\n Snapshots  1 updated\n Test Files  1 passed (1)\n\n"
             " ✓ src/components/ForecastChart.test.ts (1 test) 11ms\n\n Test Files  1 passed (1)\n      Tests  1 passed (1)\n\n"
             " ✓ src/components/ForecastChart.test.ts (1 test) 11ms\n\n Test Files  1 passed (1)\n      Tests  1 passed (1)",
             desc="Update the snapshot, then run at two other wall-clock times"),
    ]))
    t.append(user("should ForecastChart just take a now prop instead of reading the clock?", think=40))
    t.append(asst(
        "Probably yes, but it is a separate change. The test is stable now without it.\n\n"
        "- The flake: the fixture and the chart both read the wall clock, so the snapshot depended on the hour and minute the CI job started in.\n"
        "- The fix: `makeSampleForecast(now)` builds the fixture from a fixed `FIXTURE_NOW`, and the test fakes only `Date` at that instant. The snapshot was regenerated once and passes when run with the clock set to 15:59:30 and to 03:00:10 UTC.\n"
        "- A `now` prop on `renderChartSvg` would remove the fake timers entirely and make the component easier to preview in Storybook-style pages. It touches `ForecastChart.tsx` and its two callers, so I left it alone."))
    return Sess(key="skyline-weather/cursor-cli/chart-snapshot-flaky", agent="cursor-cli", project="skyline-weather",
                start=at("2026-10-09", "14:50"), minutes=14, model="claude-sonnet-5-5",
                title="Fix flaky forecast chart snapshot test", turns=t)


# ---------------------------------------------------------------------------
# 6. qwen-code: move the sweep projection to the GPU
# ---------------------------------------------------------------------------

def _sweep_gpu():
    sw = _radar_sweep()
    vert = F("src/radar/shaders/sweep.vert.glsl", r'''
attribute vec2 a_position;   // mercator x/y, precomputed on the CPU
attribute float a_velocity;
uniform mat4 u_matrix;
varying float v_velocity;

void main() {
  gl_Position = u_matrix * vec4(a_position, 0.0, 1.0);
  gl_PointSize = 3.0;
  v_velocity = a_velocity;
}
''')
    t = []
    t.append(user("The Doppler radar sweep stutters every time a new volume scan lands. I profiled it and setFrame spends about 10 ms in "
                  "rebuildGeometry projecting 165k gates in JS. Gate positions only depend on the radar site, so move the projection into the "
                  "WebGL vertex shader and upload the polar grid once. Keep projectGate in geo.ts for the tests."))
    t.append(asst("Reading `RadarSweep.ts` and the vertex shader to see what the CPU loop feeds the GPU today.", [
        sw.read(), vert.read(),
        bash("node scripts/bench-sweep.mjs --frames 300",
             "rebuildGeometry (CPU, 165600 gates)\n  frames   300\n  p50      9.84 ms\n  p95     12.31 ms\n  max     15.02 ms",
             desc="Baseline benchmark of the geometry rebuild"),
    ]))
    e1 = sw.edit('import { projectGate } from "./geo";\n', "")
    e2 = sw.edit("  private positions = new Float32Array(RAYS * GATES_PER_RAY * 2);\n  private positionBuffer!: WebGLBuffer;\n",
                 "  private polarBuffer!: WebGLBuffer;\n")
    e3 = sw.edit("    this.positionBuffer = gl.createBuffer()!;\n    this.velocityBuffer = gl.createBuffer()!;\n  }\n",
                 "    this.polarBuffer = gl.createBuffer()!;\n    this.velocityBuffer = gl.createBuffer()!;\n    this.uploadPolarGrid();\n  }\n\n"
                 "  /** (azimuth in radians, gate index) for every gate. Independent of the site, so uploaded once. */\n"
                 "  private uploadPolarGrid() {\n    const polar = new Float32Array(RAYS * GATES_PER_RAY * 2);\n    let o = 0;\n"
                 "    for (let ray = 0; ray < RAYS; ray++) {\n      const azimuth = (ray * Math.PI) / 180;\n"
                 "      for (let gate = 0; gate < GATES_PER_RAY; gate++) {\n        polar[o++] = azimuth;\n        polar[o++] = gate;\n      }\n    }\n"
                 "    const gl = this.gl;\n    gl.bindBuffer(gl.ARRAY_BUFFER, this.polarBuffer);\n    gl.bufferData(gl.ARRAY_BUFFER, polar, gl.STATIC_DRAW);\n  }\n")
    e4 = sw.edit("    this.rebuildGeometry(frame);\n", "")
    old_rb = sw.between("  private rebuildGeometry(frame: RadarFrame) {", "    gl.bufferData(gl.ARRAY_BUFFER, this.positions, gl.DYNAMIC_DRAW);\n  }\n\n")
    e5 = sw.edit(old_rb, "")
    e6 = sw.edit('    this.bindAttribute("a_position", this.positionBuffer, 2);\n',
                 '    const f = this.frame;\n'
                 '    gl.uniform2f(gl.getUniformLocation(this.program, "u_origin"), (f.origin.lon * Math.PI) / 180, (f.origin.lat * Math.PI) / 180);\n'
                 '    gl.uniform1f(gl.getUniformLocation(this.program, "u_gateSpacing"), f.gateSpacingM);\n'
                 '    this.bindAttribute("a_polar", this.polarBuffer, 2);\n')
    vnew = r'''
precision highp float;
attribute vec2 a_polar;      // x: azimuth (rad, clockwise from north), y: gate index
attribute float a_velocity;
uniform mat4 u_matrix;
uniform vec2 u_origin;       // radar site, lon/lat in radians
uniform float u_gateSpacing; // metres between gates
varying float v_velocity;

const float EARTH_R = 6371008.8;
const float PI = 3.14159265358979;

void main() {
  float ang = a_polar.y * u_gateSpacing / EARTH_R;
  float lat1 = u_origin.y;
  float sinLat2 = sin(lat1) * cos(ang) + cos(lat1) * sin(ang) * cos(a_polar.x);
  float lat2 = asin(sinLat2);
  float lon2 = u_origin.x + atan(sin(a_polar.x) * sin(ang) * cos(lat1), cos(ang) - sin(lat1) * sinLat2);
  vec2 merc = vec2(
    (lon2 + PI) / (2.0 * PI),
    (PI - log(tan(PI * 0.25 + lat2 * 0.5))) / (2.0 * PI)
  );
  gl_Position = u_matrix * vec4(merc, 0.0, 1.0);
  gl_PointSize = 3.0;
  v_velocity = a_velocity;
}
'''.strip("\n") + "\n"
    ev = vert.edit(vert.text, vnew)
    t.append(asst("Plan: a static buffer of (azimuth, gate index) uploaded once in `onAdd`, and the vertex shader does the great-circle destination point and the mercator transform from two uniforms (site and gate spacing). `setFrame` then only uploads velocities.", [
        e1, e2, e3, e4, e5, e6, ev,
        bash("npx vitest run src/radar && npx tsc --noEmit",
             " ✓ src/radar/geo.test.ts (7 tests) 6ms\n ✓ src/radar/RadarSweep.test.ts (3 tests) 14ms\n\n Test Files  2 passed (2)\n      Tests  10 passed (10)\n"
             "src/radar/RadarSweep.ts(70,70): error TS2551: Property 'lon' does not exist on type 'LatLng'. Did you mean 'lng'?",
             error=True, desc="Run radar tests and typecheck"),
    ]))
    e7 = sw.edit("(f.origin.lon * Math.PI) / 180", "(f.origin.lng * Math.PI) / 180")
    t.append(asst("The tests pass, but `tsc` caught that `RadarFrame.origin` is a `LatLng` with `lng`, not `lon`. Fixing the uniform upload.", [
        e7,
        bash("npx tsc --noEmit && node scripts/bench-sweep.mjs --frames 300",
             "rebuildGeometry (CPU, 165600 gates)\n  skipped: geometry is projected in the vertex shader\nsetFrame (uniform + velocity upload)\n  frames   300\n  p50      0.41 ms\n  p95      0.58 ms\n  max      0.97 ms",
             desc="Typecheck and rerun the benchmark"),
    ]))
    t.append(user("how much faster is that really, and did you check it on an integrated GPU?", think=45))
    t.append(asst(
        "On the CPU side `setFrame` went from p50 9.84 ms (p95 12.31 ms) to p50 0.41 ms (p95 0.58 ms) in `scripts/bench-sweep.mjs`. "
        "That script only measures main-thread time, so it says nothing about GPU cost.\n\n"
        "- **Not verified:** the vertex shader now does about 8 trig calls per gate, 165,600 gates per draw. I have not run it on an integrated GPU or checked the frame rate there. Please run it on the Intel laptop before merging.\n"
        "- **Precision:** `precision highp float` is required for the longitude and latitude maths. A device without highp vertex support would show a visible offset, though that is rare on anything that runs MapLibre.\n"
        "- `projectGate` stays in `geo.ts` as the reference for tests; the existing `geo.test.ts` (7 tests) and `RadarSweep.test.ts` still pass.\n\n"
        "```glsl\n"
        "float ang = a_polar.y * u_gateSpacing / EARTH_R;\n"
        "float sinLat2 = sin(lat1) * cos(ang) + cos(lat1) * sin(ang) * cos(a_polar.x);\n"
        "```"))
    return Sess(key="skyline-weather/qwen-code/sweep-gpu-projection", agent="qwen-code", project="skyline-weather",
                start=at("2026-10-01", "20:10"), minutes=33, model="qwen3-coder-plus",
                title="Project Doppler radar sweep geometry on the GPU", turns=t)


# ---------------------------------------------------------------------------
# 7. qwen-code: alert poller backoff after 503s
# ---------------------------------------------------------------------------

def _poller_backoff():
    p = F("src/ingest/poller.ts", r'''
import { DEFAULT_POLL } from "./config";
import type { StormAlert } from "../alerts/types";

export interface PollOptions {
  intervalMs: number;
  timeoutMs: number;
  retries: number;
}

export interface AlertFeedHandlers {
  onAlerts(alerts: StormAlert[]): void;
  onError(err: Error): void;
}

const FEED_URL = "http://alerts.skyline.invalid/v2/active";

export class AlertPoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly handlers: AlertFeedHandlers,
    private readonly opts: PollOptions = DEFAULT_POLL,
  ) {}

  start() {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  private async tick() {
    if (!this.running) return;
    try {
      const res = await fetch(FEED_URL, { signal: AbortSignal.timeout(this.opts.timeoutMs) });
      if (!res.ok) throw new Error(`alert feed responded ${res.status}`);
      this.handlers.onAlerts(await res.json());
    } catch (err) {
      this.handlers.onError(err as Error);
    }
    this.timer = setTimeout(() => void this.tick(), this.opts.intervalMs);
  }
}
''')
    pt = F("src/ingest/poller.test.ts", r'''
import { afterEach, describe, expect, it, vi } from "vitest";
import { AlertPoller } from "./poller";

const handlers = { onAlerts: vi.fn(), onError: vi.fn() };

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("AlertPoller", () => {
  it("delivers alerts on a 200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("[]", { status: 200 }));
    const poller = new AlertPoller(handlers, { intervalMs: 2000, timeoutMs: 750, retries: 2 });
    poller.start();
    await vi.waitFor(() => expect(handlers.onAlerts).toHaveBeenCalledWith([]));
    poller.stop();
  });
});
''')
    t = []
    t.append(user("alert poller hammers the provider every 2s even while it's returning 503s. needs exponential backoff, "
                  "capped, and back to normal on the first success"))
    t.append(asst("I'll read the poller and its test, then add a failure counter that stretches the delay between ticks.", [
        p.read(), pt.read(),
    ]))
    e1 = p.edit("  retries: number;\n}", "  retries: number;\n  /** Upper bound for the backoff delay. Default 5 minutes. */\n  maxBackoffMs?: number;\n}")
    e2 = p.edit("  private running = false;\n", "  private running = false;\n  private failures = 0;\n")
    e3 = p.edit("    private readonly opts: PollOptions = DEFAULT_POLL,\n  ) {}",
                "    private readonly opts: PollOptions = DEFAULT_POLL,\n    private readonly rand: () => number = Math.random,\n  ) {}")
    e4 = p.edit("      this.handlers.onAlerts(await res.json());\n    } catch (err) {\n      this.handlers.onError(err as Error);\n    }\n    this.timer = setTimeout(() => void this.tick(), this.opts.intervalMs);\n  }\n",
                "      this.handlers.onAlerts(await res.json());\n      this.failures = 0;\n    } catch (err) {\n      this.failures += 1;\n      this.handlers.onError(err as Error);\n    }\n"
                "    this.timer = setTimeout(() => void this.tick(), this.nextDelay());\n  }\n\n"
                "  /** interval * 2^failures, capped, with +/-20% jitter so clients do not retry in lockstep. */\n"
                "  private nextDelay(): number {\n    if (this.failures === 0) return this.opts.intervalMs;\n"
                "    const cap = this.opts.maxBackoffMs ?? 300_000;\n"
                "    const base = Math.min(cap, this.opts.intervalMs * 2 ** this.failures);\n"
                "    return Math.round(base * (0.8 + 0.4 * this.rand()));\n  }\n")
    e5 = pt.edit("    poller.stop();\n  });\n});\n",
                 "    poller.stop();\n  });\n\n  it(\"backs off exponentially after 503s and resets on success\", async () => {\n    vi.useFakeTimers();\n"
                 "    const fetchMock = vi\n      .spyOn(globalThis, \"fetch\")\n      .mockResolvedValueOnce(new Response(\"\", { status: 503 }))\n"
                 "      .mockResolvedValueOnce(new Response(\"\", { status: 503 }))\n"
                 "      .mockImplementation(async () => new Response(\"[]\", { status: 200 }));\n"
                 "    const poller = new AlertPoller(handlers, { intervalMs: 2000, timeoutMs: 750, retries: 2 }, () => 0.5);\n"
                 "    poller.start();\n    await vi.advanceTimersByTimeAsync(0);\n    expect(fetchMock).toHaveBeenCalledTimes(1);\n"
                 "    await vi.advanceTimersByTimeAsync(3999);\n    expect(fetchMock).toHaveBeenCalledTimes(1);\n"
                 "    await vi.advanceTimersByTimeAsync(1);\n    expect(fetchMock).toHaveBeenCalledTimes(2);\n"
                 "    await vi.advanceTimersByTimeAsync(8000);\n    expect(fetchMock).toHaveBeenCalledTimes(3);\n"
                 "    await vi.advanceTimersByTimeAsync(2000); // back to the normal cadence\n    expect(fetchMock).toHaveBeenCalledTimes(4);\n"
                 "    poller.stop();\n  });\n});\n")
    t.append(asst("Each failure doubles the wait (4 s, 8 s, 16 s with the default 2 s interval), capped at 5 minutes with 20% jitter, and a success resets the counter. The jitter source is injectable so the test is exact.", [
        e1, e2, e3, e4, e5,
        bash("npx vitest run src/ingest/poller.test.ts",
             " ✓ src/ingest/poller.test.ts (2 tests) 19ms\n\n Test Files  1 passed (1)\n      Tests  2 passed (2)",
             desc="Run the poller tests"),
    ]))
    t.append(user("what's the longest it will ever wait?", think=30))
    t.append(asst(
        "5 minutes before jitter, so up to 6 minutes in the worst case (`maxBackoffMs` of 300,000 ms times 1.2).\n\n"
        "- With the 2 s interval the sequence is 4 s, 8 s, 16 s, 32 s, 64 s, 128 s, 256 s, then 300 s from the eighth consecutive failure on.\n"
        "- Any error counts, not only 503: a timeout or a network failure backs off the same way, which seemed right for a feed that is struggling.\n"
        "- `Retry-After` is not read here. If the provider starts sending it for this endpoint, `nextDelay()` is the place to honour it."))
    return Sess(key="skyline-weather/qwen-code/poller-backoff", agent="qwen-code", project="skyline-weather",
                start=at("2026-10-02", "18:25"), minutes=11, model="qwen3-coder-plus",
                title="Exponential backoff for the alert poller", turns=t)


# ---------------------------------------------------------------------------
# 8. amp: fragment shader performance review
# ---------------------------------------------------------------------------

def _frag_review():
    fs = F("src/radar/shaders/sweep.frag.glsl", r'''
precision mediump float;
varying float v_velocity;
uniform vec3 u_stops[5];
uniform float u_stopValues[5];
uniform float u_gain;
uniform float u_time;

vec3 rampColor(float v) {
  for (int i = 0; i < 4; i++) {
    if (v <= u_stopValues[i + 1]) {
      float t = (v - u_stopValues[i]) / (u_stopValues[i + 1] - u_stopValues[i]);
      return mix(u_stops[i], u_stops[i + 1], clamp(t, 0.0, 1.0));
    }
  }
  return u_stops[4];
}

void main() {
  vec2 p = gl_PointCoord - 0.5;
  float d = length(p);
  if (d > 0.5) discard;
  float soft = pow(1.0 - d * 2.0, 1.6);
  float flicker = 0.92 + 0.08 * sin(u_time * 3.0 + v_velocity * 12.0);
  vec3 color = rampColor(clamp(v_velocity, -30.0, 30.0)) * u_gain;
  gl_FragColor = vec4(color * flicker, soft * 0.85);
}
''')
    ramp_ts = F("src/radar/rampUniforms.ts", r'''
import { VELOCITY_STOPS } from "./RadarSweep";

export function setRampUniforms(gl: WebGLRenderingContext, program: WebGLProgram, gain: number, timeSec: number) {
  const stops = new Float32Array(VELOCITY_STOPS.flatMap((s) => s.color.map((c) => c / 255)));
  const values = new Float32Array(VELOCITY_STOPS.map((s) => s.value));
  gl.uniform3fv(gl.getUniformLocation(program, "u_stops"), stops);
  gl.uniform1fv(gl.getUniformLocation(program, "u_stopValues"), values);
  gl.uniform1f(gl.getUniformLocation(program, "u_gain"), gain);
  gl.uniform1f(gl.getUniformLocation(program, "u_time"), timeSec);
}
''')
    t = []
    t.append(user("Review the Doppler radar sweep fragment shader for performance. Users on integrated GPUs report the radar dropping to about "
                  "40 fps when zoomed out, where 165k points overlap. Apply the safe changes, list the rest."))
    t.append(asst("Reading the shader, and where its uniforms are set, to separate what I can change in the GLSL alone from what needs TypeScript.", [
        fs.read(),
        gr(r"u_stops|u_stopValues|u_time|u_gain", "src/radar", ramp_ts, glob="*.ts"),
    ]))
    ramp_old = fs.between("vec3 rampColor(float v) {", "  return u_stops[4];\n}\n")
    ramp_new = r'''
// Branch-free piecewise linear ramp: each segment's blend is clamped to [0, 1], so segments
// before v are fully applied and segments after v contribute nothing.
vec3 rampColor(float v) {
  vec3 c = u_stops[0];
  c = mix(c, u_stops[1], clamp((v - u_stopValues[0]) / (u_stopValues[1] - u_stopValues[0]), 0.0, 1.0));
  c = mix(c, u_stops[2], clamp((v - u_stopValues[1]) / (u_stopValues[2] - u_stopValues[1]), 0.0, 1.0));
  c = mix(c, u_stops[3], clamp((v - u_stopValues[2]) / (u_stopValues[3] - u_stopValues[2]), 0.0, 1.0));
  c = mix(c, u_stops[4], clamp((v - u_stopValues[3]) / (u_stopValues[4] - u_stopValues[3]), 0.0, 1.0));
  return c;
}
'''.strip("\n") + "\n"
    e1 = fs.edit(ramp_old, ramp_new)
    e2 = fs.edit("  vec2 p = gl_PointCoord - 0.5;\n  float d = length(p);\n  if (d > 0.5) discard;\n  float soft = pow(1.0 - d * 2.0, 1.6);\n",
                 "  // Outside the disc the falloff is 0, so alpha is 0: no discard needed with blending on.\n"
                 "  float falloff = clamp(1.0 - length(gl_PointCoord - 0.5) * 2.0, 0.0, 1.0);\n"
                 "  // x * x * (1.5 - 0.5 * x) approximates pow(x, 1.6) with a maximum error of 0.024 on [0, 1].\n"
                 "  float soft = falloff * falloff * (1.5 - 0.5 * falloff);\n")
    t.append(asst("Three things in the fragment stage are costing you at 165k overlapping points: a data-dependent loop and branch in `rampColor`, a `pow()` with a fractional exponent, and a `discard`. "
                  "On tile-based mobile and integrated GPUs `discard` also disables early depth/stencil rejection, and here the alpha already goes to zero at the edge. "
                  "Fixing those three in the shader only.", [
        e1, e2,
        bash("node -e \"let m=0;for(let i=0;i<=10000;i++){const x=i/10000;m=Math.max(m,Math.abs(x**1.6-x*x*(1.5-0.5*x)));}console.log('max abs error', m.toFixed(4))\"",
             "max abs error 0.0243", desc="Check the pow approximation error"),
        bash("node scripts/check-shaders.mjs",
             "src/radar/shaders/sweep.vert.glsl  ok (GLSL ES 1.00)\nsrc/radar/shaders/sweep.frag.glsl  ok (GLSL ES 1.00)",
             desc="Compile-check the shaders"),
    ]))
    t.append(user("good. write up the rest as a list I can paste into the issue", think=40))
    t.append(asst(
        "Applied in `sweep.frag.glsl` (no TypeScript changes needed):\n\n"
        "- `rampColor` is now four clamped `mix` calls with no loop and no branch. The result is identical to the old piecewise interpolation for every `v`.\n"
        "- `pow(x, 1.6)` became `x * x * (1.5 - 0.5 * x)`, a maximum error of 0.0243 before the 0.85 alpha scale (checked over 10,001 samples), about 5 of 255 output levels at worst. Look at the soft edge on a real screen to judge whether that is visible.\n"
        "- The `discard` is gone; alpha is 0 outside the disc anyway.\n\n"
        "Not applied, for the issue:\n\n"
        "1. **Bake the ramp into a 256x1 texture.** One `texture2D` fetch replaces four divides and four mixes. Needs `RadarSweep.ts` to build the texture from `VELOCITY_STOPS` and bind a sampler.\n"
        "2. **Move `sin(u_time * 3.0 + v_velocity * 12.0)` to the vertex shader.** It is per-fragment today although `v_velocity` is constant per point; a varying `v_flicker` would make it per-vertex.\n"
        "3. **Precompute the segment spans as uniforms** (`u_invSpan[4]`) so the four divides disappear if the texture route is not taken.\n"
        "4. **Measure with a GPU timer query, not frame rate.** I have not profiled on hardware, so the 40 fps figure and any gain are unconfirmed. `EXT_disjoint_timer_query` is not available on every browser.\n\n"
        "```glsl\n"
        "float falloff = clamp(1.0 - length(gl_PointCoord - 0.5) * 2.0, 0.0, 1.0);\n"
        "float soft = falloff * falloff * (1.5 - 0.5 * falloff);\n"
        "```"))
    return Sess(key="skyline-weather/amp/frag-shader-review", agent="amp", project="skyline-weather",
                start=at("2026-10-07", "19:00"), minutes=22, model="claude-opus-5-5",
                title="Review Doppler radar sweep fragment shader performance", turns=t)


# ---------------------------------------------------------------------------
# 9. amp: saved locations schema migration v1 to v2
# ---------------------------------------------------------------------------

def _saved_locations():
    sl = F("src/state/savedLocations.ts", r"""
const KEY = "skyline.savedLocations";

export interface SavedLocationV1 {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

export function loadSavedLocations(): SavedLocationV1[] {
  const raw = localStorage.getItem(KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as SavedLocationV1[];
  } catch {
    return [];
  }
}

export function saveLocations(list: SavedLocationV1[]): void {
  localStorage.setItem(KEY, JSON.stringify(list));
}
""")
    pick = F("src/components/LocationPicker.tsx", r"""
import { useMemo } from "react";
import { loadSavedLocations } from "../state/savedLocations";
import type { Map as MapLibreMap } from "maplibre-gl";

export function LocationPicker({ map }: { map: MapLibreMap }) {
  const saved = useMemo(() => loadSavedLocations(), []);
  return (
    <ul className="location-picker">
      {saved.map((loc) => (
        <li key={loc.id}>
          <button onClick={() => map.flyTo({ center: [loc.lon, loc.lat], zoom: 9 })}>{loc.name}</button>
        </li>
      ))}
    </ul>
  );
}
""")
    new_mod = r"""
const KEY = "skyline.savedLocations";
const BACKUP_KEY = "skyline.savedLocations.v1.bak";
const CURRENT_VERSION = 2;

export interface SavedLocation {
  id: string;
  name: string;
  lat: number;
  lng: number;
  /** v2: push alerts for this place */
  alerts: boolean;
}

interface StoreV2 {
  version: 2;
  locations: SavedLocation[];
}

interface SavedLocationV1 {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

function isV1Item(x: unknown): x is SavedLocationV1 {
  const o = x as Record<string, unknown>;
  return !!o && typeof o.id === "string" && typeof o.name === "string" && typeof o.lat === "number" && typeof o.lon === "number";
}

/**
 * Schema migration v1 to v2: a bare array becomes { version, locations }, `lon` is renamed `lng`,
 * and every place gets `alerts: true` (users were already receiving alerts for all of them).
 * Returns null for data this build cannot read, including a newer version.
 */
export function migrate(raw: unknown): StoreV2 | null {
  if (Array.isArray(raw)) {
    return {
      version: 2,
      locations: raw.filter(isV1Item).map((l) => ({ id: l.id, name: l.name, lat: l.lat, lng: l.lon, alerts: true })),
    };
  }
  const o = raw as { version?: unknown; locations?: unknown } | null;
  if (o && o.version === CURRENT_VERSION && Array.isArray(o.locations)) return o as StoreV2;
  return null;
}

export function loadSavedLocations(): SavedLocation[] {
  const raw = localStorage.getItem(KEY);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    localStorage.setItem(BACKUP_KEY, raw); // keep the unreadable text for support, then start clean
    return [];
  }
  const store = migrate(parsed);
  if (!store) return []; // newer or unknown version: do not overwrite it
  if (Array.isArray(parsed)) {
    localStorage.setItem(BACKUP_KEY, raw);
    localStorage.setItem(KEY, JSON.stringify(store));
  }
  return store.locations;
}

export function saveLocations(list: SavedLocation[]): void {
  const store: StoreV2 = { version: CURRENT_VERSION, locations: list };
  localStorage.setItem(KEY, JSON.stringify(store));
}
""".strip("\n") + "\n"
    test = r"""
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { loadSavedLocations, migrate, saveLocations } from "./savedLocations";

const KEY = "skyline.savedLocations";
const v1 = [
  { id: "hou", name: "Houston", lat: 29.76, lon: -95.37 },
  { id: "gls", name: "Galveston", lat: 29.3, lon: -94.8 },
];

beforeEach(() => localStorage.clear());

describe("saved locations schema migration", () => {
  it("migrates v1 arrays: lon becomes lng and alerts default to true", () => {
    expect(migrate(v1)?.locations[0]).toEqual({ id: "hou", name: "Houston", lat: 29.76, lng: -95.37, alerts: true });
  });

  it("drops v1 entries that are missing coordinates", () => {
    expect(migrate([...v1, { id: "x", name: "Nowhere" }])?.locations).toHaveLength(2);
  });

  it("rewrites storage once and keeps a v1 backup", () => {
    localStorage.setItem(KEY, JSON.stringify(v1));
    expect(loadSavedLocations()).toHaveLength(2);
    expect(JSON.parse(localStorage.getItem(KEY)!).version).toBe(2);
    expect(JSON.parse(localStorage.getItem("skyline.savedLocations.v1.bak")!)).toEqual(v1);
  });

  it("round-trips v2", () => {
    saveLocations([{ id: "hou", name: "Houston", lat: 29.76, lng: -95.37, alerts: false }]);
    expect(loadSavedLocations()[0].alerts).toBe(false);
  });

  it("returns [] for corrupt JSON and keeps the text", () => {
    localStorage.setItem(KEY, "{not json");
    expect(loadSavedLocations()).toEqual([]);
    expect(localStorage.getItem("skyline.savedLocations.v1.bak")).toBe("{not json");
  });

  it("does not overwrite a newer version", () => {
    const v3 = JSON.stringify({ version: 3, locations: [], theme: "storm" });
    localStorage.setItem(KEY, v3);
    expect(loadSavedLocations()).toEqual([]);
    expect(localStorage.getItem(KEY)).toBe(v3);
  });
});
""".strip("\n") + "\n"
    t = []
    t.append(user("We're renaming lon to lng in the saved-locations store and adding a per-location alerts toggle. Existing users have a v1 "
                  "array in localStorage. Write the schema migration (v1 to v2) so nobody loses their saved places, and test it."))
    t.append(asst("Reading the current store and finding everything that touches the old shape before I change the type.", [
        sl.read(),
        gr(r"loadSavedLocations|saveLocations|\.lon\b", "src", pick, sl),
    ]))
    c1 = sl.edit(sl.text, new_mod)
    c2 = pick.edit("center: [loc.lon, loc.lat]", "center: [loc.lng, loc.lat]")
    t.append(asst("The migration runs on read: a bare array becomes `{ version: 2, locations }`, `lon` becomes `lng`, and `alerts` defaults to true because those users were getting alerts for every saved place already. "
                  "The original v1 text is kept under a backup key, and data from a newer version is left alone.", [
        c1, c2,
        write("src/state/savedLocations.test.ts", test),
        bash("npx vitest run src/state && npx tsc --noEmit",
             " ✓ src/state/savedLocations.test.ts (6 tests) 17ms\n\n Test Files  1 passed (1)\n      Tests  6 passed (6)\n   Duration  498ms",
             desc="Run the migration tests and typecheck"),
    ]))
    t.append(user("what if the JSON in there is corrupt, or a newer build already wrote v3?", think=40))
    t.append(asst(
        "Both are covered by tests and neither destroys data.\n\n"
        "- **Corrupt JSON:** `loadSavedLocations()` returns `[]` and copies the unreadable text to `skyline.savedLocations.v1.bak`. The next `saveLocations()` overwrites the main key, but the bad text stays in the backup for support.\n"
        "- **Version 3 or unknown shape:** `migrate()` returns `null`, the loader returns `[]` and does not write. A user who opens an older tab after upgrading elsewhere loses nothing, they just see no saved places in that tab.\n"
        "- **Old entries with no coordinates** are dropped during migration rather than crashing the picker.\n\n"
        "```ts\n"
        "const store = migrate(parsed);\n"
        "if (!store) return []; // newer or unknown version: do not overwrite it\n"
        "```\n\n"
        "`LocationPicker.tsx` was the only other user of `lon`; it now reads `lng`. Six tests pass and `tsc` is clean. The backup key is never cleaned up, which I left deliberately until you decide how long to keep it."))
    return Sess(key="skyline-weather/amp/saved-locations-migration", agent="amp", project="skyline-weather",
                start=at("2026-10-12", "15:00"), minutes=29, model="claude-opus-5-5",
                title="Saved locations schema migration v1 to v2", turns=t)



def sessions():
    return [
        _forecast_backoff(),
        _storm_dedupe(),
        _legend(),
        _tile_idb(),
        _chart_flaky(),
        _sweep_gpu(),
        _poller_backoff(),
        _frag_review(),
        _saved_locations(),
    ]
