import React from "react";
import { AgentGlyph, Button } from "@orrery/design";
import { appNow } from "../../api/client";
import { useDisplayPath } from "../../api/paths";
import { RecentLaunch } from "./types";

interface RecentLaunchesProps {
  launches: RecentLaunch[];
  onSelectLaunch: (launch: RecentLaunch) => void;
  onClearLaunches?: () => void;
}

const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? "" : "s"} ago`;

/** "3 days ago", measured from appNow() (never the wall clock directly). Older than 30 days shows the date. */
export function timeAgo(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return plural(hours, "hour");
  const days = Math.floor(hours / 24);
  if (days <= 30) return plural(days, "day");
  return new Date(timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export const RecentLaunches: React.FC<RecentLaunchesProps> = ({ launches, onSelectLaunch, onClearLaunches }) => {
  const now = appNow();
  const displayPath = useDisplayPath();

  return (
    <section className="launchpad-recent" data-testid="recent-launches-section" aria-labelledby="launchpad-recent-title">
      <div className="launchpad-section-head">
        <h3 id="launchpad-recent-title" className="launchpad-section-title">
          Recent launches
        </h3>
        {launches.length > 0 && onClearLaunches && (
          <Button size="sm" variant="ghost" onClick={onClearLaunches}>
            Clear
          </Button>
        )}
      </div>

      {launches.length === 0 ? (
        <p className="launchpad-recent__empty" data-testid="recent-launches-list">
          Nothing launched from here yet.
        </p>
      ) : (
        <ul className="launchpad-recent__list" data-testid="recent-launches-list">
          {launches.map((item) => (
            <li key={item.id} className="launchpad-recent__row">
              <button
                type="button"
                className="recent-launch"
                data-testid="recent-launch-item"
                onClick={() => onSelectLaunch(item)}
              >
                <span className="recent-launch__glyph" style={{ color: `var(--family-${item.family})` }}>
                  <AgentGlyph family={item.family} size={16} />
                </span>
                <span className="recent-launch__agent">{item.agentName}</span>
                <span className="recent-launch__project">{displayPath(item.projectFolder)}</span>
                <span className="recent-launch__time">{timeAgo(item.timestamp, now)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
