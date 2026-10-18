import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { buildBlocks, type MarginalNote, type TocEntry } from "./blockify";
import { ContentsRail } from "./ContentsRail";
import { Row } from "./components/Row";
import { FindBar } from "./components/FindBar";
import { layoutSidenotes, NARROW_QUERY, SidenoteLayoutContext } from "./components/sidenotes";
import { useVirtualList } from "./virtual/useVirtualList";
import { buildFind } from "./find";
import {
  exportHtml,
  exportMarkdown,
  formatDuration,
  modelLabel,
  titleLabel,
  tokensLabel,
  type ExportFormat,
  type ExportResult,
} from "./export";
import { injectFolioCss } from "./styles/stylesheet";
import type { Message, Session, Theme, ToolCall } from "./types";

/** A small engraved leaf with a down stroke: export. */
function ExportGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M7 3.5h7l4 4V20.5H7z" />
      <path d="M12 10v6.5M9.25 13.75L12 16.5l2.75-2.75" />
    </svg>
  );
}

/**
 * Export (Markdown or HTML, with the Redact pass) is off in 0.1.0: the app has no save path yet, so
 * the buttons wrote no file (R2-REV-2). The code stays; a build with VITE_ARMILLARY_EXPORT=1 turns it
 * back on once saving is wired up.
 */
