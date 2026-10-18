import { fontStacks, palette, TOKEN_NAMES, typeScale, type TokenName } from "./palette";
import type { Theme } from "../types";

const TOKENS = TOKEN_NAMES as TokenName[];

function themeBlock(theme: Theme): string {
  const values = palette[theme];
  const vars = TOKENS.map((name) => `  --${name}: ${values[name]};`).join("\n");
  return `[data-theme="${theme}"] {\n${vars}\n}`;
}

/* SVG namespaces below are percent-encoded (http%3A) so the stylesheet carries no URL scheme at all;
   they are namespace names, never fetched. */
/** Paper grain: fractal noise at about 3 percent, drawn inline so nothing is loaded from anywhere. */
const PAPER_GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http%3A//www.w3.org/2000/svg' width='240' height='240'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0.25 0 0 0 0 0.19 0 0 0 0 0.08 0 0 0 0.9 0'/%3E%3C/filter%3E%3Crect width='240' height='240' filter='url(%23g)' opacity='0.13'/%3E%3C/svg%3E\")";
/** Paper cloudiness: low-frequency mottling at about 3 percent, the fibres of a laid sheet. */
const PAPER_CLOUD =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http%3A//www.w3.org/2000/svg' width='600' height='600'%3E%3Cfilter id='c'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.012 0.02' numOctaves='3' seed='7' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0.42 0 0 0 0 0.31 0 0 0 0 0.12 0 0 0 0.8 -0.18'/%3E%3C/filter%3E%3Crect width='600' height='600' filter='url(%23c)' opacity='0.11'/%3E%3C/svg%3E\")";
/** A faint foxing toward the page edges, like an old leaf. */
const PAPER_EDGE = "radial-gradient(130% 120% at 50% 40%, transparent 62%, rgba(120, 88, 36, 0.07) 100%)";
/** The engraved check for completed checklist items, in parchment on gilt. */
const CHECK_MARK =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http%3A//www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M3.5 8.5l3 3 6-7' fill='none' stroke='%23FBF6EA' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")";
/** The find field's lens. */
const LENS =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http%3A//www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23C9A24A' stroke-width='1.5' stroke-linecap='round'%3E%3Ccircle cx='10.25' cy='10.25' r='6.25'/%3E%3Cpath d='M14.85 14.85L20 20' stroke-width='2'/%3E%3C/svg%3E\")";

