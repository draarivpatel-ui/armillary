//! The builtin adapter registry.
//!
//! One TOML per known agent lives in `src/builtins/` and is compiled into the
//! binary with `include_str!`, so detection works before any user adapter is
//! installed. `package` records which work package owns the entry: P3 shipped
//! the two adapters that also parse history, A6 shipped the detection-only
//! registry (SPEC 5 coverage level "detect").

use crate::adapter_spec::AdapterDef;

#[derive(Debug, Clone, Copy)]
pub struct Builtin {
    pub id: &'static str,
    /// Work package that authored the entry: "P3" or "A6".
    pub package: &'static str,
    pub toml: &'static str,
}

impl Builtin {
    pub fn parse(&self) -> AdapterDef {
        AdapterDef::from_toml(self.toml)
            .unwrap_or_else(|e| panic!("builtin {} does not parse: {}", self.id, e))
    }
}

pub const BUILTINS: &[Builtin] = &[
    // History-capable adapters (package P3).
    Builtin {
        id: "claude-code",
        package: "P3",
        toml: include_str!("builtins/claude-code.toml"),
    },
    Builtin {
        id: "codex-cli",
        package: "P3",
        toml: include_str!("builtins/codex-cli.toml"),
    },
    // Detection-only registry (package A6), alphabetical.
    Builtin {
        id: "agent-code",
        package: "A6",
        toml: include_str!("builtins/agent-code.toml"),
    },
    Builtin {
        id: "amazon-q",
        package: "A6",
        toml: include_str!("builtins/amazon-q.toml"),
    },
    Builtin {
        id: "antigravity-ide",
        package: "A6",
        toml: include_str!("builtins/antigravity-ide.toml"),
    },
    Builtin {
        id: "augment-ide",
        package: "A6",
        toml: include_str!("builtins/augment-ide.toml"),
    },
    Builtin {
        id: "autogpt",
        package: "A6",
        toml: include_str!("builtins/autogpt.toml"),
    },
    Builtin {
        id: "bolt-diy",
        package: "A6",
        toml: include_str!("builtins/bolt-diy.toml"),
    },
    Builtin {
        id: "chatgpt-desktop",
        package: "A6",
        toml: include_str!("builtins/chatgpt-desktop.toml"),
    },
    Builtin {
        id: "claude-desktop",
        package: "A6",
        toml: include_str!("builtins/claude-desktop.toml"),
    },
    Builtin {
        id: "claude-squad",
        package: "A6",
        toml: include_str!("builtins/claude-squad.toml"),
    },
    Builtin {
        id: "codex-desktop",
        package: "A6",
        toml: include_str!("builtins/codex-desktop.toml"),
    },
    Builtin {
        id: "cosine-genie",
        package: "A6",
        toml: include_str!("builtins/cosine-genie.toml"),
    },
    Builtin {
        id: "cursor-ide",
        package: "A6",
        toml: include_str!("builtins/cursor-ide.toml"),
    },
    Builtin {
        id: "deepseek-cli",
        package: "A6",
        toml: include_str!("builtins/deepseek-cli.toml"),
    },
    Builtin {
        id: "devin",
        package: "A6",
        toml: include_str!("builtins/devin.toml"),
    },
    Builtin {
        id: "gocode",
        package: "A6",
        toml: include_str!("builtins/gocode.toml"),
    },
    Builtin {
        id: "happy",
        package: "A6",
        toml: include_str!("builtins/happy.toml"),
    },
    Builtin {
        id: "hermes-desktop",
        package: "A6",
        toml: include_str!("builtins/hermes-desktop.toml"),
    },
    Builtin {
        id: "jan",
        package: "A6",
        toml: include_str!("builtins/jan.toml"),
    },
    Builtin {
        id: "jetbrains-ai-assistant",
        package: "A6",
        toml: include_str!("builtins/jetbrains-ai-assistant.toml"),
    },
    Builtin {
        id: "jules",
        package: "A6",
        toml: include_str!("builtins/jules.toml"),
    },
    Builtin {
        id: "junie",
        package: "A6",
        toml: include_str!("builtins/junie.toml"),
    },
    Builtin {
        id: "kiro-cli",
        package: "A6",
        toml: include_str!("builtins/kiro-cli.toml"),
    },
    Builtin {
        id: "kiro-ide",
        package: "A6",
        toml: include_str!("builtins/kiro-ide.toml"),
    },
    Builtin {
        id: "koda",
        package: "A6",
        toml: include_str!("builtins/koda.toml"),
    },
    Builtin {
        id: "lm-studio",
        package: "A6",
        toml: include_str!("builtins/lm-studio.toml"),
    },
    Builtin {
        id: "lovable-desktop",
        package: "A6",
        toml: include_str!("builtins/lovable-desktop.toml"),
    },
    Builtin {
        id: "mentat",
        package: "A6",
        toml: include_str!("builtins/mentat.toml"),
    },
    Builtin {
        id: "metagpt",
        package: "A6",
        toml: include_str!("builtins/metagpt.toml"),
    },
    Builtin {
        id: "nca",
        package: "A6",
        toml: include_str!("builtins/nca.toml"),
    },
    Builtin {
        id: "omnara",
        package: "A6",
        toml: include_str!("builtins/omnara.toml"),
    },
    Builtin {
        id: "pearai",
        package: "A6",
        toml: include_str!("builtins/pearai.toml"),
    },
    Builtin {
        id: "pi-go",
        package: "A6",
        toml: include_str!("builtins/pi-go.toml"),
    },
    Builtin {
        id: "poolside",
        package: "A6",
        toml: include_str!("builtins/poolside.toml"),
    },
    Builtin {
        id: "raycast",
        package: "A6",
        toml: include_str!("builtins/raycast.toml"),
    },
    Builtin {
        id: "refact",
        package: "A6",
        toml: include_str!("builtins/refact.toml"),
    },
    Builtin {
        id: "replit-desktop",
        package: "A6",
        toml: include_str!("builtins/replit-desktop.toml"),
    },
    Builtin {
        id: "sculptor",
        package: "A6",
        toml: include_str!("builtins/sculptor.toml"),
    },
    Builtin {
        id: "swe-agent",
        package: "A6",
        toml: include_str!("builtins/swe-agent.toml"),
    },
    Builtin {
        id: "sweep",
        package: "A6",
        toml: include_str!("builtins/sweep.toml"),
    },
    Builtin {
        id: "tabby",
        package: "A6",
        toml: include_str!("builtins/tabby.toml"),
    },
    Builtin {
        id: "tabnine",
        package: "A6",
        toml: include_str!("builtins/tabnine.toml"),
    },
    Builtin {
        id: "terragon",
        package: "A6",
        toml: include_str!("builtins/terragon.toml"),
    },
    Builtin {
        id: "trae-agent",
        package: "A6",
        toml: include_str!("builtins/trae-agent.toml"),
    },
    Builtin {
        id: "trae-ide",
        package: "A6",
        toml: include_str!("builtins/trae-ide.toml"),
    },
    Builtin {
        id: "vibe-kanban",
        package: "A6",
        toml: include_str!("builtins/vibe-kanban.toml"),
    },
    Builtin {
        id: "void-editor",
        package: "A6",
        toml: include_str!("builtins/void-editor.toml"),
    },
    Builtin {
        id: "vscode-copilot",
        package: "A6",
        toml: include_str!("builtins/vscode-copilot.toml"),
    },
    Builtin {
        id: "warp",
        package: "A6",
        toml: include_str!("builtins/warp.toml"),
    },
    Builtin {
        id: "windsurf",
        package: "A6",
        toml: include_str!("builtins/windsurf.toml"),
    },
    Builtin {
        id: "zed",
        package: "A6",
        toml: include_str!("builtins/zed.toml"),
    },
    Builtin {
        id: "zero",
        package: "A6",
        toml: include_str!("builtins/zero.toml"),
    },
    // Adapters from package A1.
    Builtin {
        id: "crush",
        package: "A1",
        toml: include_str!("builtins/crush.toml"),
    },
    Builtin {
        id: "gemini-cli",
        package: "A1",
        toml: include_str!("builtins/gemini-cli.toml"),
    },
    Builtin {
        id: "github-copilot-cli",
        package: "A1",
        toml: include_str!("builtins/github-copilot-cli.toml"),
    },
    Builtin {
        id: "opencode",
        package: "A1",
        toml: include_str!("builtins/opencode.toml"),
    },
    Builtin {
        id: "qwen-code",
        package: "A1",
        toml: include_str!("builtins/qwen-code.toml"),
    },
    // Adapters from package A2.
    Builtin {
        id: "aider",
        package: "A2",
        toml: include_str!("builtins/aider.toml"),
    },
    Builtin {
        id: "amp",
        package: "A2",
        toml: include_str!("builtins/amp.toml"),
    },
    Builtin {
        id: "goose",
        package: "A2",
        toml: include_str!("builtins/goose.toml"),
    },
    Builtin {
        id: "kimi-code-cli",
        package: "A2",
        toml: include_str!("builtins/kimi-code-cli.toml"),
    },
    Builtin {
        id: "qoder-cli",
        package: "A2",
        toml: include_str!("builtins/qoder-cli.toml"),
    },
    // Adapters from package A3.
    Builtin {
        id: "antigravity-cli",
        package: "A3",
        toml: include_str!("builtins/antigravity-cli.toml"),
    },
    Builtin {
        id: "augment-auggie-cli",
        package: "A3",
        toml: include_str!("builtins/augment-auggie-cli.toml"),
    },
    Builtin {
        id: "cursor-cli",
        package: "A3",
        toml: include_str!("builtins/cursor-cli.toml"),
    },
    Builtin {
        id: "factory-droid",
        package: "A3",
        toml: include_str!("builtins/factory-droid.toml"),
    },
    Builtin {
        id: "hermes-agent-cli",
        package: "A3",
        toml: include_str!("builtins/hermes-agent-cli.toml"),
    },
    // Adapters from package A5.
    Builtin {
        id: "cline",
        package: "A5",
        toml: include_str!("builtins/cline.toml"),
    },
    Builtin {
        id: "continue",
        package: "A5",
        toml: include_str!("builtins/continue.toml"),
    },
    Builtin {
        id: "kilo-code",
        package: "A5",
        toml: include_str!("builtins/kilo-code.toml"),
    },
    Builtin {
        id: "roo-code",
        package: "A5",
        toml: include_str!("builtins/roo-code.toml"),
    },
    // Adapters from package A4.
    Builtin {
        id: "gptme",
        package: "A4",
        toml: include_str!("builtins/gptme.toml"),
    },
    Builtin {
        id: "grok-build-cli",
        package: "A4",
        toml: include_str!("builtins/grok-build-cli.toml"),
    },
    Builtin {
        id: "iflow-cli",
        package: "A4",
        toml: include_str!("builtins/iflow-cli.toml"),
    },
    Builtin {
        id: "letta-code",
        package: "A4",
        toml: include_str!("builtins/letta-code.toml"),
    },
    Builtin {
        id: "mistral-vibe-cli",
        package: "A4",
        toml: include_str!("builtins/mistral-vibe-cli.toml"),
    },
    Builtin {
        id: "open-interpreter",
        package: "A4",
        toml: include_str!("builtins/open-interpreter.toml"),
    },
    Builtin {
        id: "openhands-cli",
        package: "A4",
        toml: include_str!("builtins/openhands-cli.toml"),
    },
    Builtin {
        id: "plandex",
        package: "A4",
        toml: include_str!("builtins/plandex.toml"),
    },
];

/// All builtins, parsed. Panics on a malformed builtin: these ship with the
/// binary, so a parse failure is a build bug rather than a runtime condition.
pub fn builtin_adapters() -> Vec<AdapterDef> {
    BUILTINS.iter().map(Builtin::parse).collect()
}

pub fn builtin_toml(id: &str) -> Option<&'static str> {
    BUILTINS.iter().find(|b| b.id == id).map(|b| b.toml)
}

/// One builtin adapter by id, parsed.
pub fn get_builtin_adapter(id: &str) -> Option<AdapterDef> {
    BUILTINS.iter().find(|b| b.id == id).map(Builtin::parse)
}

/// Detection-only entries contributed by package A6.
pub fn a6_adapters() -> Vec<AdapterDef> {
    BUILTINS
        .iter()
        .filter(|b| b.package == "A6")
        .map(Builtin::parse)
        .collect()
}