const EXPORT_BUILD_FLAG =
  (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_ARMILLARY_EXPORT === "1";

export interface FolioProps {
  session: Session;
  messages: Message[];
  toolCalls: ToolCall[];
  theme?: Theme;
  /** Show the notes column. */
  marginalia?: boolean;
  showContents?: boolean;
  virtualize?: boolean | "auto";
  /** Inline height of the scroll area. */
  height?: number;
  itemEstimateHeight?: number;
  overscan?: number;
  /** Used when the container has no layout yet (server render, jsdom). */
  defaultViewportHeight?: number;
  /** Sessions longer than this many blocks window themselves when virtualize is "auto". */
  autoThreshold?: number;
  onExport?: (result: ExportResult) => void;
  /** Show the Export controls. Defaults to the build flag, which is off for 0.1.0. */
  exportEnabled?: boolean;
  /** Message seq to bring into view: the last row whose seq is at or before it (the first row if none). */
  anchorSeq?: number | null;
  /** A small-caps line above the title (the app shows "Folio" there, like every view's eyebrow). */
  eyebrow?: string;
}

export function Folio(props: FolioProps) {
  const {
    session,
    messages,
    toolCalls,
    theme = "dark",
    marginalia = true,
    showContents = true,
    virtualize = "auto",
    height,
    itemEstimateHeight = 120,
    overscan = 5,
    defaultViewportHeight = 800,
    autoThreshold = 150,
  } = props;

  const plan = useMemo(() => buildBlocks(messages, toolCalls), [messages, toolCalls]);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [currentBlock, setCurrentBlock] = useState(0);
  const [exportNote, setExportNote] = useState("nothing exported yet");
  const [redactExport, setRedactExport] = useState(true);
  const find = useMemo(() => buildFind(plan, query, active), [plan, query, active]);

  const enabled = virtualize === true || (virtualize === "auto" && plan.blocks.length > autoThreshold);
  const list = useVirtualList({
    count: plan.blocks.length,
    estimate: itemEstimateHeight,
    overscan,
    fallbackViewport: defaultViewportHeight,
    enabled,
  });

  const notesByAnchor = useMemo(() => {
    const map = new Map<number, MarginalNote[]>();
    for (const note of plan.marginalia) {
      if (note.anchorIndex === null) continue;
      const bucket = map.get(note.anchorIndex) ?? [];
      bucket.push(note);
      map.set(note.anchorIndex, bucket);
    }
    return map;
  }, [plan.marginalia]);

  const scrollToBlock = useCallback(
    (blockIndex: number) => {
      setCurrentBlock(blockIndex);
      if (enabled) {
        list.scrollToIndex(blockIndex);
        return;
      }
      const node = document.getElementById(`row-${blockIndex}`);
      if (node?.scrollIntoView) node.scrollIntoView({ block: "start" });
    },
    [enabled, list],
  );

  // layout effect, so the stylesheet is in before the first note-stacking pass reads any geometry
  useLayoutEffect(() => {
    injectFolioCss();
  }, []);

  // Notes sit beside their message without adding to its row, so a layout pass stacks them.
  const pageRef = useRef<HTMLElement | null>(null);
  const relayout = useCallback(() => {
    if (pageRef.current) layoutSidenotes(pageRef.current);
  }, []);

  // Only a new anchor moves the view; live content updates must not yank the reader back.
  const { anchorSeq } = props;
  const latest = useRef({ plan, scrollToBlock });
  latest.current = { plan, scrollToBlock };
  useEffect(() => {
    const { plan: current, scrollToBlock: scroll } = latest.current;
    if (anchorSeq === undefined || anchorSeq === null || current.blocks.length === 0) return;
    let target = current.blocks[0];
    for (const block of current.blocks) {
      if (block.seq <= anchorSeq) target = block;
      else break;
    }
    scroll(target.index);
  }, [anchorSeq]);

  const jumpToMatch = (index: number) => {
    const total = find.matches.length;
    if (total === 0) {
      setActive(-1);
      return;
    }
    const wrapped = ((index % total) + total) % total;
    setActive(wrapped);
    scrollToBlock(find.matches[wrapped].blockIndex);
  };

  const onQuery = (value: string) => {
    setQuery(value);
    const next = buildFind(plan, value, 0);
    setActive(next.matches.length > 0 ? 0 : -1);
    if (next.matches.length > 0) scrollToBlock(next.matches[0].blockIndex);
  };

  const normalized = { session, messages, toolCalls };
  const doExport = (format: ExportFormat) => {
    const contents =
      format === "markdown"
        ? exportMarkdown(normalized, { redact: redactExport })
        : exportHtml(normalized, { redact: redactExport, theme });
    const name = `${session.id}.${format === "markdown" ? "md" : "html"}`;
    setExportNote(`${name} written as ${format}, ${redactExport ? "redacted" : "unredacted"}`);
    props.onExport?.({ format, name, contents, redacted: redactExport });
  };

  const total = find.matches.length;
  const shown = active >= 0 && total > 0 ? active + 1 : 0;

  const visible = enabled ? plan.blocks.slice(list.first, list.last) : plan.blocks;

  // content, search, window, theme and the notes column switch all change what sits where
  useLayoutEffect(() => {
    relayout();
  }, [relayout, plan, find, visible.length, list.first, list.last, theme, marginalia, enabled, notesByAnchor]);

  // container resize, the narrow breakpoint, and web fonts arriving change line breaks and so heights
  useEffect(() => {
    const onResize = () => relayout();
    window.addEventListener("resize", onResize);
    const page = pageRef.current;
    const watcher = typeof ResizeObserver === "undefined" || !page ? null : new ResizeObserver(onResize);
    if (watcher && page) {
      watcher.observe(page);
      const scroller = page.closest(".folio-scroll");
      if (scroller) watcher.observe(scroller);
    }
    const query = typeof window.matchMedia === "function" ? window.matchMedia(NARROW_QUERY) : null;
    query?.addEventListener?.("change", onResize);
    let cancelled = false;
    void document.fonts?.ready?.then(() => {
      if (!cancelled) onResize();
    });
    return () => {
      cancelled = true;
      window.removeEventListener("resize", onResize);
      watcher?.disconnect();
      query?.removeEventListener?.("change", onResize);
    };
  }, [relayout, enabled]);

  return (
    <div
      className={`folio-shell${showContents ? "" : " folio-shell--no-rail"}`}
      data-theme={theme}
      data-folio="true"
    >
      {showContents && (
        <ContentsRail
          entries={plan.toc}
          currentBlock={currentBlock}
          onJump={(entry: TocEntry) => {
            setCurrentBlock(entry.blockIndex);
            scrollToBlock(entry.blockIndex);
          }}
        />
      )}

      <header className="folio-head">
        <div>
          {props.eyebrow && <p className="folio-head__eyebrow">{props.eyebrow}</p>}
          <h1 className="folio-head__title">{titleLabel(session)}</h1>
          <p className="folio-head__meta">{`${modelLabel(session)}  \u00B7  ${session.turns} ${session.turns === 1 ? "turn" : "turns"}  \u00B7  ${plan.blocks.length} ${plan.blocks.length === 1 ? "block" : "blocks"}`}</p>
        </div>
        <FindBar
          query={query}
          shown={shown}
          total={total}
          onQuery={onQuery}
          onNext={() => jumpToMatch(active + 1)}
          onPrevious={() => jumpToMatch(active - 1)}
          onClear={() => onQuery("")}
        />
      </header>

      {(props.exportEnabled ?? EXPORT_BUILD_FLAG) ? (
        <div className="folio-tools">
          <div className="folio-actions" role="group" aria-label="Export">
            <span className="folio-actions__label" aria-hidden="true">Export</span>
            <button type="button" className="folio-button" aria-label="Export Markdown" onClick={() => doExport("markdown")}>
              <ExportGlyph />
              Markdown
            </button>
            <button type="button" className="folio-button" aria-label="Export HTML" onClick={() => doExport("html")}>
              <ExportGlyph />
              HTML
            </button>
            <label className="folio-check" title="Masks paths, emails, tokens and keys in the exported file">
              <input
                type="checkbox"
                className="folio-check__box"
                checked={redactExport}
                onChange={(event) => setRedactExport(event.target.checked)}
              />
              <span>Redact private details</span>
            </label>
          </div>
          <output className="folio-status" role="status" aria-label="Export">
            {exportNote}
          </output>
        </div>
      ) : null}

      <div className="folio-sheet" key={session.id} data-folio-sheet="true">
      <div className="folio-roll" aria-hidden="true" />
      <div
        className="folio-scroll"
        ref={list.scrollRef}
        data-folio-scroll="true"
        data-total-blocks={plan.blocks.length}
        style={height ? { height } : undefined}
        tabIndex={0}
      >
        <div className="folio-viewport" style={enabled ? { height: list.totalHeight } : undefined}>
          <SidenoteLayoutContext.Provider value={relayout}>
          <article
            ref={pageRef}
            className="folio-page"
            data-surface="parchment"
            data-type-scale="folio"
            data-virtualized={enabled ? "true" : "false"}
            data-rendered-blocks={visible.length}
          >
            {visible.map((block) => (
              <Row
                key={block.id}
                block={block}
                notes={marginalia ? (notesByAnchor.get(block.index) ?? []) : []}
                find={find}
                current={block.index === currentBlock}
                style={enabled ? { transform: `translateY(${list.offsetOf(block.index)}px)` } : undefined}
                rowRef={enabled ? list.measure(block.index) : undefined}
                sidenotes
              />
            ))}
          </article>
          </SidenoteLayoutContext.Provider>
        </div>
      </div>
      </div>

      <footer className="folio-foot" role="group" aria-label="Session details">
        <span className="folio-foot__model">{modelLabel(session)}</span>
        <span className="folio-foot__label" aria-hidden="true">Tokens</span>
        {session.tokens_in === null || session.tokens_out === null ? (
          <span className="folio-foot__item folio-foot__count">{tokensLabel(session)}</span>
        ) : (
          <span className="folio-foot__item folio-foot__count">
            <span className="folio-foot__figure">{session.tokens_in.toLocaleString("en-US")}</span> in /{" "}
            <span className="folio-foot__figure">{session.tokens_out.toLocaleString("en-US")}</span> out
          </span>
        )}
        <span className="folio-foot__item">
          <span className="folio-foot__figure">{session.turns}</span> turns
        </span>
        <span className="folio-foot__item">{session.agent_id}</span>
        <span className="folio-foot__item">{formatDuration(session.started_at, session.ended_at)}</span>
      </footer>
    </div>
  );
}
