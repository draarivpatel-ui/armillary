import { useId, type KeyboardEvent } from "react";
import type { TocEntry } from "./blockify";

export interface ContentsRailProps {
  entries: TocEntry[];
  currentBlock: number;
  onJump: (entry: TocEntry) => void;
}

/** Table of contents. Arrow keys walk it, Home and End jump to the ends, Enter or Space opens the section. */
export function ContentsRail({ entries, currentBlock, onJump }: ContentsRailProps) {
  const listId = useId();
  const links = entries.map((entry) => `${listId}-${entry.blockIndex}-${entry.level}-${entry.label}`);

  const focusAt = (index: number) => {
    const element = document.getElementById(links[index]);
    element?.focus();
  };

  // the first entry of the current section, or the last one behind it when the reader scrolled past
  const exact = entries.findIndex((entry) => entry.blockIndex === currentBlock);
  const currentEntry =
    exact === -1
      ? entries.reduce((best, entry, index) => (entry.blockIndex <= currentBlock ? index : best), -1)
      : exact;

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const activeIndex = links.findIndex((id) => document.getElementById(id) === document.activeElement);
    if (activeIndex === -1) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusAt(Math.min(entries.length - 1, activeIndex + 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        focusAt(Math.max(0, activeIndex - 1));
        break;
      case "Home":
        event.preventDefault();
        focusAt(0);
        break;
      case "End":
        event.preventDefault();
        focusAt(entries.length - 1);
        break;
      case "Enter":
      case " ":
      case "Spacebar":
        event.preventDefault();
        onJump(entries[activeIndex]);
        break;
    }
  };

  return (
    <nav className="folio-rail" aria-label="Session contents" onKeyDown={onKeyDown}>
      <h2 className="folio-rail__label">Contents</h2>
      <ul className="folio-toc__list" role="list">
        {entries.map((entry, index) => (
          <li key={`${entry.id}-${index}`} role="listitem" className="folio-toc__item">
            <a
              id={links[index]}
              className={entry.level === 1 ? "folio-toc__link" : "folio-toc__link folio-toc__link--minor"}
              href={`#${entry.id}`}
              aria-current={index === currentEntry ? "true" : undefined}
              onClick={(event) => {
                event.preventDefault();
                onJump(entry);
              }}
            >
              {entry.label}
            </a>
          </li>
        ))}
      </ul>
      <p className="folio-rail__hint">Use the up and down arrows to move through the contents, Enter to open.</p>
    </nav>
  );
}
