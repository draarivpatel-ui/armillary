"""zenith-cli: filler sessions for the fictional Rust cluster admin CLI (clap).

Eleven sessions across eight agents. Shared fictional facts so the files agree with each other:
  - the crate has src/lib.rs (pub mods) and src/main.rs (clap); integration tests import `zenith_cli`
  - src/consensus.rs holds NodeId, PingReply, PingRound, LossWindow, ElectionTimer, SimNode
  - tests/common/mod.rs holds SimCluster, tests/consensus_failover.rs the failover tests
  - src/output/mod.rs holds OutputFormat (Table, Json from 2026-09-29, Yaml from 2026-10-06)
"""

from .model import Sess, at, user, asst, read, grep, glob, ls, bash, edit, write, todo, task


def T(s):
    """Text without surrounding blank lines (edit blocks, short results)."""
    return s.strip("\n")


def F(s):
    """File content with one trailing newline."""
    return s.strip("\n") + "\n"


P = "zenith-cli"
BUILD_LINE = "   Compiling zenith-cli v0.9.2 (/Users/fictional-dev/projects/zenith-cli)"
LIB_TEST = "     Running unittests src/lib.rs (target/debug/deps/zenith_cli-3f9a1c0be2d47a58)"

# ---------------------------------------------------------------------------
# Shared file contents
# ---------------------------------------------------------------------------

API_RS = F(r"""
use anyhow::{Context, Result};
use reqwest::Url;
use serde::de::DeserializeOwned;

pub struct ApiClient {
    http: reqwest::Client,
    base: Url,
}

impl ApiClient {
    pub fn new(base: &str) -> Result<Self> {
        let http = reqwest::Client::builder()
            .user_agent(concat!("zenith/", env!("CARGO_PKG_VERSION")))
            .timeout(std::time::Duration::from_secs(10))
            .build()?;
        Ok(Self { http, base: Url::parse(base)? })
    }

    pub async fn get_json<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        let url = self.base.join(path).with_context(|| format!("bad path {path}"))?;
        let resp = self.http.get(url).send().await?.error_for_status()?;
        Ok(resp.json::<T>().await?)
    }
}
""")

HEALTH_RS_TOP = F(r"""
use anyhow::Result;
use clap::Args;

use crate::api::ApiClient;
use crate::consensus::NodeId;
use crate::model::NodeHealth;

#[derive(Args)]
pub struct HealthArgs {
    /// Re-run the checks every few seconds
    #[arg(long)]
    pub watch: bool,
}

/// One health probe of a single node. Fails fast: no retries.
pub async fn probe_node(api: &ApiClient, node: &NodeId) -> Result<NodeHealth> {
    api.get_json(&format!("v1/nodes/{node}/health")).await
}

pub async fn run(api: &ApiClient, args: HealthArgs) -> Result<()> {
    loop {
        let ids = api.get_json::<Vec<NodeId>>("v1/nodes").await?;
        // one probe per node, all in flight at once
        let probes = futures::future::join_all(ids.iter().map(|id| probe_node(api, id))).await;
        print_probes(&ids, &probes);
        if !args.watch {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
}
""")

FAILOVER_BASE = F(r"""
mod common;

use common::SimCluster;
use std::time::Duration;

#[tokio::test]
async fn leader_elected_on_healthy_cluster() {
    let mut cluster = SimCluster::new(5);
    let round = cluster.ping_round().await;
    assert!(round.has_quorum());
    assert_eq!(round.leader(), Some(cluster.node_id(0)));
}

#[tokio::test]
async fn follower_promotes_after_leader_loss() {
    let mut cluster = SimCluster::new(5);
    cluster.ping_round().await;
    cluster.disconnect(&[0]);
    // give the election timer a chance to fire
    cluster.advance(Duration::from_millis(600)).await;
    let round = cluster.ping_round().await;
    assert!(round.has_quorum());
    assert_ne!(round.leader(), Some(cluster.node_id(0)));
}

#[tokio::test]
async fn single_node_partition_keeps_quorum() {
    let mut cluster = SimCluster::new(3);
    cluster.disconnect(&[2]);
    let round = cluster.ping_round().await;
    assert!(round.has_quorum());
    assert_eq!(round.unreachable().len(), 1);
}
""")

FAILOVER_NEW_TEST = T(r"""
#[tokio::test]
async fn three_disconnected_nodes_drop_quorum() {
    let mut cluster = SimCluster::new(5);
    let healthy = cluster.ping_round().await;
    assert_eq!(healthy.leader(), Some(cluster.node_id(0)));

    // cut off three followers while the next ping broadcast is in flight
    cluster.disconnect(&[2, 3, 4]);
    let round = cluster.ping_round().await;

    assert_eq!(round.unreachable().len(), 3);
    assert!(!round.has_quorum(), "2 of 5 nodes answered, quorum must be lost");
    assert_eq!(round.leader(), None, "leader must step down without quorum");
}
""")

SIM_COMMON = F(r"""
use rand::{rngs::StdRng, SeedableRng};
use std::time::Duration;
use zenith_cli::consensus::{NodeId, PingRound, SimNode};

pub struct SimCluster {
    nodes: Vec<SimNode>,
    ids: Vec<NodeId>,
    rng: StdRng,
    clock: Duration,
}

impl SimCluster {
    pub fn new(n: usize) -> Self {
        let rng = StdRng::from_entropy();
        Self::build(n, rng)
    }

    fn build(n: usize, mut rng: StdRng) -> Self {
        let ids: Vec<NodeId> = (0..n).map(|i| NodeId::new(format!("node-{i}"))).collect();
        let nodes = ids.iter().map(|id| SimNode::new(id.clone(), &ids, &mut rng)).collect();
        Self { nodes, ids, rng, clock: Duration::ZERO }
    }

    pub fn node_id(&self, i: usize) -> &NodeId {
        &self.ids[i]
    }

    pub fn disconnect(&mut self, which: &[usize]) {
        for &i in which {
            self.nodes[i].set_connected(false);
        }
    }

    pub async fn advance(&mut self, by: Duration) {
        self.clock += by;
        for node in &mut self.nodes {
            node.tick(self.clock, &mut self.rng);
        }
    }

    pub async fn ping_round(&mut self) -> PingRound {
        zenith_cli::consensus::broadcast_ping(&mut self.nodes, self.clock).await
    }
}
""")

INSPECT_BEFORE = F(r"""
use anyhow::Result;
use clap::Args;

use crate::api::ApiClient;
use crate::model::ClusterReport;
use crate::output::table;

#[derive(Args)]
pub struct InspectArgs {
    /// Node id to inspect; omit to inspect the whole cluster
    pub node: Option<String>,
}

pub async fn run(api: &ApiClient, args: InspectArgs) -> Result<()> {
    let report: ClusterReport = match &args.node {
        Some(id) => api.get_json(&format!("v1/nodes/{id}/report")).await?,
        None => api.get_json("v1/cluster/report").await?,
    };
    println!("{}", table::render_report(&report));
    Ok(())
}
""")

INSPECT_AFTER_JSON = F(r"""
use anyhow::Result;
use clap::Args;

use crate::api::ApiClient;
use crate::model::ClusterReport;
use crate::output::{json, table, OutputFormat};

#[derive(Args)]
pub struct InspectArgs {
    /// Node id to inspect; omit to inspect the whole cluster
    pub node: Option<String>,
    /// Output format
    #[arg(long, value_enum, default_value_t = OutputFormat::Table)]
    pub output: OutputFormat,
}

pub async fn run(api: &ApiClient, args: InspectArgs) -> Result<()> {
    let report: ClusterReport = match &args.node {
        Some(id) => api.get_json(&format!("v1/nodes/{id}/report")).await?,
        None => api.get_json("v1/cluster/report").await?,
    };
    match args.output {
        OutputFormat::Table => println!("{}", table::render_report(&report)),
        OutputFormat::Json => println!("{}", json::render_json(&report)?),
    }
    Ok(())
}
""")

OUTPUT_MOD_JSON = F(r"""
//! Output renderers for CLI commands.

pub mod json;
pub mod table;

/// How a command prints its result.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, clap::ValueEnum)]
pub enum OutputFormat {
    #[default]
    Table,
    Json,
}
""")

JSON_RS = F(r"""
use anyhow::Result;
use serde::Serialize;

/// Pretty-printed JSON with a stable field order (struct order, not map order).
pub fn render_json<T: Serialize>(value: &T) -> Result<String> {
    Ok(serde_json::to_string_pretty(value)?)
}
""")


# ---------------------------------------------------------------------------
# 1. gemini-cli: packet loss detection under jitter
# ---------------------------------------------------------------------------

def _gemini_loss():
    loss_read = T(r"""
/// Rolling window of the last `WINDOW` pings to one node.
pub struct LossWindow {
    slots: VecDeque<Option<Duration>>,
    deadline: Duration,
}

impl LossWindow {
    pub fn new(deadline: Duration) -> Self {
        Self { slots: VecDeque::with_capacity(WINDOW), deadline }
    }

    pub fn record(&mut self, rtt: Option<Duration>) {
        if self.slots.len() == WINDOW {
            self.slots.pop_front();
        }
        // a reply slower than the deadline counts as lost
        self.slots.push_back(rtt.filter(|d| *d <= self.deadline));
    }

    pub fn loss_ratio(&self) -> f64 {
        if self.slots.is_empty() {
            return 0.0;
        }
        let lost = self.slots.iter().filter(|s| s.is_none()).count();
        lost as f64 / self.slots.len() as f64
    }

    /// A node is degraded once it drops more than 30 percent of recent pings.
    pub fn is_degraded(&self) -> bool {
        self.loss_ratio() > DEGRADED_LOSS
    }
}
""")
    tests_tail = T(r"""
    #[test]
    fn loss_ratio_counts_late_replies() {
        let mut w = LossWindow::new(Duration::from_millis(100));
        w.record(Some(Duration::from_millis(40)));
        w.record(Some(Duration::from_millis(180)));
        w.record(None);
        w.record(Some(Duration::from_millis(90)));
        assert!((w.loss_ratio() - 0.5).abs() < f64::EPSILON);
    }

    #[test]
    fn loss_window_evicts_oldest() {
        let mut w = LossWindow::new(Duration::from_millis(200));
        for _ in 0..WINDOW {
            w.record(None);
        }
        w.record(Some(Duration::from_millis(40)));
        assert_eq!(w.slots.len(), WINDOW);
        assert!(w.loss_ratio() < 1.0);
    }
}
""")
    EVICT_TEST = T(r"""
    #[test]
    fn loss_window_evicts_oldest() {
        let mut w = LossWindow::new(Duration::from_millis(200));
        for _ in 0..WINDOW {
            w.record(None);
        }
        w.record(Some(Duration::from_millis(40)));
        assert_eq!(w.slots.len(), WINDOW);
        assert!(w.loss_ratio() < 1.0);
    }
}
""")
    jitter_test = T(r"""
    #[test]
    fn loss_window_evicts_oldest() {
        let mut w = LossWindow::new(Duration::from_millis(200));
        for _ in 0..WINDOW {
            w.record(None);
        }
        w.record(Some(Duration::from_millis(40)));
        assert_eq!(w.slots.len(), WINDOW);
        assert!(w.loss_ratio() < 1.0);
    }

    /// Deterministic jitter: rtt = 50 ms + (i * 37 mod 90) ms, so replies land between 50 and 139 ms
    /// against a 120 ms deadline. Every 4th packet is dropped outright.
    #[test]
    fn loss_detected_under_jitter() {
        let mut w = LossWindow::new(Duration::from_millis(120));
        for i in 0..WINDOW as u64 {
            let rtt = if i % 4 == 3 {
                None
            } else {
                Some(Duration::from_millis(50 + (i * 37) % 90))
            };
            w.record(rtt);
        }
        // 8 dropped + 5 late = 13 of 32
        assert!((w.loss_ratio() - 13.0 / 32.0).abs() < 1e-9);
        assert!(w.is_degraded());
    }
}
""")
    degraded_test = T(r"""
    /// Deterministic jitter: rtt = 50 ms + (i * 37 mod 90) ms, so replies land between 50 and 139 ms
    /// against a 120 ms deadline. Every 4th packet is dropped outright.
    #[test]
    fn loss_detected_under_jitter() {
        let mut w = LossWindow::new(Duration::from_millis(120));
        for i in 0..WINDOW as u64 {
            let rtt = if i % 4 == 3 {
                None
            } else {
                Some(Duration::from_millis(50 + (i * 37) % 90))
            };
            w.record(rtt);
        }
        // 8 dropped + 5 late = 13 of 32
        assert!((w.loss_ratio() - 13.0 / 32.0).abs() < 1e-9);
        assert!(w.is_degraded());
    }
}
""")
    degraded_new = T(r"""
    /// Deterministic jitter: rtt = 50 ms + (i * 37 mod 90) ms, so replies land between 50 and 139 ms
    /// against a 120 ms deadline. Every 4th packet is dropped outright.
    #[test]
    fn loss_detected_under_jitter() {
        let mut w = LossWindow::new(Duration::from_millis(120));
        for i in 0..WINDOW as u64 {
            let rtt = if i % 4 == 3 {
                None
            } else {
                Some(Duration::from_millis(50 + (i * 37) % 90))
            };
            w.record(rtt);
        }
        // 8 dropped + 5 late = 13 of 32
        assert!((w.loss_ratio() - 13.0 / 32.0).abs() < 1e-9);
        assert!(w.is_degraded());
    }

    #[test]
    fn degraded_flag_flips_at_thirty_percent() {
        let jitter = |i: u64| Some(Duration::from_millis(50 + (i * 37) % 90));

        // jitter alone: 7 late replies out of 32 is 21.9 percent, under the line
        let mut w = LossWindow::new(Duration::from_millis(120));
        for i in 0..WINDOW as u64 {
            w.record(jitter(i));
        }
        assert!(w.loss_ratio() < DEGRADED_LOSS);
        assert!(!w.is_degraded());

        // the same traffic with every 4th packet dropped crosses it (40.6 percent)
        let mut w = LossWindow::new(Duration::from_millis(120));
        for i in 0..WINDOW as u64 {
            w.record(if i % 4 == 3 { None } else { jitter(i) });
        }
        assert!(w.is_degraded());
    }
}
""")
    return Sess(
        key="zenith-cli/gemini-cli/loss-detection-jitter", agent="gemini-cli", project=P,
        start=at("2026-09-28", "19:20"), minutes=14, model="gemini-3.8-flash", branch="main",
        turns=[
            user("can you check that packet loss detection in the distributed consensus ping still behaves when there is "
                 "jitter on the link? i changed the window logic last week and never verified it"),
            asst("I'll find where loss is counted before writing anything.", [
                grep("loss", "src/consensus.rs",
                     "src/consensus.rs:14:const DEGRADED_LOSS: f64 = 0.30;\n"
                     "src/consensus.rs:118:    pub fn loss_ratio(&self) -> f64 {\n"
                     "src/consensus.rs:131:    pub fn is_degraded(&self) -> bool {\n"
                     "src/consensus.rs:132:        self.loss_ratio() > DEGRADED_LOSS\n"
                     "src/consensus.rs:263:    fn loss_ratio_counts_late_replies() {\n"
                     "src/consensus.rs:273:    fn loss_window_evicts_oldest() {"),
                read("src/consensus.rs", loss_read, start=92, limit=44),
            ]),
            asst("The window treats a reply slower than the deadline as lost, which is the part jitter can break. The existing "
                 "tests only use hand-picked samples, so I'll add one with a deterministic jitter pattern: replies between "
                 "50 and 139 ms against a 120 ms deadline, plus every 4th packet dropped.", [
                read("src/consensus.rs", tests_tail, start=262, limit=25),
                edit("src/consensus.rs", EVICT_TEST, jitter_test),
                bash("cargo test --lib loss",
                     BUILD_LINE + "\n    Finished `test` profile [unoptimized + debuginfo] target(s) in 2.41s\n" + LIB_TEST +
                     "\n\nrunning 3 tests\ntest consensus::tests::loss_ratio_counts_late_replies ... ok\n"
                     "test consensus::tests::loss_window_evicts_oldest ... ok\n"
                     "test consensus::tests::loss_detected_under_jitter ... ok\n\n"
                     "test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 14 filtered out; finished in 0.00s",
                     desc="Run the loss window tests"),
            ]),
            asst("Loss detection holds up under jitter. With the pattern above the window sees 8 dropped packets and 5 replies "
                 "that arrive after the 120 ms deadline, so 13 of 32 (40.6 percent), and `is_degraded()` is true. The test "
                 "passes on the first run and does not depend on a random seed."),
            user("nice. does it flip the degraded flag right at the 30 percent line though? that is what pages people"),
            asst("Good point, the first test is well above the line. I'll add one that sits on each side of it.", [
                edit("src/consensus.rs", degraded_test, degraded_new),
                bash("cargo test --lib loss",
                     BUILD_LINE + "\n    Finished `test` profile [unoptimized + debuginfo] target(s) in 1.88s\n" + LIB_TEST +
                     "\n\nrunning 4 tests\ntest consensus::tests::loss_ratio_counts_late_replies ... ok\n"
                     "test consensus::tests::loss_window_evicts_oldest ... ok\n"
                     "test consensus::tests::loss_detected_under_jitter ... ok\n"
                     "test consensus::tests::degraded_flag_flips_at_thirty_percent ... ok\n\n"
                     "test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 14 filtered out; finished in 0.00s",
                     desc="Rerun the loss window tests"),
            ]),
            asst("Yes, the threshold behaves. The new `degraded_flag_flips_at_thirty_percent` test checks both sides:\n\n"
                 "- jitter alone gives 7 late replies out of 32 (21.9 percent), so the node is **not** degraded\n"
                 "- the same traffic with every 4th packet dropped gives 40.6 percent, so it **is** degraded\n\n"
                 "I did not test the exact 30 percent boundary, because `is_degraded` uses a strict `>` and 30 percent of "
                 "32 slots is 9.6, which no whole number of lost packets can hit."),
        ],
    )


