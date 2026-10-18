import type { DiffLine } from "../diff";
import { decorate, type FindState, EMPTY_FIND } from "../find";
import type { NoteEdit } from "../blockify";
import { useContext, useLayoutEffect, useState } from "react";
import { SidenoteLayoutContext } from "./sidenotes";

function displayText(line: DiffLine): { prefix: string; body: string } {
  switch (line.kind) {
    case "add":
      return { prefix: "+", body: line.text };
    case "del":
      return { prefix: "-", body: line.text };
    case "hunk":
    case "header":
      return { prefix: "", body: line.text };
    case "ctx":
      return { prefix: " ", body: line.text };
  }
}

export function DiffBody({
  edit,
  seq,
  editIndex,
  find = EMPTY_FIND,
  scroll = false,
}: {
  edit: NoteEdit;
  seq: number;
  editIndex: number;
  find?: FindState;
  /** An open diff in the live reader is capped at about sixteen lines and scrolls inside itself. */
  scroll?: boolean;
}) {
  const scrollProps = scroll
    ? {
        role: "group" as const,
        tabIndex: 0,
        "aria-label": `Diff for ${edit.path.split("/").pop() ?? edit.path}`,
      }
    : {};
  return (
    <pre
      className={scroll ? "folio-diff__body folio-diff__body--scroll" : "folio-diff__body"}
      data-diff-for={edit.path}
      {...scrollProps}
    >
      {edit.lines.map((line, index) => {
        const key = `d-${seq}-${editIndex}-${index}`;
        const shown = displayText(line);
        return (
          <span key={index} className={`diff-line diff-line--${line.kind}`} data-diff-kind={line.kind}>
            {shown.prefix && <span className="diff-line__sign">{shown.prefix}</span>}
            {decorate(key, shown.body, find)}
          </span>
        );
      })}
    </pre>
  );
}

/** One file edit with a collapsed unified diff the reader can open. */
export function DiffView({
  edit,
  seq,
  editIndex,
  find = EMPTY_FIND,
  defaultOpen = false,
  interactive = true,
}: {
  edit: NoteEdit;
  seq: number;
  editIndex: number;
  find?: FindState;
  defaultOpen?: boolean;
  interactive?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultOpen);
  // a search hit inside a collapsed diff opens it so the reader can see the mark
  const searched = edit.lines.some(
    (_, index) => find.byUnit.size > 0 && find.byUnit.has(`d-${seq}-${editIndex}-${index}`),
  );
  const open = interactive ? expanded || searched : true;
  const requestLayout = useContext(SidenoteLayoutContext);
  // opening or closing a diff changes the height of its note group
  useLayoutEffect(() => {
    if (interactive) requestLayout();
  }, [interactive, open, requestLayout]);
  const file = edit.path.split("/").pop() ?? edit.path;
  const bodyId = `diff-body-${seq}-${editIndex}`;
  return (
    <div className="folio-diff" data-edit={edit.path}>
      {interactive ? (
        <button
          type="button"
          className="folio-diff__path"
          data-folio-diff-toggle={edit.path}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setExpanded((value) => !value)}
        >
          <span className="folio-visually-hidden">{`${open ? "Hide" : "Show"} diff for `}</span>
          <span className="folio-diff__file">{file}</span>{" "}
          <span className="folio-diff__counts">
            <span className="folio-diff__add">{`+${edit.additions}`}</span>{" "}
            <span className="folio-diff__del">{`-${edit.deletions}`}</span>
          </span>
        </button>
      ) : (
        <div className="folio-diff__path">
          <span className="folio-diff__file">{`diff for ${file}`}</span>
          <span className="folio-diff__counts">
            <span className="folio-diff__add">{` +${edit.additions}`}</span>{" "}
            <span className="folio-diff__del">{`-${edit.deletions}`}</span>
          </span>
        </div>
      )}
      {open && (
        <div id={bodyId}>
          <DiffBody edit={edit} seq={seq} editIndex={editIndex} find={find} scroll={interactive} />
        </div>
      )}
    </div>
  );
}
