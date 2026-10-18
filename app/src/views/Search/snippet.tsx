import { Fragment, type ReactNode } from "react";
import { highlightSegments } from "../../api/archive";

/**
 * A search hit arrives from the core as plain text plus highlight ranges ([start, end) in UTF-16 code
 * units, i.e. JavaScript string indices). The archive's FTS5 snippet markers are private-use sentinels
 * that the core strips, so no markup ever crosses the API: everything in `text` is untrusted message
 * content and is rendered only as React text nodes, with hits inside <mark> elements whose only child
 * is text. A literal "<mark>" typed in a message is shown as the visible text it is.
 */

export interface SnippetSegment {
  text: string;
  marked: boolean;
}

export type HighlightRange = readonly [number, number];

/** Flat list of marked and unmarked pieces; any ranges (unsorted, overlapping, out of range) are safe. */
export function snippetSegments(text: string, highlights: ReadonlyArray<HighlightRange>): SnippetSegment[] {
  return highlightSegments(text, highlights).map((s) => ({ text: s.text, marked: s.hit }));
}

/** Renders a hit as text nodes and <mark> elements whose only child is text. */
export function Snippet({ text, highlights }: { text: string; highlights: ReadonlyArray<HighlightRange> }): ReactNode {
  return snippetSegments(text, highlights).map((segment, index) =>
    segment.marked ? <mark key={index}>{segment.text}</mark> : <Fragment key={index}>{segment.text}</Fragment>,
  );
}