# ---------------------------------------------------------------------------
# 2. opencode: --output json for cluster inspect
# ---------------------------------------------------------------------------

def _opencode_json():
    cli_test_old = T(r"""
#[test]
fn inspect_table_default() {
    let api = MockApi::start();
    Command::cargo_bin("zenith")
        .unwrap()
        .args(["--api-url", &api.url(), "cluster", "inspect"])
        .assert()
        .success()
        .stdout(predicates::str::contains("NODE"));
}
""")
    cli_test_new = cli_test_old + "\n\n" + T(r"""
#[test]
fn inspect_json_output_parses() {
    let api = MockApi::start();
    let out = Command::cargo_bin("zenith")
        .unwrap()
        .args(["--api-url", &api.url(), "cluster", "inspect", "--output", "json"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let v: serde_json::Value = serde_json::from_slice(&out).expect("stdout is valid JSON");
    assert_eq!(v["leader"], "node-0");
    assert_eq!(v["nodes"].as_array().unwrap().len(), 3);
}
""")
    return Sess(
        key="zenith-cli/opencode/inspect-json-output", agent="opencode", project=P,
        start=at("2026-09-29", "16:10"), minutes=17, model="claude-sonnet-5-5",
        title="Add --output json to cluster inspect",
        turns=[
            user("add a --output json flag to `cluster inspect`. use the same json renderer health already uses, table stays the default"),
            asst("I'll read the inspect command and the output module first.", [
                read("src/commands/inspect.rs", INSPECT_BEFORE),
                read("src/output/json.rs", JSON_RS),
                read("src/output/mod.rs", F(r"""
//! Output renderers for CLI commands.

pub mod json;
pub mod table;
""")),
            ]),
            asst("`inspect` hardcodes the table renderer and there is no shared format type yet. I'll add an `OutputFormat` enum "
                 "to `output/mod.rs` so other commands can reuse it, then wire it into the inspect args.", [
                edit("src/output/mod.rs",
                     "pub mod json;\npub mod table;",
                     T(r"""
pub mod json;
pub mod table;

/// How a command prints its result.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, clap::ValueEnum)]
pub enum OutputFormat {
    #[default]
    Table,
    Json,
}
""")),
                edit("src/commands/inspect.rs",
                     "use crate::output::table;",
                     "use crate::output::{json, table, OutputFormat};"),
                edit("src/commands/inspect.rs",
                     "    pub node: Option<String>,\n}",
                     "    pub node: Option<String>,\n    /// Output format\n    #[arg(long, value_enum, default_value_t = OutputFormat::Table)]\n    pub output: OutputFormat,\n}"),
                edit("src/commands/inspect.rs",
                     '    println!("{}", table::render_report(&report));\n    Ok(())',
                     '    match args.output {\n        OutputFormat::Table => println!("{}", table::render_report(&report)),\n'
                     '        OutputFormat::Json => println!("{}", json::render_json(&report)?),\n    }\n    Ok(())'),
                bash("cargo build 2>&1 | tail -5",
                     BUILD_LINE + "\n    Finished `dev` profile [unoptimized + debuginfo] target(s) in 4.07s",
                     desc="Build the crate"),
            ]),
            asst("It builds. Now a CLI test so the flag stays covered; let me see how the existing inspect test is written.", [
                grep("fn inspect", "tests/cli.rs", "tests/cli.rs:44:fn inspect_table_default() {"),
                read("tests/cli.rs", cli_test_old, start=43, limit=10),
                edit("tests/cli.rs", cli_test_old, cli_test_new),
                bash("cargo test --test cli inspect",
                     BUILD_LINE + "\n    Finished `test` profile [unoptimized + debuginfo] target(s) in 3.35s\n"
                     "     Running tests/cli.rs (target/debug/deps/cli-b71e0d95c2a8e3f4)\n\nrunning 2 tests\n"
                     "test inspect_json_output_parses ... ok\ntest inspect_table_default ... ok\n\n"
                     "test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 4 filtered out; finished in 0.21s",
                     desc="Run the inspect CLI tests"),
            ]),
            asst("`zenith cluster inspect --output json` now prints the cluster report as pretty JSON, and the table is still "
                 "the default.\n\n"
                 "- new `OutputFormat` enum in `src/output/mod.rs` (`Table`, `Json`), a `clap::ValueEnum` so `--help` lists the values\n"
                 "- `inspect.rs` picks the renderer with a `match`, so adding another format later is a compile error until it is handled\n"
                 "- `tests/cli.rs` has `inspect_json_output_parses`, which checks stdout parses and has the leader and 3 nodes\n\n"
                 "```sh\nzenith cluster inspect --output json | jq '.leader'\n```"),
        ],
    )


# ---------------------------------------------------------------------------
# 3. claude-code: client-side rate limiter (test first, red then green)
# ---------------------------------------------------------------------------

