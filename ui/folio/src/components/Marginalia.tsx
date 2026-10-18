import { useCallback, useContext, useLayoutEffect, useRef, useState } from "react";
import { decorate, EMPTY_FIND, keys, type FindState } from "../find";
import type { MarginalNote } from "../blockify";
import { Checklist } from "../markdown/render";
import { DiffView } from "./DiffView";
import { SidenoteLayoutContext } from "./sidenotes";

/** How much of a compact note shows before the toggle: files, plan items. */
const FILES_SHOWN = 3;
const PLAN_SHOWN = 5;

export function NoteText({
  unitKey,
  value,
  className,
  find = EMPTY_FIND,
}: {
  unitKey: string;
  value: string;
  className?: string;
  find?: FindState;
}) {
  return <span className={className}>{decorate(unitKey, value, find)}</span>;
}

/** True when a search hit sits in a part of the note that a compact note keeps folded away. */
function hasHiddenHit(note: MarginalNote, find: FindState, textOverflows: boolean): boolean {
  if (find.byUnit.size === 0) return false;
  const name = note.id;
  const has = (key: string) => find.byUnit.has(key);
  if (textOverflows && (has(keys.note(name, note.seq, "input")) || has(keys.note(name, note.seq, "result")) || has(keys.note(name, note.seq, "error")))) {
    return true;
  }
  for (let index = FILES_SHOWN; index < note.files.length; index++) {
    if (has(keys.note(name, note.seq, "file", `-${index}`))) return true;
  }
  const planItems = note.plan?.items.length ?? 0;
  for (let index = PLAN_SHOWN; index < planItems; index++) {
    if (has(keys.note(name, note.seq, "plan", `-${index}`))) return true;
  }
  return false;
}

/** A tool call, file edit or error sitting in the margin beside the message it happened under. */
export function Marginalia({
  note,
  find = EMPTY_FIND,
  diffDefaultOpen = false,
  interactiveDiffs = true,
  compact = false,
}: {
  note: MarginalNote;
  find?: FindState;
  /** Static renderings (exports) show the diff body and need no toggle. */
  diffDefaultOpen?: boolean;
  interactiveDiffs?: boolean;
  /** The live reader keeps a note short (four lines, three files, five plan items) behind a quiet "more". */
  compact?: boolean;
}) {
  const name = note.id;
  const requestLayout = useContext(SidenoteLayoutContext);
  const textRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  // The text only counts as overflowing when the clamp really cuts it; measured with the clamp on, so an
  // open note keeps its toggle.
  const measure = useCallback(() => {
    const node = textRef.current;
    if (!node) {
      setOverflowing(false);
      return;
    }
    const wasOpen = node.classList.contains("folio-note__text--open");
    if (wasOpen) node.classList.remove("folio-note__text--open");
    const cut = node.scrollHeight > node.clientHeight + 1;
    if (wasOpen) node.classList.add("folio-note__text--open");
    setOverflowing((previous) => (previous === cut ? previous : cut));
  }, []);

  useLayoutEffect(() => {
    if (compact) measure();
  }, [compact, measure, note.input, note.result, note.error]);

  useLayoutEffect(() => {
    if (!compact) return;
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    const watcher = typeof ResizeObserver === "undefined" || !textRef.current ? null : new ResizeObserver(onResize);
    if (watcher && textRef.current) watcher.observe(textRef.current);
    void document.fonts?.ready?.then(onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      watcher?.disconnect();
    };
  }, [compact, measure]);

  const hiddenFiles = compact ? Math.max(0, note.files.length - FILES_SHOWN) : 0;
  const hiddenPlan = compact && note.plan ? Math.max(0, note.plan.items.length - PLAN_SHOWN) : 0;
  const hidden = hiddenFiles + hiddenPlan;
  const canToggle = compact && (overflowing || hidden > 0);
  // a search hit in the folded part opens the note so the reader can see the mark
  const open = !compact || expanded || hasHiddenHit(note, find, overflowing);

  // a note that grows or shrinks moves the notes below it
  useLayoutEffect(() => {
    if (compact) requestLayout();
  }, [compact, open, overflowing, requestLayout]);

  const lines = (
    <>
      {note.input && (
        <p className="folio-note__line">
          <NoteText unitKey={keys.note(name, note.seq, "input")} value={note.input} find={find} />
        </p>
      )}
      {note.result && (
        <p className="folio-note__line">
          <NoteText unitKey={keys.note(name, note.seq, "result")} value={note.result} find={find} />
        </p>
      )}
      {note.error && (
        <p className="folio-note__line">
          <NoteText unitKey={keys.note(name, note.seq, "error")} value={note.error} find={find} />
        </p>
      )}
    </>
  );
  const files = open ? note.files : note.files.slice(0, FILES_SHOWN);
  const planItems = note.plan ? (open ? note.plan.items : note.plan.items.slice(0, PLAN_SHOWN)) : [];

  return (
    <div
      className={note.isError ? "folio-note folio-note--error" : "folio-note"}
      data-marginalia="true"
      data-anchor-seq={note.anchorSeq ?? ""}
      data-tool={note.tool}
      data-error={note.isError ? "true" : "false"}
      data-note-kind={note.kind}
    >
      <NoteText unitKey={keys.note(name, note.seq, "tool")} value={note.tool} className="folio-note__tool" find={find} />
      {note.isError && <span className="folio-note__flag">needs attention</span>}
      {compact ? (
        (note.input || note.result || note.error) && (
          <div ref={textRef} className={open ? "folio-note__text folio-note__text--open" : "folio-note__text"}>
            {lines}
          </div>
        )
      ) : (
        lines
      )}
      {files.length > 0 && (
        <ul className="folio-note__files">
          {files.map((file, index) => (
            <li key={index}>
              <NoteText
                unitKey={keys.note(name, note.seq, "file", `-${index}`)}
                value={file}
                find={find}
              />
            </li>
          ))}
        </ul>
      )}
      {note.plan && (
        <Checklist
          items={planItems}
          label="Plan"
          blockKey={keys.note(name, note.seq, "plan")}
          find={find}
        />
      )}
      {canToggle && (
        <button
          type="button"
          className="folio-note__more"
          aria-expanded={open}
          onClick={() => setExpanded(!open)}
        >
          {/* the accessible name is the visible word plus a hidden verb and the tool, so it always contains what is shown */}
          <span className="folio-visually-hidden">Show </span>
          {open ? "less" : hidden > 0 ? `+${hidden} more` : "more"}
          <span className="folio-visually-hidden">{` of ${note.tool}`}</span>
        </button>
      )}
      {note.edits.map((edit, index) => (
        <DiffView
          key={index}
          edit={edit}
          seq={note.seq}
          editIndex={index}
          find={find}
          defaultOpen={diffDefaultOpen}
          interactive={interactiveDiffs}
        />
      ))}
    </div>
  );
}
