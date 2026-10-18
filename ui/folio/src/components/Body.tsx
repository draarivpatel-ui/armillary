import { keys, type FindState, EMPTY_FIND } from "../find";
import { parseMarkdown } from "../markdown";
import { renderBlocks } from "../markdown/render";

/** Markdown body text with find marks applied to the same text pieces the finder indexed. */
export function Body({
  text,
  blockIndex,
  find = EMPTY_FIND,
  className,
}: {
  text: string;
  blockIndex: number;
  find?: FindState;
  className?: string;
}) {
  return (
    <div className={className}>
      {renderBlocks(parseMarkdown(text), { keyPrefix: keys.unitPrefix(blockIndex), find })}
    </div>
  );
}