def _claude_rate_limiter():
    tests = r"""
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn spaces_requests_evenly() {
        let mut rl = RateLimiter::new(10, 1);
        let t0 = Instant::now();
        for _ in 0..5 {
            rl.acquire().await;
        }
        // first call is free, then four gaps of 100 ms
        assert_eq!(t0.elapsed(), Duration::from_millis(400));
    }

    #[tokio::test(start_paused = true)]
    async fn allows_burst_then_throttles() {
        let mut rl = RateLimiter::new(10, 3);
        let t0 = Instant::now();
        for _ in 0..3 {
            rl.acquire().await;
        }
        assert_eq!(t0.elapsed(), Duration::ZERO);
        rl.acquire().await;
        assert_eq!(t0.elapsed(), Duration::from_millis(100));
    }
}
"""
    stub = F(r"""
use tokio::time::{Duration, Instant};

pub struct RateLimiter {
    interval: Duration,
}

impl RateLimiter {
    pub fn new(per_second: u32, burst: u32) -> Self {
        todo!()
    }

    pub async fn acquire(&mut self) {
        todo!()
    }
}
""") + "\n" + F(tests)
    impl = F(r"""
use tokio::time::{sleep_until, Duration, Instant};

/// Client-side limiter in front of the cluster API (GCRA: one timestamp, no background task).
pub struct RateLimiter {
    interval: Duration,
    burst: u32,
    /// Theoretical arrival time: when the next request would be due if we were exactly on rate.
    tat: Instant,
}

impl RateLimiter {
    pub fn new(per_second: u32, burst: u32) -> Self {
        assert!(per_second > 0, "rate must be positive");
        Self {
            interval: Duration::from_secs(1) / per_second,
            burst: burst.max(1),
            tat: Instant::now(),
        }
    }

    /// Waits until a request is allowed. Up to `burst` requests may go out back to back.
    pub async fn acquire(&mut self) {
        let now = Instant::now();
        let tat = self.tat.max(now);
        let allow_at = tat.checked_sub(self.interval * (self.burst - 1)).unwrap_or(now);
        self.tat = tat + self.interval;
        if allow_at > now {
            sleep_until(allow_at).await;
        }
    }
}
""") + "\n" + F(tests)
    fail_out = T(r"""
   Compiling zenith-cli v0.9.2 (/Users/fictional-dev/projects/zenith-cli)
warning: unused variable: `per_second`
 --> src/ratelimit.rs:8:19
  |
8 |     pub fn new(per_second: u32, burst: u32) -> Self {
  |                ^^^^^^^^^^ help: if this is intentional, prefix it with an underscore: `_per_second`

    Finished `test` profile [unoptimized + debuginfo] target(s) in 2.93s
     Running unittests src/lib.rs (target/debug/deps/zenith_cli-3f9a1c0be2d47a58)

running 2 tests
test ratelimit::tests::allows_burst_then_throttles ... FAILED
test ratelimit::tests::spaces_requests_evenly ... FAILED

failures:

---- ratelimit::tests::allows_burst_then_throttles stdout ----

thread 'ratelimit::tests::allows_burst_then_throttles' panicked at src/ratelimit.rs:9:9:
not yet implemented

---- ratelimit::tests::spaces_requests_evenly stdout ----

thread 'ratelimit::tests::spaces_requests_evenly' panicked at src/ratelimit.rs:9:9:
not yet implemented


failures:
    ratelimit::tests::allows_burst_then_throttles
    ratelimit::tests::spaces_requests_evenly

test result: FAILED. 0 passed; 2 failed; 0 ignored; 0 measured; 18 filtered out; finished in 0.00s

error: test failed, to rerun pass `--lib`
""")
    main_read = T(r"""
#[derive(Parser)]
#[command(name = "zenith", version, about = "Cluster admin CLI")]
struct Cli {
    /// Base URL of the cluster API
    #[arg(long, global = true, env = "ZENITH_API_URL", default_value = "http://localhost:8480")]
    api_url: String,

    /// Increase log verbosity (-v debug, -vv trace)
    #[arg(short, long, global = true, action = clap::ArgAction::Count)]
    verbose: u8,

    #[command(subcommand)]
    command: Commands,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    init_tracing(cli.verbose);
    let api = ApiClient::new(&cli.api_url)?;
    match cli.command {
""")
    return Sess(
        key="zenith-cli/claude-code/client-rate-limiter", agent="claude-code", project=P,
        start=at("2026-09-30", "15:05"), minutes=42, model="claude-sonnet-5-5", branch="client-rate-limit",
        turns=[
            user("ops got paged again, `zenith health --watch` on the prod sized cluster fires something like 200 requests a "
                 "second at the cluster API and we get 429s back. add a client-side rate limiter in front of the HTTP client, "
                 "default 20 req/s, overridable with --max-rps. write the test first and let me see it fail before you implement it"),
            asst("I'll find where requests leave the CLI before deciding where the limiter belongs.", [
                grep("get_json|reqwest::Client", "src",
                     "src/api.rs:12:        let http = reqwest::Client::builder()\n"
                     "src/api.rs:19:    pub async fn get_json<T: DeserializeOwned>(&self, path: &str) -> Result<T> {\n"
                     "src/commands/health.rs:17:    api.get_json(&format!(\"v1/nodes/{node}/health\")).await\n"
                     "src/commands/health.rs:22:        let ids = api.get_json::<Vec<NodeId>>(\"v1/nodes\").await?;\n"
                     "src/commands/ping.rs:17:        let reply: RoundReply = api.get_json(\"v1/consensus/ping\").await?;"),
                read("src/api.rs", API_RS),
                read("src/commands/health.rs", "/// One health probe of a single node. Fails fast: no retries.\n"
                     "pub async fn probe_node(api: &ApiClient, node: &NodeId) -> Result<NodeHealth> {\n"
                     "    api.get_json(&format!(\"v1/nodes/{node}/health\")).await\n}\n\n"
                     "pub async fn run(api: &ApiClient, args: HealthArgs) -> Result<()> {\n    loop {\n"
                     "        let ids = api.get_json::<Vec<NodeId>>(\"v1/nodes\").await?;\n"
                     "        // one probe per node, all in flight at once\n"
                     "        let probes = futures::future::join_all(ids.iter().map(|id| probe_node(api, id))).await;\n"
                     "        print_probes(&ids, &probes);\n        if !args.watch {\n            return Ok(());\n        }\n"
                     "        tokio::time::sleep(std::time::Duration::from_secs(5)).await;\n    }\n}\n", start=15, limit=17),
                grep("tokio|pub mod", ".", "Cargo.toml:18:tokio = { version = \"1\", features = [\"rt-multi-thread\", \"macros\", \"time\"] }\n"
                     "src/lib.rs:1:pub mod api;\nsrc/lib.rs:2:pub mod cache;\nsrc/lib.rs:3:pub mod commands;\n"
                     "src/lib.rs:4:pub mod consensus;\nsrc/lib.rs:5:pub mod model;\nsrc/lib.rs:6:pub mod output;"),
            ]),
            asst("Every command goes through `ApiClient::get_json`, and `--watch` fans out one probe per node with `join_all`, so "
                 "a big cluster means hundreds of simultaneous calls. The limiter belongs inside the client so every command "
                 "benefits, not just health. Test first: a stub that panics, plus two tests on tokio's paused clock so they run "
                 "instantly.", [
                edit("Cargo.toml",
                     'tokio = { version = "1", features = ["rt-multi-thread", "macros", "time"] }',
                     'tokio = { version = "1", features = ["rt-multi-thread", "macros", "time", "test-util"] }'),
                edit("src/lib.rs", "pub mod output;", "pub mod output;\npub mod ratelimit;"),
                write("src/ratelimit.rs", stub),
                bash("cargo test --lib ratelimit", fail_out, error=True, desc="Run the new rate limiter tests (expected to fail)"),
            ]),
            asst("Both tests fail on the `todo!()`, as intended. Now the real implementation. I'm using GCRA (one timestamp per "
                 "limiter, no background refill task), which gives an exact even spacing and a configurable burst.", [
                write("src/ratelimit.rs", impl),
                bash("cargo test --lib ratelimit",
                     BUILD_LINE + "\n    Finished `test` profile [unoptimized + debuginfo] target(s) in 2.37s\n" + LIB_TEST +
                     "\n\nrunning 2 tests\ntest ratelimit::tests::allows_burst_then_throttles ... ok\n"
                     "test ratelimit::tests::spaces_requests_evenly ... ok\n\n"
                     "test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 18 filtered out; finished in 0.00s",
                     desc="Rerun the rate limiter tests"),
            ]),
            asst("Green. Now wire it into the client. I'll hold the lock while waiting so concurrent callers queue up in order "
                 "instead of all waking at once, and add the `--max-rps` flag.", [
                edit("src/api.rs", "use serde::de::DeserializeOwned;",
                     "use serde::de::DeserializeOwned;\nuse tokio::sync::Mutex;\n\nuse crate::ratelimit::RateLimiter;"),
                edit("src/api.rs", "pub struct ApiClient {\n    http: reqwest::Client,\n    base: Url,\n}",
                     "pub struct ApiClient {\n    http: reqwest::Client,\n    base: Url,\n    limiter: Mutex<RateLimiter>,\n}"),
                edit("src/api.rs", "    pub fn new(base: &str) -> Result<Self> {",
                     "    pub fn new(base: &str, max_rps: u32) -> Result<Self> {"),
                edit("src/api.rs", "        Ok(Self { http, base: Url::parse(base)? })",
                     "        let limiter = Mutex::new(RateLimiter::new(max_rps, max_rps.min(5)));\n"
                     "        Ok(Self { http, base: Url::parse(base)?, limiter })"),
                edit("src/api.rs",
                     "        let resp = self.http.get(url).send().await?.error_for_status()?;",
                     "        // the lock is held while waiting, which queues concurrent callers in order\n"
                     "        self.limiter.lock().await.acquire().await;\n"
                     "        let resp = self.http.get(url).send().await?.error_for_status()?;"),
                read("src/main.rs", main_read, start=10, limit=24),
            ]),
            asst("The client is wired. Last piece is the global flag and passing it through in `main.rs`.", [
                edit("src/main.rs",
                     '    api_url: String,\n\n    /// Increase log verbosity',
                     '    api_url: String,\n\n    /// Client-side cap on requests per second sent to the cluster API\n'
                     '    #[arg(long, global = true, env = "ZENITH_MAX_RPS", default_value_t = 20)]\n    max_rps: u32,\n\n'
                     '    /// Increase log verbosity'),
                edit("src/main.rs",
                     "    let api = ApiClient::new(&cli.api_url)?;",
                     "    let api = ApiClient::new(&cli.api_url, cli.max_rps)?;"),
                bash("cargo test 2>&1 | grep -E 'Running|test result|error'",
                     "     Running unittests src/lib.rs (target/debug/deps/zenith_cli-3f9a1c0be2d47a58)\n"
                     "test result: ok. 20 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s\n"
                     "     Running unittests src/main.rs (target/debug/deps/zenith-8d2b6e4a71c05f93)\n"
                     "test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n"
                     "     Running tests/cli.rs (target/debug/deps/cli-b71e0d95c2a8e3f4)\n"
                     "test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.34s\n"
                     "     Running tests/consensus_failover.rs (target/debug/deps/consensus_failover-5ce03a97d1b4e268)\n"
                     "test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.52s",
                     desc="Run the whole test suite"),
            ]),
            asst("The CLI now throttles itself. `--max-rps` (or `ZENITH_MAX_RPS`) defaults to 20 requests per second, with a burst of up to 5.\n\n"
                 "- `src/ratelimit.rs`: GCRA limiter, two tests on a paused clock (even spacing, burst then throttle). They failed first on the `todo!()`, then passed.\n"
                 "- `src/api.rs`: `get_json` waits on the limiter before every request, so `health`, `ping` and `inspect` are all covered\n"
                 "- `Cargo.toml`: tokio gets the `test-util` feature for the paused clock\n"
                 "- the full suite passes (20 lib, 6 CLI, 3 failover)\n\n"
                 "`ApiClient::new` now takes the rate as a second argument, so any other caller needs updating; `main.rs` was the only one."),
            user("nice. can it log a debug line when it actually has to wait? i want to see the throttling with -v"),
            asst("I'll time the wait around `acquire` and only log when it is long enough to matter.", [
                edit("src/api.rs",
                     "        self.limiter.lock().await.acquire().await;",
                     "        let queued_at = std::time::Instant::now();\n"
                     "        self.limiter.lock().await.acquire().await;\n"
                     "        let waited = queued_at.elapsed();\n"
                     "        if waited >= std::time::Duration::from_millis(50) {\n"
                     "            tracing::debug!(path, waited_ms = waited.as_millis() as u64, \"client rate limiter delayed request\");\n"
                     "        }"),
                bash("cargo clippy --all-targets -- -D warnings 2>&1 | tail -3",
                     "    Checking zenith-cli v0.9.2 (/Users/fictional-dev/projects/zenith-cli)\n"
                     "    Finished `dev` profile [unoptimized + debuginfo] target(s) in 3.88s"),
            ]),
            asst("Done. With `-v`, any request that waited 50 ms or more on the limiter logs a line like this:\n\n"
                 "```text\nDEBUG zenith_cli::api: client rate limiter delayed request path=\"v1/nodes/node-3/health\" waited_ms=187\n```\n\n"
                 "Short waits stay silent so a normal run is not noisy. Clippy is clean with `-D warnings`. I did not add a test for the log line itself."),
        ],
    )


# ---------------------------------------------------------------------------
# Shared: consensus.rs PingRound excerpt and ping.rs
# ---------------------------------------------------------------------------

PING_ROUND = T(r"""
pub struct PingRound {
    pub term: u64,
    origin: NodeId,
    cluster_size: usize,
    replies: Vec<PingReply>,
    timed_out: Vec<NodeId>,
    refused: Vec<NodeId>,
}

impl PingRound {
    pub fn has_quorum(&self) -> bool {
        // a majority of the nodes we heard anything from
        let known = self.replies.len() + self.timed_out.len();
        self.replies.len() * 2 > known
    }

    pub fn leader(&self) -> Option<&NodeId> {
        self.replies.iter().find_map(|r| r.leader.as_ref())
    }

    pub fn unreachable(&self) -> Vec<&NodeId> {
        self.timed_out.iter().chain(self.refused.iter()).collect()
    }
}
""")

PING_RS_BEFORE = F(r"""
use anyhow::Result;
use clap::Args;

use crate::api::ApiClient;
use crate::consensus::PingRound;
use crate::model::RoundReply;

#[derive(Args)]
pub struct PingArgs {
    /// Number of broadcast rounds to run
    #[arg(short, long, default_value_t = 1)]
    pub rounds: u32,
}

pub async fn run(api: &ApiClient, args: PingArgs) -> Result<()> {
    for round_no in 1..=args.rounds {
        let reply: RoundReply = api.get_json("v1/consensus/ping").await?;
        let round = PingRound::from(reply);
        println!(
            "round {round_no}: {} replies, {} unreachable",
            round.reply_count(),
            round.unreachable().len()
        );
    }
    Ok(())
}
""")

PING_RS_AFTER_TOPO = F(r"""
use anyhow::Result;
use clap::Args;

use crate::api::ApiClient;
use crate::consensus::{PingRound, Topology};
use crate::model::RoundReply;
use crate::output::table;

#[derive(Args)]
pub struct PingArgs {
    /// Number of broadcast rounds to run
    #[arg(short, long, default_value_t = 1)]
    pub rounds: u32,
    /// Also print who pinged whom, with the leader marked
    #[arg(long)]
    pub topology: bool,
}

pub async fn run(api: &ApiClient, args: PingArgs) -> Result<()> {
    for round_no in 1..=args.rounds {
        let reply: RoundReply = api.get_json("v1/consensus/ping").await?;
        let round = PingRound::from(reply);
        println!(
            "round {round_no}: {} replies, {} unreachable",
            round.reply_count(),
            round.unreachable().len()
        );
        if args.topology {
            println!("{}", table::render_topology(&Topology::from_round(&round)));
        }
    }
    Ok(())
}
""")

TESTS_HEADER = "#[cfg(test)]\nmod tests {\n    use super::*;"


# ---------------------------------------------------------------------------
# 4. opencode: topology map of the ping broadcast
# ---------------------------------------------------------------------------

