import type { CSSProperties } from "react";
import type { FolioBlock, MarginalNote } from "../blockify";
import { decorate, keys, type FindState } from "../find";
import { Body } from "./Body";
import { Marginalia } from "./Marginalia";

function PromptBlock({ block, find }: { block: FolioBlock; find: FindState }) {
  return (
    <div className="folio-prompt" data-block-kind="prompt" id={block.id}>
      <h2 className="folio-prompt__title">{decorate(keys.title(block.index), block.title ?? "", find)}</h2>
      <Body text={block.bodyText} blockIndex={block.index} find={find} className="folio-prompt__body" />
    </div>
  );
}

function ReplyBlock({ block, find, isError }: { block: FolioBlock; find: FindState; isError: boolean }) {
  return (
    <div
      className={isError ? "folio-reply folio-reply--error" : "folio-reply"}
      data-block-kind="reply"
      data-error={isError ? "true" : "false"}
      id={block.id}
    >
      <Body text={block.bodyText} blockIndex={block.index} find={find} />
    </div>
  );
}

function SystemBlock({ block, find }: { block: FolioBlock; find: FindState }) {
  return (
    <div className="folio-system" data-block-kind="system" id={block.id}>
      <Body text={block.bodyText} blockIndex={block.index} find={find} />
    </div>
  );
}

/** One message: the document body on the left, its marginal notes on the right. */
export function Row({
  block,
  notes,
  find,
  current = false,
  style,
  rowRef,
  diffDefaultOpen = false,
  interactiveDiffs = true,
  sidenotes = false,
}: {
  block: FolioBlock;
  notes: MarginalNote[];
  find: FindState;
  current?: boolean;
  style?: CSSProperties;
  rowRef?: (node: HTMLElement | null) => void;
  diffDefaultOpen?: boolean;
  interactiveDiffs?: boolean;
  /** Live reader: the notes sit beside the message without adding height, short and expandable. */
  sidenotes?: boolean;
}) {
  return (
    <div
      ref={rowRef}
      id={`row-${block.index}`}
      className={`folio-row${style ? " folio-row--floating" : ""}${sidenotes ? " folio-row--sidenotes" : ""}${current ? " folio-row--current" : ""}`}
      data-message-index={block.index}
      data-seq={block.seq}
      data-block-kind={block.kind}
      data-current={current ? "true" : "false"}
      style={style}
    >
      <div className="folio-body">
        {block.kind === "prompt" ? (
          <PromptBlock block={block} find={find} />
        ) : block.kind === "system" ? (
          <SystemBlock block={block} find={find} />
        ) : (
          <ReplyBlock block={block} find={find} isError={block.isError} />
        )}
      </div>
      <div className="folio-margin">
        {notes.map((note) => (
          <Marginalia
            key={note.id}
            note={note}
            find={find}
            diffDefaultOpen={diffDefaultOpen}
            interactiveDiffs={interactiveDiffs}
            compact={sidenotes}
          />
        ))}
      </div>
    </div>
  );
}
