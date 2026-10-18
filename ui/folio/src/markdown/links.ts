/**
 * Link and image policy for Markdown that an agent (or a web page an agent read) wrote.
 *
 * Links are NOT clickable in v0.1. In a Tauri webview a real <a href> navigates the whole app
 * away from the UI, and the app has no opener plugin, so the Folio never emits an anchor for
 * source content. A link whose target is plain web or mail (http, https, mailto) is shown as
 * "text (url)" in a non-navigating element; every other target is shown as inert text. Letting
 * the reader ask the OS to open a link is an explicit user action that needs an opener, and is
 * left to the lead. Images are never loaded: the renderer shows a text placeholder only.
 */

/**
 * Whitespace, control, zero-width and bidi-control characters. Browsers ignore some of these
 * inside a URL scheme ("java\tscript:" runs as javascript:), and the rest can disguise where a
 * link points, so they are removed before the scheme is judged and before the URL is shown.
 */
const HIDDEN_RANGES: [number, number][] = [
  [0x0000, 0x0020], // controls and space
  [0x007f, 0x00a0], // delete, C1 controls, no-break space
  [0x00ad, 0x00ad], // soft hyphen
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x2000, 0x200f], // spaces, zero-width characters, direction marks
  [0x2028, 0x202f], // line and paragraph separators, bidi embeddings and overrides
  [0x205f, 0x206f], // more spaces, invisible operators, bidi isolates
  [0x3000, 0x3000],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
];

const HIDDEN = new RegExp(
  `[${HIDDEN_RANGES.map(([from, to]) => `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`).join("")}]`,
  "g",
);

export type LinkTarget =
  /** Safe to show as a URL: its scheme is http, https or mailto. `url` is cleaned and never navigated. */
  | { safe: true; url: string }
  /** Anything else. `display` is the cleaned raw target, shown as plain text. */
  | { safe: false; display: string };

export function classifyHref(href: string): LinkTarget {
  const cleaned = href.replace(HIDDEN, "");
  const web = /^(?:https?):\/\/[^/?#\\]+/i.test(cleaned);
  const mail = /^mailto:[^\s]+/i.test(cleaned);
  if (web || mail) {
    try {
      const parsed = new URL(cleaned);
      const scheme = parsed.protocol.toLowerCase();
      if (scheme === "http:" || scheme === "https:" || scheme === "mailto:") return { safe: true, url: cleaned };
    } catch {
      // unparsable: fall through to inert
    }
  }
  return { safe: false, display: cleaned };
}

/** What an image shows in place of the picture: "[image: ALT]", or "[image]" without alt text. */
export function imagePlaceholderText(alt: string): string {
  const label = alt.replace(HIDDEN, " ").replace(/\s+/g, " ").trim();
  return label === "" ? "[image]" : `[image: ${label}]`;
}