def _opencode_topology():
    topo_code = T(r"""
/// One directed link in a ping broadcast: `from` pinged `to`.
#[derive(Debug, Clone, Serialize)]
pub struct Edge {
    pub from: NodeId,
    pub to: NodeId,
    /// Round-trip time in milliseconds, `None` when the node never answered.
    pub rtt_ms: Option<u32>,
}

/// Who pinged whom in one broadcast round, with the leader the replies agreed on.
#[derive(Debug, Serialize)]
pub struct Topology {
    pub term: u64,
    pub leader: Option<NodeId>,
    pub edges: Vec<Edge>,
}

impl Topology {
    pub fn from_round(round: &PingRound) -> Self {
        let mut edges: Vec<Edge> = round
            .replies
            .iter()
            .map(|r| Edge {
                from: round.origin,
                to: r.node.clone(),
                rtt_ms: Some((r.rtt.as_secs_f64() * 1000.0).round() as u32),
            })
            .collect();
        edges.extend(round.timed_out.iter().chain(round.refused.iter()).map(|n| Edge {
            from: round.origin,
            to: n.clone(),
            rtt_ms: None,
        }));
        Self { term: round.term, leader: round.leader().cloned(), edges }
    }
}
""")
    render_fn = T(r"""
/// Plain-text map of a ping broadcast: the leader line, then one row per link.
pub fn render_topology(topo: &Topology) -> String {
    let mut out = match &topo.leader {
        Some(l) => format!("leader: {l} (term {})\n", topo.term),
        None => format!("leader: none (term {})\n", topo.term),
    };
    out.push_str("FROM      TO        RTT\n");
    for e in &topo.edges {
        let rtt = e.rtt_ms.map_or("unreachable".to_string(), |ms| format!("{ms} ms"));
        out.push_str(&format!("{:<9} {:<9} {}\n", e.from, e.to, rtt));
    }
    out
}
""")
    err = T(r"""
   Compiling zenith-cli v0.9.2 (/Users/fictional-dev/projects/zenith-cli)
error[E0507]: cannot move out of `round.origin` which is behind a shared reference
   --> src/consensus.rs:172:23
    |
172 |                 from: round.origin,
    |                       ^^^^^^^^^^^^ move occurs because `round.origin` has type `NodeId`, which does not implement the `Copy` trait
    |
help: consider cloning the value if the performance cost is acceptable
    |
172 |                 from: round.origin.clone(),
    |                                   ++++++++

error[E0507]: cannot move out of `round.origin` which is behind a shared reference
   --> src/consensus.rs:179:19
    |
179 |             from: round.origin,
    |                   ^^^^^^^^^^^^ move occurs because `round.origin` has type `NodeId`, which does not implement the `Copy` trait
    |
help: consider cloning the value if the performance cost is acceptable
    |
179 |             from: round.origin.clone(),
    |                               ++++++++

For more information about this error, try `rustc --explain E0507`.
error: could not compile `zenith-cli` (lib) due to 2 previous errors
""")
    test = T(r"""
    #[test]
    fn topology_marks_unreachable_edges() {
        let reply = |n: &str, us: u64| PingReply {
            node: NodeId::new(n),
            term: 7,
            rtt: Duration::from_micros(us),
            leader: Some(NodeId::new("node-0")),
        };
        let round = PingRound {
            term: 7,
            origin: NodeId::new("node-0"),
            cluster_size: 5,
            replies: vec![reply("node-1", 1830), reply("node-2", 2410), reply("node-3", 9120)],
            timed_out: vec![],
            refused: vec![NodeId::new("node-4")],
        };
        let topo = Topology::from_round(&round);
        assert_eq!(topo.leader, Some(NodeId::new("node-0")));
        assert_eq!(topo.edges.len(), 4);
        assert_eq!(topo.edges[0].rtt_ms, Some(2));
        assert_eq!(topo.edges[3].to, NodeId::new("node-4"));
        assert_eq!(topo.edges[3].rtt_ms, None);
    }""")
    return Sess(
        key="zenith-cli/opencode/ping-topology-map", agent="opencode", project=P,
        start=at("2026-09-30", "20:10"), minutes=24, model="claude-sonnet-5-5",
        title="Map cluster topology during consensus ping",
        turns=[
            user("i want to see the network topology while a distributed consensus ping broadcast runs: which node pinged which, "
                 "rtt on each link, leader marked. data structure plus a plain table for `zenith ping --topology`, nothing graphical"),
            asst("I'll read how a round is represented today and how the ping command prints it.", [
                read("src/consensus.rs", PING_ROUND, start=40, limit=24),
                read("src/commands/ping.rs", PING_RS_BEFORE),
                read("src/output/table.rs", T(r"""
use comfy_table::{presets::NOTHING, Table};

use crate::model::ClusterReport;

/// Renders the cluster report as an aligned text table.
pub fn render_report(report: &ClusterReport) -> String {
"""), start=1, limit=6),
            ]),
            asst("A round already knows its origin, the replies, and which nodes timed out or refused the connection, so the "
                 "topology is a view over it: one edge per node pinged, with an rtt for replies and none for the rest. "
                 "I'll put `Topology` next to `PingRound` and keep the rendering in `output/table.rs`.", [
                edit("src/consensus.rs",
                     "    pub fn unreachable(&self) -> Vec<&NodeId> {\n        self.timed_out.iter().chain(self.refused.iter()).collect()\n    }\n}",
                     "    pub fn unreachable(&self) -> Vec<&NodeId> {\n        self.timed_out.iter().chain(self.refused.iter()).collect()\n    }\n}\n\n" + topo_code),
                edit("src/output/table.rs", "use crate::model::ClusterReport;",
                     "use crate::consensus::Topology;\nuse crate::model::ClusterReport;"),
                edit("src/output/table.rs", "pub fn render_report(report: &ClusterReport) -> String {",
                     render_fn + "\n\npub fn render_report(report: &ClusterReport) -> String {"),
                edit("src/commands/ping.rs", "use crate::consensus::PingRound;\nuse crate::model::RoundReply;",
                     "use crate::consensus::{PingRound, Topology};\nuse crate::model::RoundReply;\nuse crate::output::table;"),
                edit("src/commands/ping.rs", "    pub rounds: u32,\n}",
                     "    pub rounds: u32,\n    /// Also print who pinged whom, with the leader marked\n    #[arg(long)]\n    pub topology: bool,\n}"),
                edit("src/commands/ping.rs", "            round.unreachable().len()\n        );",
                     "            round.unreachable().len()\n        );\n        if args.topology {\n"
                     "            println!(\"{}\", table::render_topology(&Topology::from_round(&round)));\n        }"),
                bash("cargo build 2>&1 | head -30", err, error=True, desc="Build the crate"),
            ]),
            asst("`NodeId` is not `Copy` and `from_round` only has a shared reference to the round, so both edge constructors need a clone.", [
                edit("src/consensus.rs",
                     "            .map(|r| Edge {\n                from: round.origin,",
                     "            .map(|r| Edge {\n                from: round.origin.clone(),"),
                edit("src/consensus.rs",
                     "        edges.extend(round.timed_out.iter().chain(round.refused.iter()).map(|n| Edge {\n            from: round.origin,",
                     "        edges.extend(round.timed_out.iter().chain(round.refused.iter()).map(|n| Edge {\n            from: round.origin.clone(),"),
                edit("src/consensus.rs", TESTS_HEADER, TESTS_HEADER + "\n\n" + test),
                bash("cargo test --lib topology",
                     BUILD_LINE + "\n    Finished `test` profile [unoptimized + debuginfo] target(s) in 3.02s\n" + LIB_TEST +
                     "\n\nrunning 1 test\ntest consensus::tests::topology_marks_unreachable_edges ... ok\n\n"
                     "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 20 filtered out; finished in 0.00s",
                     desc="Run the topology test"),
            ]),
            asst("`zenith ping --topology` now prints the map of each broadcast round.\n\n"
                 "- `Topology` and `Edge` in `src/consensus.rs` (both `Serialize`, so a JSON mode is cheap to add later)\n"
                 "- unreachable nodes, whether they timed out or refused the connection, show up as edges with `rtt_ms: None`\n"
                 "- `render_topology` in `src/output/table.rs` prints the leader line, then one row per link\n"
                 "- the first build failed with two `E0507` errors (moving `round.origin` out of a reference); both fixed with `.clone()`\n\n"
                 "```text\nleader: node-0 (term 7)\nFROM      TO        RTT\nnode-0    node-1    2 ms\n"
                 "node-0    node-2    2 ms\nnode-0    node-3    9 ms\nnode-0    node-4    unreachable\n```\n\n"
                 "That sample output is from the unit test's data, I did not run it against a live cluster."),
        ],
    )


# ---------------------------------------------------------------------------
# 5. codex-cli: failover test with three disconnected nodes
# ---------------------------------------------------------------------------

def _codex_failover():
    full_test_file = FAILOVER_BASE + "\n" + FAILOVER_NEW_TEST + "\n"
    n_base = FAILOVER_BASE.count("\n")
    # line numbers of the two assertions inside the new test
    new_lines = FAILOVER_NEW_TEST.split("\n")
    quorum_line = n_base + 1 + [i for i, ln in enumerate(new_lines) if "quorum must be lost" in ln][0] + 1
    leader_line = n_base + 1 + [i for i, ln in enumerate(new_lines) if "step down" in ln][0] + 1
    head = (BUILD_LINE + "\n    Finished `test` profile [unoptimized + debuginfo] target(s) in 2.74s\n"
            "     Running tests/consensus_failover.rs (target/debug/deps/consensus_failover-5ce03a97d1b4e268)\n\n")
    fail1 = head + (
        "running 4 tests\ntest follower_promotes_after_leader_loss ... ok\ntest leader_elected_on_healthy_cluster ... ok\n"
        "test single_node_partition_keeps_quorum ... ok\ntest three_disconnected_nodes_drop_quorum ... FAILED\n\n"
        "failures:\n\n---- three_disconnected_nodes_drop_quorum stdout ----\n\n"
        f"thread 'three_disconnected_nodes_drop_quorum' panicked at tests/consensus_failover.rs:{quorum_line}:5:\n"
        "2 of 5 nodes answered, quorum must be lost\n"
        "note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace\n\n\n"
        "failures:\n    three_disconnected_nodes_drop_quorum\n\n"
        "test result: FAILED. 3 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.04s\n\n"
        "error: test failed, to rerun pass `--test consensus_failover`")
    fail2 = head + (
        "running 4 tests\ntest follower_promotes_after_leader_loss ... ok\ntest leader_elected_on_healthy_cluster ... ok\n"
        "test single_node_partition_keeps_quorum ... ok\ntest three_disconnected_nodes_drop_quorum ... FAILED\n\n"
        "failures:\n\n---- three_disconnected_nodes_drop_quorum stdout ----\n\n"
        f"thread 'three_disconnected_nodes_drop_quorum' panicked at tests/consensus_failover.rs:{leader_line}:5:\n"
        "assertion `left == right` failed: leader must step down without quorum\n"
        "  left: Some(NodeId(\"node-0\"))\n right: None\n"
        "note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace\n\n\n"
        "failures:\n    three_disconnected_nodes_drop_quorum\n\n"
        "test result: FAILED. 3 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.04s\n\n"
        "error: test failed, to rerun pass `--test consensus_failover`")
    ok4 = head + (
        "running 4 tests\ntest follower_promotes_after_leader_loss ... ok\ntest leader_elected_on_healthy_cluster ... ok\n"
        "test single_node_partition_keeps_quorum ... ok\ntest three_disconnected_nodes_drop_quorum ... ok\n\n"
        "test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.03s")
    two_down = T(r"""
#[tokio::test]
async fn two_disconnected_nodes_keep_quorum() {
    let mut cluster = SimCluster::new(5);
    cluster.ping_round().await;
    cluster.disconnect(&[3, 4]);
    let round = cluster.ping_round().await;

    assert_eq!(round.unreachable().len(), 2);
    assert!(round.has_quorum(), "3 of 5 nodes answered, quorum must hold");
    assert_eq!(round.leader(), Some(cluster.node_id(0)));
}""")
    ok5 = head + (
        "running 5 tests\ntest follower_promotes_after_leader_loss ... ok\ntest leader_elected_on_healthy_cluster ... ok\n"
        "test single_node_partition_keeps_quorum ... ok\ntest three_disconnected_nodes_drop_quorum ... ok\n"
        "test two_disconnected_nodes_keep_quorum ... ok\n\n"
        "test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.04s")
    return Sess(
        key="zenith-cli/codex-cli/failover-three-nodes-down", agent="codex-cli", project=P,
        start=at("2026-10-01", "16:30"), minutes=48, model="gpt-6.1", branch="failover-tests",
        turns=[
            user("Add a failover test to tests/consensus_failover.rs: 5 node cluster, three nodes disconnected while the distributed "
                 "consensus ping is in flight. The round should report no quorum and the leader should step down. Use the SimCluster "
                 "helper in tests/common, don't add a new harness."),
            asst("I'll read the sim helper, the existing failover tests and the round type they assert on.", [
                bash("ls tests tests/common", "tests:\ncli.rs\ncommon\nconsensus_failover.rs\n\ntests/common:\nmod.rs"),
                read("tests/common/mod.rs", SIM_COMMON),
                read("tests/consensus_failover.rs", FAILOVER_BASE),
                read("src/consensus.rs", PING_ROUND, start=40, limit=24),
            ]),
            asst("`disconnect` makes a node refuse connections, which lands in `refused`, and `unreachable()` already merges that with "
                 "timeouts. I'll write the test against the behaviour you described and see what it does.", [
                edit("tests/consensus_failover.rs",
                     "    assert_eq!(round.unreachable().len(), 1);\n}",
                     "    assert_eq!(round.unreachable().len(), 1);\n}\n\n" + FAILOVER_NEW_TEST),
                bash("cargo test --test consensus_failover", fail1, error=True),
            ]),
            asst("The test found a real bug rather than a test mistake: `unreachable().len()` is 3 as expected, but `has_quorum()` still "
                 "says yes. Let me see where `cluster_size` is used.", [
                grep("cluster_size", "src",
                     "src/consensus.rs:43:    cluster_size: usize,\nsrc/consensus.rs:207:        cluster_size: nodes.len(),"),
                bash("cargo build 2>&1 | grep -A3 'never read'",
                     "warning: field `cluster_size` is never read\n  --> src/consensus.rs:43:5\n   |\n40 | pub struct PingRound {\n   |            --------- field in this struct"),
            ]),
            asst("`has_quorum` takes its majority over `replies + timed_out`, and refused connections are in neither, so with 2 replies and "
                 "3 refusals it computes 2 > 2. `cluster_size` is set but never read. Counting against the whole cluster fixes it.", [
                edit("src/consensus.rs",
                     "        // a majority of the nodes we heard anything from\n        let known = self.replies.len() + self.timed_out.len();\n        self.replies.len() * 2 > known",
                     "        // a majority of the whole cluster, not of the nodes that answered or timed out:\n"
                     "        // refused connections have to count against us too\n        self.replies.len() * 2 > self.cluster_size"),
                bash("cargo test --test consensus_failover", fail2, error=True),
            ]),
            asst("Quorum is now correctly lost, and the second assertion shows the other half: `leader()` still returns whatever the "
                 "replies claimed. A leader without quorum has to step down, so `leader()` should answer `None` in that case.", [
                edit("src/consensus.rs",
                     "    pub fn leader(&self) -> Option<&NodeId> {\n        self.replies.iter().find_map(|r| r.leader.as_ref())",
                     "    pub fn leader(&self) -> Option<&NodeId> {\n        if !self.has_quorum() {\n            return None;\n        }\n"
                     "        self.replies.iter().find_map(|r| r.leader.as_ref())"),
                bash("cargo test --test consensus_failover", ok4),
            ]),
            asst("All four failover tests pass.\n\n"
                 "- new test `three_disconnected_nodes_drop_quorum` in `tests/consensus_failover.rs`\n"
                 "- bug 1 in `PingRound::has_quorum`: refused connections were left out of the denominator, so 2 of 5 nodes counted as a majority\n"
                 "- bug 2 in `PingRound::leader`: it reported a leader even when the round had no quorum\n\n"
                 "```rust\npub fn has_quorum(&self) -> bool {\n    self.replies.len() * 2 > self.cluster_size\n}\n```\n\n"
                 "The 3-node `single_node_partition_keeps_quorum` test still passes, since 2 replies out of 3 is a majority."),
            user("good catch. add the mirror case too, two nodes down should still have quorum and keep the leader"),
            asst("Adding it next to the other test and rerunning the file.", [
                edit("tests/consensus_failover.rs", FAILOVER_NEW_TEST, FAILOVER_NEW_TEST + "\n\n" + two_down),
                bash("cargo test --test consensus_failover", ok5),
            ]),
            asst("`two_disconnected_nodes_keep_quorum` passes: with 3 of 5 answering the round keeps quorum and `node-0` stays leader. "
                 "Together with the three-down case this pins the boundary at exactly a majority of the cluster."),
        ],
    )


