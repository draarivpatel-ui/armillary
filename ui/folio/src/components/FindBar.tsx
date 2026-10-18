import { type KeyboardEvent } from "react";

function Chevron({ up }: { up?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={up ? "M7 14l5-5 5 5" : "M7 10l5 5 5-5"} />
    </svg>
  );
}

function Cross() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
    </svg>
  );
}

export interface FindBarProps {
  query: string;
  shown: number;
  total: number;
  onQuery: (value: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  onClear: () => void;
}

/** Find in session. Enter walks forward, Shift Enter backwards, Escape clears. */
export function FindBar({ query, shown, total, onQuery, onNext, onPrevious, onClear }: FindBarProps) {
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) onPrevious();
      else onNext();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClear();
    }
  };

  return (
    <div className="folio-find">
      <input
        className="folio-find__input"
        type="text"
        aria-label="Find in session"
        placeholder="Find in session"
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        className="folio-button folio-button--icon"
        aria-label="Previous match"
        title="Previous match (Shift Enter)"
        onClick={onPrevious}
        disabled={total === 0}
      >
        <Chevron up />
      </button>
      <button
        type="button"
        className="folio-button folio-button--icon"
        aria-label="Next match"
        title="Next match (Enter)"
        onClick={onNext}
        disabled={total === 0}
      >
        <Chevron />
      </button>
      <button
        type="button"
        className="folio-button folio-button--icon"
        aria-label="Clear find"
        title="Clear (Escape)"
        onClick={onClear}
        disabled={query === ""}
      >
        <Cross />
      </button>
      <output className="folio-status" role="status" aria-label="Matches">
        {`${shown} of ${total}`}
      </output>
    </div>
  );
}