const RULES = `
:root {
  --rhythm: ${typeScale.rhythm}px;
  --font-display: ${fontStacks.display};
  --font-body: ${fontStacks.body};
  --font-mono: ${fontStacks.mono};
  --ease-observatory: cubic-bezier(0.25, 0.1, 0.25, 1);
  --ease-unroll: cubic-bezier(0.45, 0.05, 0.2, 1);
  --hairline: 0.75px;
  --move: 220ms;
  --unroll: 640ms;
  /* the margin widens with the reader (container-relative), so real tool output has room */
  --margin-width: clamp(260px, 36cqi, 400px);
}

.folio-shell,
.folio-export-doc {
  background: var(--ink-0);
  color: var(--star);
  font-family: var(--font-body);
  font-size: 14px;
  line-height: 1.5;
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  grid-template-rows: auto auto minmax(0, 1fr) auto;
  grid-template-areas:
    "rail head"
    "rail tools"
    "rail page"
    "rail foot";
  min-height: 0;
}

.folio-shell--no-rail {
  grid-template-columns: minmax(0, 1fr);
  grid-template-areas: "head" "tools" "page" "foot";
}

.folio-visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

/* ---------- head ---------- */
.folio-head {
  grid-area: head;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  padding: 28px 40px 16px;
}

.folio-head__eyebrow {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--gilt-text);
}

.folio-head__title {
  font-family: var(--font-display);
  font-size: 32px;
  line-height: 1.1;
  font-weight: 600;
  letter-spacing: 0.005em;
  margin: 0;
  color: var(--star);
}

.folio-head__meta { color: var(--dust); font-size: 14px; margin: 6px 0 0; }

/* ---------- tools ---------- */
.folio-tools {
  grid-area: tools;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 0 40px 14px;
  position: relative;
}

/* the engraved rule under the head: gilt first stretch and a diamond */
.folio-tools::after {
  content: "";
  position: absolute;
  left: 40px;
  right: 40px;
  bottom: 0;
  height: var(--hairline);
  background: linear-gradient(to right, var(--gilt) 0, var(--gilt) 72px, var(--line) 72px);
  opacity: 0.9;
}

.folio-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.folio-actions__label {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--dust);
  margin-right: 4px;
}

.folio-find { display: flex; align-items: center; gap: 4px; }

.folio-find__input {
  font-family: var(--font-body);
  font-size: 14px;
  color: var(--star);
  background: var(--ink-1) ${LENS} no-repeat 9px 50% / 14px 14px;
  border: var(--hairline) solid var(--line);
  border-radius: 3px;
  height: 30px;
  padding: 0 10px 0 30px;
  min-width: 220px;
  transition: border-color var(--move) var(--ease-observatory);
}

.folio-find__input::placeholder { color: var(--dust); }
.folio-find__input:hover { border-color: var(--gilt); }
.folio-find__input:focus-visible { outline: none; border-color: var(--gilt); box-shadow: 0 0 0 2px var(--gilt); }

.folio-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 30px;
  font-family: var(--font-body);
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  color: var(--dust);
  background: transparent;
  border: var(--hairline) solid transparent;
  border-radius: 3px;
  padding: 0 10px;
  cursor: pointer;
  transition: color var(--move) var(--ease-observatory), border-color var(--move) var(--ease-observatory), background-color var(--move) var(--ease-observatory);
}

.folio-button svg { color: var(--gilt); flex: none; }
.folio-button:hover:not(:disabled) { color: var(--star); border-color: var(--line); background: var(--ink-1); }
.folio-button:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--gilt); }
.folio-button:disabled { opacity: 0.4; cursor: default; }
.folio-button[aria-pressed="true"] { border-color: var(--gilt); color: var(--gilt-text); }
.folio-button--icon { width: 30px; padding: 0; }

.folio-status {
  color: var(--dust);
  font-size: 12px;
  min-width: 48px;
  font-variant-numeric: tabular-nums lining-nums;
}

.folio-check {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--dust);
  font-size: 12px;
  margin-left: 8px;
  cursor: pointer;
}

.folio-check__box {
  appearance: none;
  -webkit-appearance: none;
  width: 16px;
  height: 16px;
  margin: 0;
  border: var(--hairline) solid var(--dust);
  border-radius: 2px;
  background: var(--ink-0);
  cursor: pointer;
  flex: none;
}

.folio-check__box:checked { background: var(--gilt) ${CHECK_MARK} center / 12px 12px no-repeat; border-color: var(--gilt); }
.folio-check__box:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--gilt); }

/* ---------- contents rail ---------- */
.folio-rail {
  grid-area: rail;
  border-right: var(--hairline) solid var(--line);
  background: var(--ink-1);
  padding: 32px 12px 24px;
  overflow-y: auto;
}

.folio-rail__label {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--gilt-text);
  margin: 0 10px 12px;
}

.folio-toc__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }

.folio-toc__link {
  position: relative;
  display: block;
  padding: 6px 10px 6px 14px;
  color: var(--dust);
  font-size: 14px;
  line-height: 1.4;
  text-decoration: none;
  border-radius: 3px;
  outline: none;
  transition: color var(--move) var(--ease-observatory), background-color var(--move) var(--ease-observatory);
}

.folio-toc__link::before {
  content: "";
  position: absolute;
  left: 0;
  top: 7px;
  bottom: 7px;
  width: 1.5px;
  background: transparent;
  transition: background-color var(--move) var(--ease-observatory);
}

.folio-toc__link--minor { padding-left: 28px; font-size: 12px; }
.folio-toc__link:hover { color: var(--star); }
.folio-toc__link:focus-visible { box-shadow: 0 0 0 2px var(--gilt); }
.folio-toc__link[aria-current="true"] { color: var(--gilt-text); background: linear-gradient(to right, rgba(201, 162, 74, 0.08), transparent 85%); }
.folio-toc__link[aria-current="true"]::before { background: var(--gilt); }

.folio-rail__hint { color: var(--dust); font-size: 12px; line-height: 1.5; margin: 20px 10px 0; }

/* ---------- the sheet (scroll area) and its unroll ---------- */
.folio-sheet {
  grid-area: page;
  position: relative;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.folio-scroll {
  flex: 1 1 auto;
  overflow-y: auto;
  min-height: 0;
  container-type: inline-size;
  padding: 24px 40px 40px;
  animation: folio-unroll var(--unroll) var(--ease-unroll) both;
}

.folio-scroll:focus-visible { outline: 2px solid var(--gilt); outline-offset: -2px; }

/* the rolled edge travelling down as the leaf opens */
.folio-roll {
  position: absolute;
  left: 40px;
  right: 40px;
  top: 24px;
  height: 14px;
  margin-top: -7px;
  border-radius: 7px;
  pointer-events: none;
  background: linear-gradient(to bottom, var(--page-edge), var(--parchment) 45%, var(--page-line) 100%);
  box-shadow: 0 1px 0 var(--page-line);
  opacity: 0;
  animation: folio-roll var(--unroll) var(--ease-unroll) both;
}

@keyframes folio-unroll {
  from { clip-path: inset(0 0 100% 0); }
  to { clip-path: inset(0 0 0 0); }
}

@keyframes folio-roll {
  0% { top: 24px; opacity: 1; }
  85% { opacity: 1; }
  100% { top: calc(100% - 16px); opacity: 0; }
}

.folio-viewport { position: relative; }

/* ---------- the page ---------- */
.folio-page {
  position: relative;
  max-width: 1120px;
  margin: 0 auto;
  background-color: var(--parchment);
  background-image: ${PAPER_EDGE}, ${PAPER_CLOUD}, ${PAPER_GRAIN};
  color: var(--page-ink);
  font-family: var(--font-body);
  font-size: 16px;
  line-height: 1.6;
  padding: 36px 0 calc(28px + var(--note-overflow, 0px));
  border: var(--hairline) solid var(--page-line);
  border-radius: 2px;
  /* a second leaf behind: depth from a paper step, not a shadow */
  box-shadow: 5px 5px 0 -1px var(--page-edge), 5px 5px 0 0 var(--page-line);
}

/* the margin rule: marginalia live beyond it */
.folio-page::before {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  right: calc(var(--margin-width) + 8px);
  width: 4px;
  border-left: var(--hairline) solid var(--page-line);
  border-right: var(--hairline) solid var(--page-line);
  opacity: 0.8;
  pointer-events: none;
}

.folio-page--static { padding-bottom: 8px; }

.folio-row {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) var(--margin-width);
  gap: 32px;
  align-items: start;
  padding: 14px 0 14px 56px;
}

.folio-row + .folio-row[data-block-kind="prompt"] { margin-top: 12px; padding-top: 26px; }

/* a turn begins: a short ruled line with a diamond, set into the left margin */
.folio-row + .folio-row[data-block-kind="prompt"]::before {
  content: "";
  position: absolute;
  top: 6px;
  left: 56px;
  width: 96px;
  height: var(--hairline);
  background: var(--page-line);
}

.folio-row--floating { position: absolute; left: 0; right: 0; top: 0; }

.folio-row--current::after {
  content: "";
  position: absolute;
  left: 22px;
  top: 22px;
  width: 6px;
  height: 6px;
  background: var(--page-gilt);
  transform: rotate(45deg);
}

.folio-body { grid-column: 1; min-width: 0; }
.folio-margin { grid-column: 2; display: flex; flex-direction: column; gap: 14px; padding: 4px 28px 4px 0; min-width: 0; }

/* Live reader: the notes column leaves the row's flow, so the reading text runs on without gaps.
   A layout pass writes --note-shift to keep note groups from landing on one another. */
.folio-row--sidenotes .folio-margin {
  position: absolute;
  top: 14px;
  right: 0;
  width: var(--margin-width);
  box-sizing: border-box;
  /* a shifted group can sit beside later rows, which must not cover it (they come later in the document) */
  z-index: 1;
  transform: translateY(var(--note-shift, 0px));
}
.folio-row--sidenotes + .folio-row--sidenotes[data-block-kind="prompt"] .folio-margin { top: 26px; }
/* a tall note group above makes the reading column yield: the layout pass writes the extra top margin */
.folio-row--sidenotes { margin-top: var(--note-push, 0px); }
.folio-row--sidenotes + .folio-row--sidenotes[data-block-kind="prompt"] { margin-top: calc(12px + var(--note-push, 0px)); }

.folio-prompt { margin: 0; }

.folio-prompt__title {
  font-family: var(--font-display);
  font-size: 24px;
  line-height: 1.25;
  font-weight: 600;
  margin: 0;
  color: var(--page-ink);
}

.folio-prompt__body { margin: 8px 0 0; }
.folio-reply p, .folio-prompt__body p { margin: 0 0 10px; }
.folio-system { color: var(--page-muted); font-style: italic; }

/* ---------- marginalia ---------- */
.folio-note {
  position: relative;
  font-size: 12px;
  line-height: 1.45;
  color: var(--page-muted);
  border-left: var(--hairline) solid var(--page-gilt);
  padding: 2px 0 2px 12px;
}

.folio-note__tool {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--page-gilt);
  background: transparent;
  border: 0;
  padding: 0;
}

.folio-note__line { margin: 4px 0 0; overflow-wrap: anywhere; }

/* a compact note keeps four lines of text; the toggle appears only when more is hidden */
.folio-note__text {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
  line-clamp: 4;
  overflow: hidden;
}
.folio-note__text--open { display: block; -webkit-line-clamp: unset; line-clamp: unset; overflow: visible; }

.folio-note__more {
  display: inline-block;
  margin: 4px 0 0;
  padding: 0;
  border: 0;
  border-radius: 2px;
  background: transparent;
  font-family: var(--font-body);
  font-size: 12px;
  line-height: 1.45;
  color: var(--page-gilt);
  cursor: pointer;
}
.folio-note__more:hover { text-decoration: underline; text-underline-offset: 2px; }
.folio-note__more:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--page-gilt); }
.folio-note__files { font-family: var(--font-mono); font-size: 12px; list-style: none; margin: 6px 0 0; padding: 0; overflow-wrap: anywhere; }
.folio-note__files li + li { margin-top: 2px; }

/* errors: a vermilion mark on the margin rule, a vermilion line, the text stays readable ink */
.folio-note--error { border-left-color: var(--vermilion-page); }
.folio-note--error::before {
  content: "";
  position: absolute;
  left: -13.5px;
  top: 5px;
  width: 7px;
  height: 7px;
  background: var(--vermilion-page);
  transform: rotate(45deg);
}

.folio-note__flag {
  display: inline-block;
  margin-left: 8px;
  color: var(--vermilion-page);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.06em;
  font-variant-caps: all-small-caps;
}

/* ---------- body text ---------- */
.folio-md { margin: 8px 0; }

.folio-md--h1,
.folio-md--h2,
.folio-md--h3,
.folio-md--h4,
.folio-md--h5,
.folio-md--h6 {
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 600;
  line-height: 1.25;
  margin: 18px 0 8px;
}

.folio-md--h1 { font-size: 24px; }
.folio-md--h2 { font-size: 20px; }
.folio-md-list { margin: 8px 0; padding-left: 22px; }
.folio-md-list li + li { margin-top: 2px; }
.folio-md-list li::marker { color: var(--page-gilt); }

.folio-quote {
  margin: 10px 0;
  padding-left: 16px;
  border-left: var(--hairline) solid var(--page-gilt);
  color: var(--page-muted);
  font-family: var(--font-display);
  font-size: 20px;
  font-style: italic;
}

.folio-rule { border: 0; border-top: var(--hairline) solid var(--page-line); margin: 18px 0; }
.inline-code { font-family: var(--font-mono); font-size: 0.82em; padding: 0 2px; border-radius: 2px; background: rgba(110, 84, 23, 0.07); }
.folio-link { color: var(--page-gilt); text-decoration: underline; text-decoration-thickness: var(--hairline); text-underline-offset: 3px; cursor: default; }
.folio-link__url { color: var(--page-muted); font-size: 0.85em; overflow-wrap: anywhere; }
.folio-image-placeholder {
  display: inline-block;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--page-muted);
  border: var(--hairline) dashed var(--page-line);
  border-radius: 2px;
  padding: 2px 8px;
}

/* checklists: engraved boxes, gilt when done */
.folio-checklist { list-style: none; margin: 10px 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.folio-checklist__item { display: flex; gap: 10px; align-items: baseline; }
.folio-checklist__box,
.folio-page input[type="checkbox"] {
  appearance: none;
  -webkit-appearance: none;
  flex: none;
  position: relative;
  top: 2px;
  width: 14px;
  height: 14px;
  margin: 0;
  border: var(--hairline) solid var(--page-muted);
  border-radius: 2px;
  background: transparent;
}
.folio-checklist__box:checked,
.folio-page input[type="checkbox"]:checked { background: var(--page-gilt) ${CHECK_MARK} center / 11px 11px no-repeat; border-color: var(--page-gilt); }
.folio-checklist__text { font-size: 16px; }
.folio-note .folio-checklist__text { font-size: 12px; }

/* ---------- diffs ---------- */
.folio-diff { margin-top: 8px; }

.folio-diff__path {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--page-gilt);
  background: transparent;
  border: 0;
  border-radius: 2px;
  padding: 0;
  cursor: pointer;
  text-align: left;
  overflow-wrap: anywhere;
}

button.folio-diff__path::before {
  content: "";
  flex: none;
  width: 0;
  height: 0;
  border-left: 4px solid currentColor;
  border-top: 3.5px solid transparent;
  border-bottom: 3.5px solid transparent;
  transform: translateY(-1px);
  transition: transform var(--move) var(--ease-observatory);
}

button.folio-diff__path[aria-expanded="true"]::before { transform: translateY(-1px) rotate(90deg); }
.folio-diff__path:hover .folio-diff__file { text-decoration: underline; text-underline-offset: 2px; }
.folio-diff__path:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--page-gilt); }
.folio-diff__counts { color: var(--page-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.folio-diff__add { color: var(--page-verdigris); }
.folio-diff__del { color: var(--vermilion-page); }

/* in the margin, diffs wrap rather than run off the leaf */
.folio-note .folio-diff__body { white-space: pre-wrap; overflow-wrap: anywhere; overflow-x: hidden; }
.folio-note .folio-diff__path { flex-wrap: wrap; row-gap: 2px; }
/* the file header lines repeat the toggle's file name; in the narrow margin they only wrap */
.folio-note .diff-line--header { display: none; }

/* an open diff stays open but is capped at about sixteen lines and scrolls inside itself */
.folio-diff__body--scroll { max-height: calc(16 * 1.5 * 12px + 12px); overflow-y: auto; }
.folio-diff__body--scroll:focus-visible { outline: 2px solid var(--page-gilt); outline-offset: -2px; }

.folio-diff__body {
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.5;
  margin: 6px 0 0;
  padding: 6px 0;
  background: rgba(29, 26, 20, 0.04);
  border-top: var(--hairline) solid var(--page-line);
  border-bottom: var(--hairline) solid var(--page-line);
  overflow-x: auto;
  white-space: pre;
}

.folio-code {
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.55;
  background: var(--ink-1);
  color: var(--star);
  border: var(--hairline) solid var(--line);
  border-radius: 3px;
  padding: 12px 14px;
  margin: 12px 0;
  overflow-x: auto;
}

.folio-code:focus-visible { outline: 2px solid var(--gilt); outline-offset: 1px; }
.folio-code pre { margin: 0; font: inherit; }

.tok-key { color: var(--gilt-text); font-weight: 600; }
.tok-str { color: var(--verdigris-text); }
.tok-com { color: var(--dust); font-style: italic; }
.tok-num { color: var(--gilt-text); }
.tok-fn { color: var(--star); }
.tok-punct { color: var(--dust); }

.diff-line { display: block; padding: 0 10px; }
.diff-line__sign { display: inline-block; width: 1.4em; opacity: 0.8; }
.diff-line--add { color: var(--page-verdigris); background: rgba(47, 111, 98, 0.10); }
.diff-line--del { color: var(--vermilion-page); background: rgba(184, 58, 36, 0.08); }
.diff-line--hunk { color: var(--page-gilt); }
.diff-line--header { color: var(--page-muted); }

.folio-mark { background: rgba(226, 199, 126, 0.55); color: var(--page-ink); border-radius: 1px; }
.folio-mark--active { background: var(--page-gilt); color: var(--parchment); }

/* ---------- foot: the colophon ---------- */
.folio-foot {
  grid-area: foot;
  border-top: var(--hairline) solid var(--line);
  background: var(--ink-1);
  padding: 10px 40px;
  color: var(--dust);
  font-size: 12px;
  display: flex;
  gap: 20px;
  align-items: baseline;
  flex-wrap: wrap;
}

.folio-foot__item { display: inline-flex; align-items: baseline; gap: 6px; }
.folio-foot__figure {
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 600;
  color: var(--star);
  font-variant-numeric: lining-nums tabular-nums;
}
.folio-foot__model { color: var(--star); font-family: var(--font-mono); font-size: 12px; }
.folio-foot__count { color: var(--dust); }
.folio-foot__label { font-size: 12px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; color: var(--dust); margin-right: -12px; }

.folio-export-doc { display: block; padding: 32px; }
.folio-export-doc .folio-page { max-width: 960px; margin: 0 auto; padding: 32px; }

@media (max-width: 960px) {
  .folio-shell {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: "head" "tools" "page" "foot";
  }
  .folio-rail { display: none; }
  .folio-row { grid-template-columns: minmax(0, 1fr); padding-left: 32px; }
  .folio-page::before { display: none; }
  .folio-margin { grid-column: 1; padding-right: 32px; }
  .folio-row--sidenotes .folio-margin { position: static; width: auto; transform: none; }
  .folio-note--error::before { left: -22px; }
}

@media (prefers-reduced-motion: reduce) {
  .folio-toc__link,
  .folio-button,
  .folio-find__input { transition: none; }
  .folio-scroll { animation: folio-fade 220ms linear both; }
  .folio-roll { animation: none; display: none; }
  @keyframes folio-fade { from { opacity: 0; } to { opacity: 1; } }
}
`;

export const FOLIO_CSS = [themeBlock("dark"), themeBlock("light"), RULES].join("\n\n");

export function styleTag(): HTMLStyleElement {
  const style = document.createElement("style");
  style.id = "folio-css";
  style.textContent = FOLIO_CSS;
  return style;
}

export function injectFolioCss(): void {
  if (document.getElementById("folio-css")) return;
  document.head.appendChild(styleTag());
}