# ---------------------------------------------------------------------------
# 6. github-copilot-cli: diagnostic benchmark
# ---------------------------------------------------------------------------

def _copilot_bench():
    return Sess(
        key="zenith-cli/github-copilot-cli/ping-rtt-benchmark", agent="github-copilot-cli", project=P,
        start=at("2026-10-01", "19:15"), minutes=8, model="gpt-6.1",
        turns=[
            user("run a quick diagnostic benchmark of the distributed consensus ping across the 5 sim nodes and tell me which one is the slowest"),
            asst("I'll check which benches exist and run the round trip one with short timings.", [
                bash("ls benches", "loss_window.rs\nping_rtt.rs"),
                bash("cargo bench --bench ping_rtt -- --warm-up-time 1 --measurement-time 3",
                     "   Compiling zenith-cli v0.9.2 (/Users/fictional-dev/projects/zenith-cli)\n"
                     "    Finished `bench` profile [optimized] target(s) in 14.52s\n"
                     "     Running benches/ping_rtt.rs (target/release/deps/ping_rtt-a41c7e90d3b2f586)\n"
                     "Benchmarking ping_rtt/node-0\nping_rtt/node-0         time:   [1.8412 ms 1.8533 ms 1.8671 ms]\n"
                     "ping_rtt/node-1         time:   [2.3908 ms 2.4121 ms 2.4366 ms]\n"
                     "ping_rtt/node-2         time:   [2.4377 ms 2.4590 ms 2.4802 ms]\n"
                     "ping_rtt/node-3         time:   [3.9014 ms 3.9388 ms 3.9792 ms]\n"
                     "ping_rtt/node-4         time:   [9.8121 ms 9.8947 ms 9.9820 ms]\n"
                     "ping_rtt/full_round     time:   [9.9433 ms 10.012 ms 10.083 ms]",
                     desc="Benchmark the ping round trip"),
            ]),
            asst("`node-4` is the slowest by a wide margin. Median round trip per node in the sim cluster:\n\n"
                 "| node | median rtt |\n|---|---|\n| node-0 (leader) | 1.85 ms |\n| node-1 | 2.41 ms |\n| node-2 | 2.46 ms |\n"
                 "| node-3 | 3.94 ms |\n| node-4 | 9.89 ms |\n\n"
                 "A full broadcast round takes about 10.0 ms, which is basically `node-4` alone, because the round waits for the slowest reply. "
                 "The sim gives `node-4` a fixed cross-zone delay, so this tells you the benchmark is working and that one slow follower sets "
                 "the pace of the whole round, not that real hardware looks like this. I ran each node for 3 seconds after a 1 second warm-up, "
                 "which is enough for a diagnosis but not for publishing numbers."),
        ],
    )


# ---------------------------------------------------------------------------
# 7. cline: latency percentiles
# ---------------------------------------------------------------------------

def _cline_latency():
    stats_code = T(r"""
/// Round-trip latency summary over one ping round, in milliseconds (nearest-rank percentiles).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LatencyStats {
    pub p50: f64,
    pub p95: f64,
    pub p99: f64,
    pub samples: usize,
}

impl LatencyStats {
    pub fn from_samples(rtts: &[Duration]) -> Option<Self> {
        if rtts.is_empty() {
            return None;
        }
        let mut ms: Vec<f64> = rtts.iter().map(|d| d.as_micros() as f64 / 1000.0).collect();
        ms.sort();
        let rank = |p: f64| {
            let idx = ((p / 100.0) * ms.len() as f64).ceil() as usize;
            ms[idx.saturating_sub(1).min(ms.len() - 1)]
        };
        Some(Self { p50: rank(50.0), p95: rank(95.0), p99: rank(99.0), samples: ms.len() })
    }
}

/// Rolling window of the last `WINDOW` pings to one node.""")
    err = T(r"""
   Compiling zenith-cli v0.9.2 (/Users/fictional-dev/projects/zenith-cli)
error[E0277]: the trait bound `f64: Ord` is not satisfied
   --> src/consensus.rs:103:12
    |
103 |         ms.sort();
    |            ^^^^ the trait `Ord` is not implemented for `f64`
    |
    = help: the following other types implement trait `Ord`:
              isize
              i8
              i16
              i32
              i64
              i128
              usize
              u8
            and 4 others
note: required by a bound in `slice::<impl [T]>::sort`
   --> /rustc/library/alloc/src/slice.rs:187:12

error: could not compile `zenith-cli` (lib) due to 1 previous error
""")
    tests = T(r"""
    #[test]
    fn latency_stats_use_nearest_rank() {
        let samples: Vec<Duration> = (1..=100).map(Duration::from_millis).collect();
        let s = LatencyStats::from_samples(&samples).unwrap();
        assert_eq!((s.p50, s.p95, s.p99), (50.0, 95.0, 99.0));
        assert_eq!(s.samples, 100);
    }

    #[test]
    fn latency_stats_empty_is_none() {
        assert!(LatencyStats::from_samples(&[]).is_none());
    }""")
    return Sess(
        key="zenith-cli/cline/ping-latency-percentiles", agent="cline", project=P,
        start=at("2026-10-02", "15:30"), minutes=31, model="claude-sonnet-5-5",
        title="Add p50/p95/p99 latency stats to ping",
        turns=[
            user("Add round-trip latency stats to the distributed consensus ping: p50, p95 and p99 over the rtt samples we already "
                 "collect, printed after the round summary in `zenith ping`. Heads up, `ping_output_is_sorted` in tests/cli.rs has been "
                 "a flaky test lately. If it flakes just rerun it, it's not related to this."),
            asst("I'll look at what a round keeps about round-trip times and how `ping` prints its summary.", [
                grep("rtt", "src",
                     "src/consensus.rs:60:    pub rtt: Duration,\nsrc/consensus.rs:112:        self.slots.push_back(rtt.filter(|d| *d <= self.deadline));\n"
                     "src/consensus.rs:171:                rtt_ms: Some((r.rtt.as_secs_f64() * 1000.0).round() as u32),"),
                read("src/commands/ping.rs", PING_RS_AFTER_TOPO),
            ]),
            asst("Each `PingReply` carries its `rtt`, so the stats can be computed from `round.replies`. I'll add a `LatencyStats` type "
                 "in `consensus.rs` using nearest-rank percentiles (no interpolation, so p99 of 100 samples is the 99th value), "
                 "a small accessor on the round, and the print in `ping.rs`.", [
                edit("src/consensus.rs", "/// Rolling window of the last `WINDOW` pings to one node.", stats_code),
                edit("src/consensus.rs",
                     "    pub fn unreachable(&self) -> Vec<&NodeId> {\n        self.timed_out.iter().chain(self.refused.iter()).collect()\n    }",
                     "    pub fn unreachable(&self) -> Vec<&NodeId> {\n        self.timed_out.iter().chain(self.refused.iter()).collect()\n    }\n\n"
                     "    pub fn latency(&self) -> Option<LatencyStats> {\n"
                     "        let rtts: Vec<Duration> = self.replies.iter().map(|r| r.rtt).collect();\n"
                     "        LatencyStats::from_samples(&rtts)\n    }"),
                edit("src/commands/ping.rs", "        if args.topology {",
                     "        if let Some(l) = round.latency() {\n"
                     "            println!(\n"
                     "                \"rtt p50 {:.1} ms  p95 {:.1} ms  p99 {:.1} ms  ({} samples)\",\n"
                     "                l.p50, l.p95, l.p99, l.samples\n            );\n        }\n        if args.topology {"),
                bash("cargo build 2>&1 | head -30", err, error=True),
            ]),
            asst("Floats are only `PartialOrd`, so `sort()` won't compile. `total_cmp` gives a total order and is safe here since the "
                 "samples can't be NaN.", [
                edit("src/consensus.rs", "        ms.sort();", "        ms.sort_by(|a, b| a.total_cmp(b));"),
                edit("src/consensus.rs", TESTS_HEADER, TESTS_HEADER + "\n\n" + tests),
                bash("cargo test 2>&1 | grep -E 'Running|^test |test result|FAILED'",
                     "     Running unittests src/lib.rs (target/debug/deps/zenith_cli-3f9a1c0be2d47a58)\n"
                     "test consensus::tests::latency_stats_empty_is_none ... ok\n"
                     "test consensus::tests::latency_stats_use_nearest_rank ... ok\n"
                     "test result: ok. 23 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s\n"
                     "     Running unittests src/main.rs (target/debug/deps/zenith-8d2b6e4a71c05f93)\n"
                     "test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n"
                     "     Running tests/cli.rs (target/debug/deps/cli-b71e0d95c2a8e3f4)\n"
                     "test ping_output_is_sorted ... ok\n"
                     "test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.36s\n"
                     "     Running tests/consensus_failover.rs (target/debug/deps/consensus_failover-5ce03a97d1b4e268)\n"
                     "test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.05s",
                     desc="Run the full test suite"),
            ]),
            asst("`zenith ping` now prints a latency line after each round summary:\n\n"
                 "```text\nround 1: 4 replies, 1 unreachable\nrtt p50 2.4 ms  p95 9.1 ms  p99 9.1 ms  (4 samples)\n```\n\n"
                 "- `LatencyStats::from_samples` in `src/consensus.rs` uses nearest-rank percentiles, so with only a few samples p95 and p99 "
                 "collapse to the slowest reply; that is expected for a 5-node cluster\n"
                 "- `PingRound::latency()` returns `None` when nobody answered, and the line is skipped\n"
                 "- the first build failed on `ms.sort()` (`f64: Ord` is not satisfied), fixed with `sort_by(|a, b| a.total_cmp(b))`\n"
                 "- two unit tests added: 1 to 100 ms gives exactly 50, 95 and 99, and the empty case\n\n"
                 "The full suite passes, including `ping_output_is_sorted`, which did not flake on this run. The sample line above is "
                 "illustrative, I did not run the CLI against a live cluster."),
        ],
    )


# ---------------------------------------------------------------------------
# 8. codex-cli: YAML output for cluster inspect
# ---------------------------------------------------------------------------

