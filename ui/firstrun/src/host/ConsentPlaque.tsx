import React, { useEffect, useId, useRef } from "react";
import type { FirstRunPlan } from "../events";

export interface ConsentPlaqueProps {
  plan: FirstRunPlan | null;
  interactive: boolean;
  onContinue: () => void;
  onDecline: () => void;
  /** Positioned imperatively every frame by the host (offset and swing). */
  rigRef: React.RefObject<HTMLDivElement | null>;
}

const READS = [
  "Session histories your agents already keep",
  "Agent settings, rules and MCP config files",
  "Which agents are installed (it checks for their apps and commands)",
  "Running agent processes, for the live Orrery",
];

const NEVER = [
  "Opens credential files, keys or tokens",
  "Changes your agents' files without asking",
  "Sends anything off this machine",
];

const FAMILY_ORDER = ["anthropic", "openai", "google", "github-microsoft", "cursor", "open-source-clis", "chinese-labs", "other"];

/** Home folders first, then absolute ones, then environment overrides ($CODEX_HOME and the like). */
function folderRank(f: string): number {
  return f.startsWith("~") ? 0 : f.startsWith("/") ? 1 : 2;
}

function machine(platform: FirstRunPlan["platform"] | undefined): string {
  return platform === "macos" ? "this Mac" : "this computer";
}

export const ConsentPlaque: React.FC<ConsentPlaqueProps> = ({ plan, interactive, onContinue, onDecline, rigRef }) => {
  const titleId = useId();
  const ledeId = useId();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const continueRef = useRef<HTMLButtonElement | null>(null);
  const interactiveSince = useRef<number | null>(null);

  useEffect(() => {
    if (interactive) {
      interactiveSince.current = performance.now();
      continueRef.current?.focus({ preventScroll: true });
    }
  }, [interactive]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!interactive) return;
    if (e.key === "Tab") {
      // Keep focus inside the plaque.
      const focusables = Array.from(cardRef.current?.querySelectorAll<HTMLElement>("button, summary, [tabindex='0']") ?? []).filter((el) => el.offsetParent !== null || el.tagName === "SUMMARY");
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      // A held Escape from skipping the intro must not also decline.
      if (interactiveSince.current !== null && performance.now() - interactiveSince.current > 400) onDecline();
    } else if (e.key === "Enter" && !(document.activeElement instanceof HTMLButtonElement)) {
      e.preventDefault();
      onContinue();
    }
  };

  const where = machine(plan?.platform);
  const agents = plan?.entries.length ?? 0;
  // Agents that keep a folder on this OS, the big families first (no popularity is claimed: the
  // order is the SPEC's family order, then agents with a history adapter, then by name).
  const withFolders = (plan?.entries ?? [])
    .filter((e) => e.folders.length > 0)
    .map((e) => ({ ...e, folders: e.folders.slice().sort((a, b) => folderRank(a) - folderRank(b) || a.localeCompare(b)) }))
    .slice()
    .sort((a, b) => FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family) || Number(b.history) - Number(a.history) || a.name.localeCompare(b.name));
  const featured = withFolders.slice(0, 6);
  const os = plan?.platform === "macos" ? "macOS" : plan?.platform === "windows" ? "Windows" : "Linux";

  return (
    <div className="fr-plaque-layer" aria-hidden={!interactive}>
      <div className="fr-plaque-rig" ref={rigRef}>
        <div className="fr-chain fr-chain--left" aria-hidden="true" />
        <div className="fr-chain fr-chain--right" aria-hidden="true" />
        <div
          className="fr-plaque"
          ref={cardRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={ledeId}
          onKeyDown={onKeyDown}
        >
          <span className="fr-eyelet fr-eyelet--left" aria-hidden="true" />
          <span className="fr-eyelet fr-eyelet--right" aria-hidden="true" />
          <div className="fr-plaque__inner">
            <p className="fr-plaque__eyebrow">Before the first observation</p>
            <h2 className="fr-plaque__title" id={titleId}>
              What Armillary reads
            </h2>
            <p className="fr-plaque__lede" id={ledeId}>
              Armillary gathers the history your AI agents already keep into one private archive on {where}. Nothing is
              scanned until you continue, and nothing leaves {where}.
            </p>
            <div className="fr-plaque__lists">
              <section aria-label="Armillary reads">
                <h3 className="fr-plaque__head fr-plaque__head--reads">Reads</h3>
                <ul>
                  {READS.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </section>
              <section aria-label="Armillary never">
                <h3 className="fr-plaque__head fr-plaque__head--never">Never</h3>
                <ul>
                  {NEVER.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </section>
            </div>
            <div className="fr-plaque__folders">
              <h3 className="fr-plaque__head fr-plaque__head--where">Where it looks</h3>
              <p className="fr-plaque__folders-head">
                Only in the folders each agent keeps on {where}, as listed in Armillary's catalogue of {agents} agents. For example:
              </p>
              <dl className="fr-plaque__agents">
                {featured.map((e) => (
                  <div key={e.id} className="fr-plaque__agent">
                    <dt>{e.name}</dt>
                    <dd>
                      <code>{e.folders[0]}</code>
                      {e.folders.length > 1 && <span className="fr-plaque__more"> and {e.folders.length - 1} more</span>}
                    </dd>
                  </div>
                ))}
              </dl>
              {withFolders.length > featured.length && (
                <details className="fr-plaque__all">
                  <summary>Show the folders of all {withFolders.length} agents that keep data on {os}</summary>
                  <div className="fr-plaque__all-list" tabIndex={0} aria-label={`Folders for ${withFolders.length} agents`}>
                    {withFolders.map((e) => (
                      <div key={e.id} className="fr-plaque__agent">
                        <dt>{e.name}</dt>
                        <dd>
                          {e.folders.map((f) => (
                            <code key={f}>{f}</code>
                          ))}
                        </dd>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
            <p className="fr-plaque__note">
              Not now stops reading: the live detector and any import about to start stop immediately; a file already being read finishes and nothing new is read. Sessions already imported stay in the archive until you delete it.
            </p>
            <div className="fr-plaque__actions">
              <button type="button" data-firstrun-action="decline" className="fr-btn fr-btn--quiet" onClick={() => interactive && onDecline()} disabled={!interactive}>
                Not now
              </button>
              <button type="button" data-firstrun-action="continue" className="fr-btn fr-btn--gilt" ref={continueRef} onClick={() => interactive && onContinue()} disabled={!interactive}>
                Continue
              </button>
            </div>
            <p className="fr-plaque__keys" aria-hidden="true">
              <kbd>Enter</kbd> continue <span className="fr-dot">&middot;</span> <kbd>Esc</kbd> not now
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
