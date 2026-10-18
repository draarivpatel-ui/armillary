export { Folio, type FolioProps } from "./Folio";
export { Row } from "./components/Row";
export { FindBar, type FindBarProps } from "./components/FindBar";
export { ContentsRail, type ContentsRailProps } from "./ContentsRail";
export { Marginalia } from "./components/Marginalia";
export { DiffView, DiffBody } from "./components/DiffView";
export { Body } from "./components/Body";

export { buildBlocks, planOf, type BlockPlan, type FolioBlock, type MarginalNote, type TocEntry } from "./blockify";
export { parseUnifiedDiff, makeUnifiedDiff, editDiff, type ParsedDiff, type DiffLine } from "./diff";
export { parseMarkdown, type Block, type Inline } from "./markdown";
export { renderMarkdown, type RenderOptions } from "./markdown/render";
export { highlight, tokenClass, type Token, type TokenKind } from "./highlight";
export { redact, redactionSummary, containsSensitive, REDACTED, type RedactionLabel } from "./redact";
export {
  buildFind,
  collectUnits,
  decorate,
  EMPTY_FIND,
  type FindMatch,
  type FindState,
  type Unit,
} from "./find";
export {
  exportMarkdown,
  exportHtml,
  formatDuration,
  type ExportFormat,
  type ExportOptions,
  type ExportResult,
} from "./export";
export { fromContract, anchorSeqFor } from "./contract";
export { useVirtualList } from "./virtual/useVirtualList";

export { palette, fontStacks, typeScale, contrastRatio, TEXT_PAIRS, TOKEN_NAMES } from "./styles/palette";
export { FOLIO_CSS, injectFolioCss, styleTag } from "./styles/stylesheet";

export type {
  Message,
  MessageRole,
  NormalizedSession,
  PlanItem,
  Session,
  SessionStatus,
  Theme,
  ToolCall,
  ToolStatus,
  FileEdit,
} from "./types";

export { mockSessions, mockSessionList, defaultSession } from "./data/mockSessions";
export { makeLongSession } from "./data/makeLongSession";