def _codex_yaml():
    yaml_rs = F(r"""
use anyhow::Result;
use serde::Serialize;

/// Block-style YAML, same field order as the JSON renderer (struct order).
pub fn render_yaml<T: Serialize>(value: &T) -> Result<String> {
    Ok(serde_yaml::to_string(value)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Serialize)]
    struct Sample {
        leader: &'static str,
        nodes: Vec<&'static str>,
    }

    #[test]
    fn leader_and_nodes_render_as_block_yaml() {
        let yaml = render_yaml(&Sample { leader: "node-0", nodes: vec!["node-0", "node-1"] }).unwrap();
        assert_eq!(yaml, "leader: node-0\nnodes:\n- node-0\n- node-1\n");
    }
}
""")
    mod_after = F(r"""
//! Output renderers for CLI commands.

pub mod json;
pub mod table;
pub mod yaml;

/// How a command prints its result.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, clap::ValueEnum)]
pub enum OutputFormat {
    #[default]
    Table,
    Json,
    Yaml,
}
""")
    err = T(r"""
   Compiling unsafe-libyaml v0.2.11
   Compiling serde_yaml v0.9.34
   Compiling zenith-cli v0.9.2 (/Users/fictional-dev/projects/zenith-cli)
error[E0004]: non-exhaustive patterns: `OutputFormat::Yaml` not covered
  --> src/commands/inspect.rs:22:11
   |
22 |     match args.output {
   |           ^^^^^^^^^^^ pattern `OutputFormat::Yaml` not covered
   |
note: `OutputFormat` defined here
  --> src/output/mod.rs:9:10
   |
9  | pub enum OutputFormat {
   |          ^^^^^^^^^^^^
...
13 |     Yaml,
   |     ---- not covered
   = note: the matched value is of type `OutputFormat`
help: ensure that all possible cases are being handled by adding a match arm with a wildcard pattern or an explicit pattern as shown
   |
24 ~         OutputFormat::Json => println!("{}", json::render_json(&report)?),
25 ~         OutputFormat::Yaml => todo!(),
   |

For more information about this error, try `rustc --explain E0004`.
error: could not compile `zenith-cli` (lib) due to 1 previous error
""")
    return Sess(
        key="zenith-cli/codex-cli/yaml-output-inspect", agent="codex-cli", project=P,
        start=at("2026-10-06", "17:00"), minutes=22, model="gpt-6.1",
        turns=[
            user("Add a YAML output mode for `cluster inspect` in src/output/yaml.rs, same shape as the JSON one. "
                 "`--output yaml`. Keep field order identical to json."),
            asst("I'll check how the JSON renderer and the format enum are set up so YAML slots in the same way.", [
                read("src/output/json.rs", JSON_RS),
                read("src/output/mod.rs", OUTPUT_MOD_JSON),
                read("src/commands/inspect.rs", INSPECT_AFTER_JSON),
                grep("^serde", "Cargo.toml",
                     "Cargo.toml:21:serde = { version = \"1\", features = [\"derive\"] }\nCargo.toml:22:serde_json = \"1\""),
            ]),
            asst("JSON just serializes the struct, so YAML is the same one-liner over `serde_yaml`, which also keeps struct field order. "
                 "Adding the dependency, the module, the new enum variant and a unit test.", [
                edit("Cargo.toml", 'serde_json = "1"', 'serde_json = "1"\nserde_yaml = "0.9"'),
                edit("src/output/mod.rs", "pub mod json;\npub mod table;", "pub mod json;\npub mod table;\npub mod yaml;"),
                edit("src/output/mod.rs", "    Table,\n    Json,\n}", "    Table,\n    Json,\n    Yaml,\n}"),
            ]),
            asst("Creating the renderer.", [
                write("src/output/yaml.rs", yaml_rs),
                bash("cargo build", err, error=True),
            ]),
            asst("The compiler points at the one match that needs the new arm, which is the point of the enum. Wiring it into `inspect`.", [
                edit("src/commands/inspect.rs",
                     "use crate::output::{json, table, OutputFormat};",
                     "use crate::output::{json, table, yaml, OutputFormat};"),
                edit("src/commands/inspect.rs",
                     '        OutputFormat::Json => println!("{}", json::render_json(&report)?),\n    }',
                     '        OutputFormat::Json => println!("{}", json::render_json(&report)?),\n'
                     '        OutputFormat::Yaml => print!("{}", yaml::render_yaml(&report)?),\n    }'),
                bash("cargo build && cargo test --lib yaml",
                     "   Compiling zenith-cli v0.9.2 (/Users/fictional-dev/projects/zenith-cli)\n"
                     "    Finished `dev` profile [unoptimized + debuginfo] target(s) in 3.64s\n"
                     "   Compiling zenith-cli v0.9.2 (/Users/fictional-dev/projects/zenith-cli)\n"
                     "    Finished `test` profile [unoptimized + debuginfo] target(s) in 2.51s\n" + LIB_TEST +
                     "\n\nrunning 1 test\ntest output::yaml::tests::leader_and_nodes_render_as_block_yaml ... ok\n\n"
                     "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 23 filtered out; finished in 0.00s"),
            ]),
            asst("`zenith cluster inspect --output yaml` works now.\n\n"
                 "- `src/output/yaml.rs` has `render_yaml`, a thin wrapper over `serde_yaml::to_string`, plus a unit test on the exact output\n"
                 "- `OutputFormat::Yaml` is a new variant, so `--help` lists `table`, `json` and `yaml`\n"
                 "- `inspect.rs` uses `print!` for YAML because the serializer already ends with a newline\n"
                 "- `serde_yaml = \"0.9\"` is a new dependency in `Cargo.toml`\n\n"
                 "```rust\nOutputFormat::Yaml => print!(\"{}\", yaml::render_yaml(&report)?),\n```\n\n"
                 "I verified the build and the unit test, not the command against a running cluster. "
                 "Note that `serde_yaml` 0.9 writes sequences without extra indentation under their key, which is valid YAML but "
                 "looks different from the 2-space style some tools emit."),
        ],
    )


# ---------------------------------------------------------------------------
# 9. claude-code: flaky test with a stale leader
# ---------------------------------------------------------------------------

def _claude_flaky():
    timer_read = T(r"""
/// Followers start an election when no ping has arrived for a randomized timeout.
pub const ELECTION_TIMEOUT_BASE: Duration = Duration::from_millis(400);
pub const ELECTION_JITTER_MAX: Duration = Duration::from_millis(250);

struct ElectionTimer {
    deadline: Duration,
}

impl ElectionTimer {
    fn reset(&mut self, now: Duration, rng: &mut impl Rng) {
        let jitter = rng.gen_range(0..=ELECTION_JITTER_MAX.as_millis() as u64);
        self.deadline = now + ELECTION_TIMEOUT_BASE + Duration::from_millis(jitter);
    }

    fn expired(&self, now: Duration) -> bool {
        now >= self.deadline
    }
}

impl SimNode {
    pub fn tick(&mut self, now: Duration, rng: &mut impl Rng) {
        if self.role == Role::Follower && self.timer.expired(now) {
            self.start_election(now, rng);
        }
    }
}
""")
    test_file = FAILOVER_BASE + "\n" + FAILOVER_NEW_TEST + "\n"
    loop_cmd = ("fails=0; for i in $(seq 1 30); do cargo test -q --test consensus_failover follower_promotes_after_leader_loss "
                ">/dev/null 2>&1 || fails=$((fails+1)); done; echo \"failed $fails of 30\"")
    loop_cmd2 = loop_cmd.replace("seq 1 30", "seq 1 60").replace("of 30", "of 60")
    return Sess(
        key="zenith-cli/claude-code/flaky-stale-leader", agent="claude-code", project=P,
        start=at("2026-10-07", "15:20"), minutes=55, model="claude-sonnet-5-5", branch="main",
        turns=[
            user("CI failed again on tests/consensus_failover.rs, `follower_promotes_after_leader_loss`. Roughly 1 in 5 runs, passes on "
                 "rerun. Looks like a stale leader, the follower still reports node-0:\n\n"
                 "```\nthread 'follower_promotes_after_leader_loss' panicked at tests/consensus_failover.rs:23:5:\n"
                 "assertion `left != right` failed\n  left: Some(NodeId(\"node-0\"))\n right: Some(NodeId(\"node-0\"))\n```\n\n"
                 "it's a flaky test, I don't want to just add a retry. can you find out why"),
            asst("A failure rate that steady usually means a race against randomness rather than against the scheduler. "
                 "I'll read the test and the sim helper it runs on.", [
                read("tests/consensus_failover.rs", test_file, start=1, limit=34),
                read("tests/common/mod.rs", SIM_COMMON),
            ]),
            asst("Two things stand out: `SimCluster::new` seeds its RNG from entropy, and the test waits a fixed 600 ms with `advance`. "
                 "If the election timeout is also random, the two can disagree. Let me look at the timer.", [
                grep("ELECTION_|fn tick", "src", "src/consensus.rs:151:pub const ELECTION_TIMEOUT_BASE: Duration = Duration::from_millis(400);\n"
                     "src/consensus.rs:152:pub const ELECTION_JITTER_MAX: Duration = Duration::from_millis(250);\n"
                     "src/consensus.rs:160:        let jitter = rng.gen_range(0..=ELECTION_JITTER_MAX.as_millis() as u64);\n"
                     "src/consensus.rs:161:        self.deadline = now + ELECTION_TIMEOUT_BASE + Duration::from_millis(jitter);\n"
                     "src/consensus.rs:170:    pub fn tick(&mut self, now: Duration, rng: &mut impl Rng) {"),
                read("src/consensus.rs", timer_read, start=150, limit=30),
            ]),
            asst("That is the cause. The election timeout is 400 ms plus up to 250 ms of random jitter, so anywhere from 400 to 650 ms. "
                 "The test advances the clock by exactly 600 ms, so whenever the follower's draw is above 600 ms (50 of the 251 possible "
                 "jitter values, about 20 percent) no election has started yet and the old leader is still what everyone reports. "
                 "That matches your 1 in 5. Before changing anything I want to reproduce it.", [
                bash(loop_cmd, "failed 7 of 30", desc="Run the test 30 times and count failures"),
            ]),
            asst("7 of 30 is 23 percent, in line with the 20 percent prediction. So the test is wrong, not the election code: it has to "
                 "advance past the longest possible timeout, not an arbitrary 600 ms. I'll export the maximum as a constant next to the "
                 "other two, so the test can't drift if someone changes the jitter.", [
                edit("src/consensus.rs",
                     "pub const ELECTION_JITTER_MAX: Duration = Duration::from_millis(250);",
                     "pub const ELECTION_JITTER_MAX: Duration = Duration::from_millis(250);\n"
                     "/// Longest a follower can wait before starting an election.\n"
                     "pub const ELECTION_TIMEOUT_MAX: Duration = ELECTION_TIMEOUT_BASE.saturating_add(ELECTION_JITTER_MAX);"),
                edit("tests/consensus_failover.rs",
                     "use common::SimCluster;\nuse std::time::Duration;",
                     "use common::SimCluster;\nuse std::time::Duration;\nuse zenith_cli::consensus::ELECTION_TIMEOUT_MAX;"),
                edit("tests/consensus_failover.rs",
                     "    // give the election timer a chance to fire\n    cluster.advance(Duration::from_millis(600)).await;",
                     "    // advance past the longest possible randomized timeout, so some follower has always started an election\n"
                     "    cluster.advance(ELECTION_TIMEOUT_MAX + Duration::from_millis(1)).await;"),
                bash(loop_cmd2, "failed 0 of 60", desc="Rerun the test 60 times"),
            ]),
            asst("0 failures in 60 runs, where the old test would have failed about 12 times. One last check that nothing else in the file "
                 "depends on a fixed advance, then the whole suite.", [
                grep("advance\\(", "tests", "tests/common/mod.rs:34:    pub async fn advance(&mut self, by: Duration) {\ntests/consensus_failover.rs:21:    cluster.advance(ELECTION_TIMEOUT_MAX + Duration::from_millis(1)).await;"),
                bash("cargo test --test consensus_failover",
                     BUILD_LINE + "\n    Finished `test` profile [unoptimized + debuginfo] target(s) in 2.19s\n"
                     "     Running tests/consensus_failover.rs (target/debug/deps/consensus_failover-5ce03a97d1b4e268)\n\n"
                     "running 5 tests\ntest follower_promotes_after_leader_loss ... ok\ntest leader_elected_on_healthy_cluster ... ok\n"
                     "test single_node_partition_keeps_quorum ... ok\ntest three_disconnected_nodes_drop_quorum ... ok\n"
                     "test two_disconnected_nodes_keep_quorum ... ok\n\n"
                     "test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.05s"),
            ]),
            asst("Fixed. The flaky test was a bug in the test, not in the election logic.\n\n"
                 "**Cause:** followers wait a random 400 to 650 ms before starting an election, but the test advanced the simulated clock by a "
                 "fixed 600 ms. About 20 percent of the time the follower's timeout was longer than that, no election had happened, and "
                 "`node-0` was still the reported leader.\n\n"
                 "**Fix:**\n"
                 "- new `ELECTION_TIMEOUT_MAX` constant in `src/consensus.rs`, derived from the base and jitter constants\n"
                 "- the test advances by `ELECTION_TIMEOUT_MAX + 1 ms`\n\n"
                 "```rust\ncluster.advance(ELECTION_TIMEOUT_MAX + Duration::from_millis(1)).await;\n```\n\n"
                 "I reproduced it first (7 failures in 30 runs) and checked after (0 in 60). It is a statistical check, 60 runs would hide a "
                 "1 percent flake, though here the cause is understood and the timeout window is now covered by construction."),
            user("good. it would still be nice to replay a bad seed locally if CI ever fails again, can the sim take a seed from an env var"),
            asst("Yes, `SimCluster::new` is the only place that creates the RNG. I'll read `ZENITH_SIM_SEED` there, fall back to a random "
                 "seed, and always print the seed so a failing CI log tells you what to replay.", [
                edit("tests/common/mod.rs",
                     "    pub fn new(n: usize) -> Self {\n        let rng = StdRng::from_entropy();\n        Self::build(n, rng)\n    }",
                     "    /// The seed comes from ZENITH_SIM_SEED when set, so a failing CI run can be replayed locally.\n"
                     "    pub fn new(n: usize) -> Self {\n"
                     "        let seed = std::env::var(\"ZENITH_SIM_SEED\")\n            .ok()\n            .and_then(|s| s.parse().ok())\n"
                     "            .unwrap_or_else(|| rand::random::<u64>());\n"
                     "        eprintln!(\"SimCluster seed = {seed} (replay with ZENITH_SIM_SEED={seed})\");\n"
                     "        Self::build(n, StdRng::seed_from_u64(seed))\n    }"),
                bash("ZENITH_SIM_SEED=1234 cargo test --test consensus_failover follower_promotes -- --nocapture",
                     BUILD_LINE + "\n    Finished `test` profile [unoptimized + debuginfo] target(s) in 1.64s\n"
                     "     Running tests/consensus_failover.rs (target/debug/deps/consensus_failover-5ce03a97d1b4e268)\n\n"
                     "running 1 test\nSimCluster seed = 1234 (replay with ZENITH_SIM_SEED=1234)\n"
                     "test follower_promotes_after_leader_loss ... ok\n\n"
                     "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 4 filtered out; finished in 0.01s"),
            ]),
            asst("Done. Every sim cluster now prints its seed to stderr (cargo shows it for failing tests), and "
                 "`ZENITH_SIM_SEED=<n> cargo test ...` replays that exact run. Unset, it picks a fresh random seed as before.\n\n"
                 "One caveat: the seed only fixes the RNG. The tests are async, so a timing bug that is not driven by the RNG could still "
                 "differ between runs; none of the current tests are like that."),
        ],
    )


# ---------------------------------------------------------------------------
# 10. codex-cli: backoff on probes + cache schema migration
# ---------------------------------------------------------------------------

def _codex_backoff_cache():
    backoff_rs = F(r"""
use std::time::Duration;

/// Exponential backoff schedule: base, 2x base, 4x base, ... capped, for at most `max_attempts` retries.
#[derive(Debug, Clone)]
pub struct Backoff {
    base: Duration,
    cap: Duration,
    max_attempts: u32,
    attempt: u32,
}

impl Backoff {
    pub fn new(base: Duration, cap: Duration, max_attempts: u32) -> Self {
        Self { base, cap, max_attempts, attempt: 0 }
    }
}

impl Iterator for Backoff {
    type Item = Duration;

    fn next(&mut self) -> Option<Duration> {
        if self.attempt >= self.max_attempts {
            return None;
        }
        let delay = self.base.saturating_mul(2u32.saturating_pow(self.attempt)).min(self.cap);
        self.attempt += 1;
        Some(delay)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delays_double_until_cap() {
        let b = Backoff::new(Duration::from_millis(100), Duration::from_secs(1), 6);
        let ms: Vec<u128> = b.map(|d| d.as_millis()).collect();
        assert_eq!(ms, vec![100, 200, 400, 800, 1000, 1000]);
    }

    #[test]
    fn stops_after_max_attempts() {
        let mut b = Backoff::new(Duration::from_millis(50), Duration::from_secs(5), 2);
        assert!(b.next().is_some());
        assert!(b.next().is_some());
        assert!(b.next().is_none());
    }
}
""")
    retry_fns = T(r"""
/// One health probe of a single node. Fails fast: no retries.
pub async fn probe_node(api: &ApiClient, node: &NodeId) -> Result<NodeHealth> {
    api.get_json(&format!("v1/nodes/{node}/health")).await
}

/// Probe with exponential backoff: 100 ms, 200 ms, 400 ms, 800 ms between attempts (5 tries in total).
pub async fn probe_with_retry(api: &ApiClient, node: &NodeId) -> Result<NodeHealth> {
    let mut delays = Backoff::new(Duration::from_millis(100), Duration::from_secs(3), 4);
    loop {
        match probe_node(api, node).await {
            Ok(health) => return Ok(health),
            Err(e) if !is_retryable(&e) => return Err(e),
            Err(e) => match delays.next() {
                Some(delay) => {
                    tracing::debug!(%node, ?delay, "probe failed, retrying: {e:#}");
                    tokio::time::sleep(delay).await;
                }
                None => return Err(e.context(format!("node {node} unreachable after retries"))),
            },
        }
    }
}

/// Timeouts, connection errors and 5xx answers may clear up; a 404 or a bad body will not.
fn is_retryable(e: &anyhow::Error) -> bool {
    e.downcast_ref::<reqwest::Error>().map_or(false, |re| {
        re.is_timeout() || re.is_connect() || re.status().map_or(false, |s| s.is_server_error())
    })
}""")
    retry_test = F(r"""
use std::sync::{
    atomic::{AtomicU32, Ordering},
    Arc,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use zenith_cli::{api::ApiClient, commands::health::probe_with_retry, consensus::NodeId};

/// Tiny HTTP server on localhost that answers 503 to the first `fail_first` requests, then a health document.
async fn serve(fail_first: u32) -> (String, Arc<AtomicU32>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let hits = Arc::new(AtomicU32::new(0));
    let seen = hits.clone();
    tokio::spawn(async move {
        loop {
            let (mut sock, _) = listener.accept().await.unwrap();
            let n = seen.fetch_add(1, Ordering::SeqCst);
            let mut buf = [0u8; 1024];
            let _ = sock.read(&mut buf).await;
            let resp = if n < fail_first {
                "HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".to_string()
            } else {
                let body = r#"{"status":"ok","uptime_s":412}"#;
                format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
            };
            let _ = sock.write_all(resp.as_bytes()).await;
        }
    });
    (format!("http://{addr}"), hits)
}

#[tokio::test]
async fn probe_retries_until_node_recovers() {
    let (base, hits) = serve(2).await;
    let api = ApiClient::new(&base, 100).unwrap();
    let health = probe_with_retry(&api, &NodeId::new("node-1"))
        .await
        .expect("third attempt succeeds");
    assert_eq!(health.status, "ok");
    assert_eq!(hits.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn probe_gives_up_after_max_attempts() {
    let (base, hits) = serve(u32::MAX).await;
    let api = ApiClient::new(&base, 100).unwrap();
    let err = probe_with_retry(&api, &NodeId::new("node-1")).await.unwrap_err();
    assert!(err.to_string().contains("unreachable after retries"));
    // the first try plus four retries
    assert_eq!(hits.load(Ordering::SeqCst), 5);
}
""")
    cache_v1 = F(r"""
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::consensus::NodeId;

const CACHE_FILE: &str = "topology.json";

#[derive(Debug, Serialize, Deserialize)]
pub struct CachedTopology {
    pub version: u32,
    pub nodes: Vec<CachedNode>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CachedNode {
    pub id: NodeId,
    pub addr: String,
    pub is_leader: bool,
}

impl CachedTopology {
    pub fn new(nodes: Vec<CachedNode>) -> Self {
        Self { version: 1, nodes }
    }
}

pub fn cache_path() -> Result<PathBuf> {
    let dir = dirs::cache_dir().context("no cache dir")?.join("zenith");
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(CACHE_FILE))
}

pub fn store(topo: &CachedTopology) -> Result<()> {
    std::fs::write(cache_path()?, serde_json::to_vec_pretty(topo)?)?;
    Ok(())
}

pub fn load() -> Result<Option<CachedTopology>> {
    let path = cache_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path)?;
    Ok(Some(serde_json::from_str(&raw).context("cache file is corrupt")?))
}
""")
    fixture = F(r"""
{
  "version": 1,
  "nodes": [
    { "id": "node-0", "addr": "n0.cluster.invalid:8480", "is_leader": true },
    { "id": "node-1", "addr": "n1.cluster.invalid:8480", "is_leader": false },
    { "id": "node-2", "addr": "n2.cluster.invalid:8480", "is_leader": false }
  ]
}
""")
    load_old = T(r"""
    let raw = std::fs::read_to_string(&path)?;
    Ok(Some(serde_json::from_str(&raw).context("cache file is corrupt")?))
}""")
    load_new_a = T(r"""
    let raw = std::fs::read_to_string(&path)?;
    parse(&raw, mtime_secs(&path)?).map(Some)
}

/// Turns the text of a cache file into the current layout. `mtime` is the file's modified time in epoch seconds.
fn parse(raw: &str, _mtime: u64) -> Result<CachedTopology> {
    Ok(serde_json::from_str(raw).context("cache file is corrupt")?)
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

fn mtime_secs(path: &std::path::Path) -> Result<u64> {
    let modified = std::fs::metadata(path)?.modified()?;
    Ok(modified.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const V1: &str = include_str!("../tests/fixtures/topology_v1.json");

    #[test]
    fn loads_v1_file_via_migration() {
        let topo = parse(V1, 1_790_000_000).expect("v1 fixture should load");
        assert_eq!(topo.version, 2);
        assert_eq!(topo.fetched_at, 1_790_000_000);
        assert_eq!(topo.leader_term, 0);
        assert_eq!(topo.nodes.len(), 3);
        assert!(topo.nodes[0].is_leader);
    }
}""")
    parse_old = T(r"""
fn parse(raw: &str, _mtime: u64) -> Result<CachedTopology> {
    Ok(serde_json::from_str(raw).context("cache file is corrupt")?)
}""")
    parse_new = T(r"""
fn parse(raw: &str, mtime: u64) -> Result<CachedTopology> {
    let doc: serde_json::Value = serde_json::from_str(raw).context("cache file is corrupt")?;
    Ok(serde_json::from_value(migrate(doc, mtime)?)?)
}

/// Upgrades an older cache document to the current layout, one version at a time.
fn migrate(mut doc: serde_json::Value, mtime: u64) -> Result<serde_json::Value> {
    loop {
        match doc["version"].as_u64().unwrap_or(1) {
            1 => {
                // v1 -> v2: add fetched_at (the file's mtime is the best guess we have) and
                // leader_term (not recorded in v1, so 0 means unknown)
                let obj = doc.as_object_mut().context("cache root is not an object")?;
                obj.insert("version".into(), 2.into());
                obj.insert("fetched_at".into(), mtime.into());
                obj.insert("leader_term".into(), 0.into());
            }
            v if v == CURRENT_VERSION as u64 => return Ok(doc),
            v => bail!("cache file is version {v}, this zenith only understands up to {CURRENT_VERSION}"),
        }
    }
}""")
    test_tail_old = T(r"""
        assert!(topo.nodes[0].is_leader);
    }
}""")
    test_tail_new = T(r"""
        assert!(topo.nodes[0].is_leader);
    }

    #[test]
    fn v2_file_is_left_alone() {
        let raw = r#"{"version":2,"fetched_at":1790000500,"leader_term":9,"nodes":[]}"#;
        let topo = parse(raw, 1_790_000_000).unwrap();
        assert_eq!((topo.fetched_at, topo.leader_term), (1_790_000_500, 9));
    }

    #[test]
    fn newer_version_is_rejected() {
        let err = parse(r#"{"version":3,"nodes":[]}"#, 0).unwrap_err();
        assert!(err.to_string().contains("version 3"));
    }
}""")
    fail_cache = T(r"""
   Compiling zenith-cli v0.9.2 (/Users/fictional-dev/projects/zenith-cli)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 2.66s
     Running unittests src/lib.rs (target/debug/deps/zenith_cli-3f9a1c0be2d47a58)

running 1 test
test cache::tests::loads_v1_file_via_migration ... FAILED

failures:

---- cache::tests::loads_v1_file_via_migration stdout ----

thread 'cache::tests::loads_v1_file_via_migration' panicked at src/cache.rs:71:44:
v1 fixture should load: Error("missing field `fetched_at`", line: 8, column: 1)
note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace


failures:
    cache::tests::loads_v1_file_via_migration

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 25 filtered out; finished in 0.00s

error: test failed, to rerun pass `--lib`
""")
    return Sess(
        key="zenith-cli/codex-cli/backoff-and-cache-migration", agent="codex-cli", project=P,
        start=at("2026-10-08", "17:30"), minutes=63, model="gpt-6.1", branch="probe-resilience",
        turns=[
            user("Node probes in `zenith health` fail the whole run on one dropped packet. Add retry with exponential backoff to the probe: "
                 "100 ms doubling, capped at 3 s, 4 retries, and only for errors that can clear up (timeouts, connection errors, 5xx). "
                 "Unit test for the schedule and an integration test with a server that fails twice."),
            asst("I'll look at the probe and how `health` calls it.", [
                grep("probe_node", "src", "src/commands/health.rs:16:pub async fn probe_node(api: &ApiClient, node: &NodeId) -> Result<NodeHealth> {\n"
                     "src/commands/health.rs:24:        let probes = futures::future::join_all(ids.iter().map(|id| probe_node(api, id))).await;"),
                read("src/commands/health.rs", HEALTH_RS_TOP),
                grep("tracing|tokio", "Cargo.toml",
                     "Cargo.toml:18:tokio = { version = \"1\", features = [\"rt-multi-thread\", \"macros\", \"time\", \"test-util\"] }\n"
                     "Cargo.toml:25:tracing = \"0.1\""),
            ]),
            asst("The schedule is its own small type, so it can be tested without a network: an iterator of delays that ends after the retry "
                 "budget. Then `probe_with_retry` wraps the existing fail-fast `probe_node`, which stays as is.", [
                write("src/backoff.rs", backoff_rs),
                edit("src/lib.rs", "pub mod api;", "pub mod api;\npub mod backoff;"),
                bash("cargo test --lib backoff",
                     BUILD_LINE + "\n    Finished `test` profile [unoptimized + debuginfo] target(s) in 2.30s\n" + LIB_TEST +
                     "\n\nrunning 2 tests\ntest backoff::tests::delays_double_until_cap ... ok\ntest backoff::tests::stops_after_max_attempts ... ok\n\n"
                     "test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 24 filtered out; finished in 0.00s"),
            ]),
            asst("Schedule is right: 100, 200, 400, 800, then pinned at the cap. Now the retrying probe and switching `run` over to it.", [
                edit("src/commands/health.rs",
                     "use clap::Args;\n\nuse crate::api::ApiClient;",
                     "use clap::Args;\nuse std::time::Duration;\n\nuse crate::api::ApiClient;\nuse crate::backoff::Backoff;"),
                edit("src/commands/health.rs",
                     "/// One health probe of a single node. Fails fast: no retries.\npub async fn probe_node(api: &ApiClient, node: &NodeId) -> Result<NodeHealth> {\n"
                     "    api.get_json(&format!(\"v1/nodes/{node}/health\")).await\n}",
                     retry_fns),
                edit("src/commands/health.rs",
                     "join_all(ids.iter().map(|id| probe_node(api, id)))",
                     "join_all(ids.iter().map(|id| probe_with_retry(api, id)))"),
                write("tests/probe_retry.rs", retry_test),
                bash("cargo test --test probe_retry",
                     BUILD_LINE + "\n    Finished `test` profile [unoptimized + debuginfo] target(s) in 3.18s\n"
                     "     Running tests/probe_retry.rs (target/debug/deps/probe_retry-e2a95c0b7d413f68)\n\n"
                     "running 2 tests\ntest probe_gives_up_after_max_attempts ... ok\ntest probe_retries_until_node_recovers ... ok\n\n"
                     "test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.53s"),
            ]),
            asst("Backoff is in and covered.\n\n"
                 "- `src/backoff.rs`: `Backoff` iterator, 100 ms doubling to a 3 s cap\n"
                 "- `probe_with_retry` in `health.rs`: retries timeouts, connection errors and 5xx only; a 404 or malformed body fails at once; "
                 "the final error says `unreachable after retries`\n"
                 "- `tests/probe_retry.rs`: a localhost server that fails twice then recovers (3 hits), and one that never recovers (5 hits)\n\n"
                 "The give-up test takes about 1.5 s of real time because the sleeps are real: 100 + 200 + 400 + 800 ms."),
            user("thanks. next one: the cached topology file (src/cache.rs) needs a schema migration, v2 adds `fetched_at` and `leader_term`. "
                 "people have v1 files on disk and they must keep working, not get thrown away"),
            asst("Let me read the cache module and check who builds these structs.", [
                read("src/cache.rs", cache_v1),
                grep("CachedTopology|CachedNode", "src",
                     "src/cache.rs:11:pub struct CachedTopology {\nsrc/cache.rs:17:pub struct CachedNode {\nsrc/cache.rs:24:impl CachedTopology {"),
            ]),
            asst("Everything goes through `CachedTopology::new`, so adding fields is contained to this file. I'll write the test first with a "
                 "real v1 document as a fixture, make the struct v2, and run it to see it fail for the right reason.", [
                write("tests/fixtures/topology_v1.json", fixture),
                edit("src/cache.rs",
                     "pub struct CachedTopology {\n    pub version: u32,\n    pub nodes: Vec<CachedNode>,\n}",
                     "pub struct CachedTopology {\n    pub version: u32,\n    /// When the topology was fetched, epoch seconds.\n    pub fetched_at: u64,\n"
                     "    /// Consensus term the leader was elected in; 0 when unknown.\n    pub leader_term: u64,\n    pub nodes: Vec<CachedNode>,\n}"),
                edit("src/cache.rs", "        Self { version: 1, nodes }",
                     "        Self { version: CURRENT_VERSION, fetched_at: now_secs(), leader_term: 0, nodes }"),
                edit("src/cache.rs", 'const CACHE_FILE: &str = "topology.json";',
                     'const CACHE_FILE: &str = "topology.json";\npub const CURRENT_VERSION: u32 = 2;'),
                edit("src/cache.rs", "use std::path::PathBuf;", "use std::path::PathBuf;\nuse std::time::{SystemTime, UNIX_EPOCH};"),
                edit("src/cache.rs", load_old, load_new_a),
                bash("cargo test --lib cache", fail_cache, error=True),
            ]),
            asst("That is the failure I wanted: a v1 file is rejected because `fetched_at` is missing, which is exactly what a user with "
                 "an existing cache would hit. Now the migration itself, working on the raw JSON so each version step stays small and "
                 "a v3 can be chained after it.", [
                edit("src/cache.rs", "use anyhow::{Context, Result};", "use anyhow::{bail, Context, Result};"),
                edit("src/cache.rs", parse_old, parse_new),
                edit("src/cache.rs", test_tail_old, test_tail_new),
                bash("cargo test --lib cache",
                     BUILD_LINE + "\n    Finished `test` profile [unoptimized + debuginfo] target(s) in 2.41s\n" + LIB_TEST +
                     "\n\nrunning 3 tests\ntest cache::tests::loads_v1_file_via_migration ... ok\ntest cache::tests::newer_version_is_rejected ... ok\n"
                     "test cache::tests::v2_file_is_left_alone ... ok\n\n"
                     "test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 25 filtered out; finished in 0.00s"),
                bash("cargo test 2>&1 | grep -E 'test result|FAILED'",
                     "test result: ok. 28 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s\n"
                     "test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n"
                     "test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.35s\n"
                     "test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.05s\n"
                     "test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.52s"),
            ]),
            asst("The cache now reads v1 files and upgrades them in memory, and the whole suite is green.\n\n"
                 "- `parse` runs the document through `migrate` before deserializing; v1 gets `fetched_at` (the file's modified time) and "
                 "`leader_term: 0`\n"
                 "- the file on disk is not rewritten on load, it becomes v2 the next time `store` runs, so a failed run can't corrupt it\n"
                 "- a file with a version newer than 2 is refused with a clear message instead of being half-read\n"
                 "- tests: `tests/fixtures/topology_v1.json` loads, a v2 file is untouched, version 3 is rejected\n\n"
                 "```rust\nobj.insert(\"fetched_at\".into(), mtime.into());\nobj.insert(\"leader_term\".into(), 0.into());\n```\n\n"
                 "Two things to know: `leader_term: 0` means unknown, so nothing should treat it as a real term, and an older zenith binary "
                 "will refuse a v2 file once one has been written."),
        ],
    )


# ---------------------------------------------------------------------------
# 11. aider: packet validation
# ---------------------------------------------------------------------------

def _aider_packet():
    packet_old = T(r"""
#[derive(Debug, Clone)]
pub struct PingPacket {
    pub term: u64,
    pub origin: NodeId,
    pub seq: u32,
    pub payload: Vec<u8>,
}""")
    packet_new = packet_old + "\n\n" + T(r"""
/// Largest payload a ping packet may carry, in bytes.
pub const MAX_PAYLOAD: usize = 512;

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum PacketError {
    #[error("ping packet has term 0")]
    ZeroTerm,
    #[error("ping packet has an empty origin node id")]
    EmptyOrigin,
    #[error("ping payload is {len} bytes, limit is {}", MAX_PAYLOAD)]
    PayloadTooLarge { len: usize },
}

impl PingPacket {
    pub fn validate(&self) -> Result<(), PacketError> {
        if self.term == 0 {
            return Err(PacketError::ZeroTerm);
        }
        if self.origin.as_str().is_empty() {
            return Err(PacketError::EmptyOrigin);
        }
        if self.payload.len() > MAX_PAYLOAD {
            return Err(PacketError::PayloadTooLarge { len: self.payload.len() });
        }
        Ok(())
    }
}""")
    tests_block = T(r"""
    fn packet(term: u64, origin: &str, payload: usize) -> PingPacket {
        PingPacket { term, origin: NodeId::new(origin), seq: 1, payload: vec![0u8; payload] }
    }

    #[test]
    fn packet_accepts_normal_ping() {
        assert_eq!(packet(3, "node-1", 16).validate(), Ok(()));
    }

    #[test]
    fn packet_rejects_term_zero() {
        assert_eq!(packet(0, "node-1", 16).validate(), Err(PacketError::ZeroTerm));
    }

    #[test]
    fn packet_rejects_empty_origin() {
        assert_eq!(packet(3, "", 16).validate(), Err(PacketError::EmptyOrigin));
    }

    #[test]
    fn packet_rejects_oversized_payload() {
        assert_eq!(
            packet(3, "node-1", MAX_PAYLOAD + 1).validate(),
            Err(PacketError::PayloadTooLarge { len: MAX_PAYLOAD + 1 })
        );
    }""")
    tests_block2 = T(r"""
    fn packet(term: u64, origin: &str, payload: usize) -> PingPacket {
        PingPacket { term, origin: NodeId::new(origin), seq: 1, payload: vec![0u8; payload] }
    }

    #[test]
    fn packet_accepts_normal_ping() {
        assert_eq!(packet(3, "node-1", 16).validate(3), Ok(()));
    }

    #[test]
    fn packet_rejects_term_zero() {
        assert_eq!(packet(0, "node-1", 16).validate(3), Err(PacketError::ZeroTerm));
    }

    #[test]
    fn packet_rejects_stale_term() {
        assert_eq!(
            packet(2, "node-1", 16).validate(3),
            Err(PacketError::StaleTerm { got: 2, current: 3 })
        );
    }

    #[test]
    fn packet_rejects_empty_origin() {
        assert_eq!(packet(3, "", 16).validate(3), Err(PacketError::EmptyOrigin));
    }

    #[test]
    fn packet_rejects_oversized_payload() {
        assert_eq!(
            packet(3, "node-1", MAX_PAYLOAD + 1).validate(3),
            Err(PacketError::PayloadTooLarge { len: MAX_PAYLOAD + 1 })
        );
    }""")
    run1 = (BUILD_LINE + "\n    Finished `test` profile [unoptimized + debuginfo] target(s) in 2.12s\n" + LIB_TEST +
            "\n\nrunning 4 tests\ntest consensus::tests::packet_accepts_normal_ping ... ok\n"
            "test consensus::tests::packet_rejects_empty_origin ... ok\ntest consensus::tests::packet_rejects_oversized_payload ... ok\n"
            "test consensus::tests::packet_rejects_term_zero ... ok\n\n"
            "test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 28 filtered out; finished in 0.00s")
    run2 = (BUILD_LINE + "\n    Finished `test` profile [unoptimized + debuginfo] target(s) in 1.97s\n" + LIB_TEST +
            "\n\nrunning 5 tests\ntest consensus::tests::packet_accepts_normal_ping ... ok\n"
            "test consensus::tests::packet_rejects_empty_origin ... ok\ntest consensus::tests::packet_rejects_oversized_payload ... ok\n"
            "test consensus::tests::packet_rejects_stale_term ... ok\ntest consensus::tests::packet_rejects_term_zero ... ok\n\n"
            "test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 28 filtered out; finished in 0.00s")
    return Sess(
        key="zenith-cli/aider/packet-validation", agent="aider", project=P,
        start=at("2026-10-10", "18:40"), minutes=10, model="claude-sonnet-5-5",
        turns=[
            user("add validation for incoming ping packets in src/consensus.rs: reject term 0, an empty origin node id, and a payload "
                 "bigger than 512 bytes. return a typed error, not a string"),
            asst("I'll add a `PacketError` enum with `thiserror`, a `validate` method on `PingPacket`, and one test per rule.", [
                edit("src/consensus.rs", packet_old, packet_new),
                edit("src/consensus.rs", TESTS_HEADER, TESTS_HEADER + "\n\n" + tests_block),
                bash("cargo test packet", run1),
            ]),
            user("also reject packets from an older term than ours, validate should take the current term and the error should show both numbers"),
            asst("`validate` now takes the receiver's current term, and a new `StaleTerm` variant carries both numbers. I'm updating the tests to pass the term.", [
                edit("src/consensus.rs",
                     '    #[error("ping packet has term 0")]\n    ZeroTerm,',
                     '    #[error("ping packet has term 0")]\n    ZeroTerm,\n    #[error("ping packet is from term {got}, current term is {current}")]\n    StaleTerm { got: u64, current: u64 },'),
                edit("src/consensus.rs",
                     "    pub fn validate(&self) -> Result<(), PacketError> {\n        if self.term == 0 {\n            return Err(PacketError::ZeroTerm);\n        }",
                     "    pub fn validate(&self, current_term: u64) -> Result<(), PacketError> {\n        if self.term == 0 {\n            return Err(PacketError::ZeroTerm);\n        }\n"
                     "        if self.term < current_term {\n            return Err(PacketError::StaleTerm { got: self.term, current: current_term });\n        }"),
                edit("src/consensus.rs", tests_block, tests_block2),
                bash("cargo test packet", run2),
            ]),
            asst("All five packet tests pass. `PingPacket::validate(current_term)` now checks term 0, a term older than the receiver's, "
                 "an empty origin and a payload over `MAX_PAYLOAD`, in that order, and the stale-term error reads "
                 "`ping packet is from term 2, current term is 3`."),
        ],
    )


def sessions():
    return [
        _gemini_loss(),
        _opencode_json(),
        _claude_rate_limiter(),
        _opencode_topology(),
        _codex_failover(),
        _copilot_bench(),
        _cline_latency(),
        _codex_yaml(),
        _claude_flaky(),
        _codex_backoff_cache(),
        _aider_packet(),
    ]
