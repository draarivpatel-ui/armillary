/** Small deterministic tokenizer so code blocks can be coloured without a highlighting library. */

export type TokenKind = "keyword" | "string" | "comment" | "number" | "function" | "punctuation" | "text";

export interface Token {
  kind: TokenKind;
  text: string;
}

const KEYWORDS: Record<string, Set<string>> = {
  ts: keywords("const let var function return if else for while class interface type enum new import export from default async await try catch finally throw extends implements as of null undefined true false void never unknown readonly public private protected static this super yield switch case do break continue in instanceof typeof delete"),
  js: keywords("const let var function return if else for while class new import export default async await try catch finally throw extends super this null undefined true false void switch case do break continue in typeof delete of"),
  rust: keywords("fn let mut struct enum impl trait for while loop if else match return pub use mod crate self super where as dyn ref move static const type async await unsafe extern async"),
  python: keywords("def class return if elif else for while import from as with try except finally raise pass lambda yield global nonlocal assert del in is not and or None True False async await self"),
  go: keywords("func package import return if else for range var const type struct interface map chan go defer switch case default nil true false string int error"),
  json: keywords("true false null"),
  bash: keywords("if then else fi for do done while case esac function export local set echo cd exit source return in"),
  css: keywords("@media @import color background border display flex grid none solid"),
};

function keywords(list: string): Set<string> {
  return new Set(list.split(/\s+/).filter(Boolean));
}

const LANGUAGES: Record<string, string> = {
  typescript: "ts",
  tsx: "ts",
  javascript: "js",
  jsx: "js",
  py: "python",
  python3: "python",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  jsonc: "json",
  toml: "bash",
  yaml: "bash",
};

const LINE_COMMENTS: Record<string, string[]> = {
  ts: ["//"],
  js: ["//"],
  rust: ["//"],
  go: ["//"],
  bash: ["#"],
  python: ["#"],
  json: [],
  css: [],
};

const BLOCK_COMMENTS: Record<string, [string, string][]> = {
  ts: [["/*", "*/"]],
  js: [["/*", "*/"]],
  rust: [["/*", "*/"]],
  go: [["/*", "*/"]],
  css: [["/*", "*/"]],
  python: [],
  bash: [],
  json: [],
};

function normalizeLang(lang: string): string {
  const key = (lang || "").toLowerCase().trim();
  if (key in KEYWORDS) return key;
  return LANGUAGES[key] ?? "";
}

function classifyWord(word: string, lang: string): TokenKind {
  const table = KEYWORDS[lang];
  if (table?.has(word)) return "keyword";
  if (/^(0x[0-9a-fA-F]+|\d[\d_]*(\.\d+)?([eE][+-]?\d+)?)$/.test(word)) return "number";
  if (/^[A-Za-z_$][\w$]*$/.test(word) && table?.has(word.toLowerCase())) return "keyword";
  return "text";
}

/** Split source into tokens, always lossless: joining the text gives the input back. */
export function highlight(source: string, lang: string): Token[] {
  const language = normalizeLang(lang);
  const out: Token[] = [];
  const lineComments = LINE_COMMENTS[language] ?? [];
  const blockComments = BLOCK_COMMENTS[language] ?? [];
  let i = 0;
  let buffer = "";

  const push = (kind: TokenKind, text: string) => {
    if (text === "") return;
    if (kind === "text") {
      buffer += text;
      return;
    }
    flush();
    out.push({ kind, text });
  };

  const flush = () => {
    if (buffer === "") return;
    const words = buffer.match(/[A-Za-z_$][\w$]*|\s+|[^\sA-Za-z_$\w]+/g) ?? [];
    for (const word of words) {
      if (/^\s+$/.test(word)) {
        out.push({ kind: "text", text: word });
        continue;
      }
      if (/^[A-Za-z_$][\w$]*$/.test(word)) {
        out.push({ kind: classifyWord(word, language), text: word });
        continue;
      }
      out.push({ kind: "punctuation", text: word });
    }
    buffer = "";
  };

  while (i < source.length) {
    const rest = source.slice(i);

    const block = blockComments.find(([open]) => rest.startsWith(open));
    if (block) {
      const end = rest.indexOf(block[1], block[0].length);
      const text = end === -1 ? rest : rest.slice(0, end + block[1].length);
      push("comment", text);
      i += text.length;
      continue;
    }

    const line = lineComments.find((open) => rest.startsWith(open));
    if (line) {
      const end = rest.indexOf("\n");
      const text = end === -1 ? rest : rest.slice(0, end);
      push("comment", text);
      i += text.length;
      continue;
    }

    if (language === "json" && rest.startsWith('"')) {
      const end = findStringEnd(rest, '"');
      const text = rest.slice(0, end + 1);
      const following = rest.slice(text.length);
      push(/^ *:/.test(following) ? "function" : "string", text);
      i += text.length;
      continue;
    }

    if (rest[0] === '"' || rest[0] === "'" || rest[0] === "`") {
      const quote = rest[0];
      const end = findStringEnd(rest, quote);
      const text = rest.slice(0, end + 1);
      push("string", text);
      i += text.length;
      continue;
    }

    if (/[A-Za-z_$]/.test(rest[0])) {
      const word = /^[A-Za-z_$][\w$]*/.exec(rest)![0];
      const after = rest.slice(word.length);
      const isCall = /^\s*\(/.test(after) && !KEYWORDS[language]?.has(word);
      if (isCall) push("function", word);
      else buffer += word;
      i += word.length;
      continue;
    }

    if (/\d/.test(rest[0])) {
      const number = /^[\d][\d_]*(\.\d+)?([eE][+-]?\d+)?/.exec(rest)![0];
      push("number", number);
      i += number.length;
      continue;
    }

    if (/[(){}[\]<>=!+\-*/%&|^~:;,?.@#\\]/.test(rest[0])) {
      push("punctuation", rest[0]);
      i += 1;
      continue;
    }

    buffer += rest[0];
    i += 1;
  }

  flush();
  return out;
}

function findStringEnd(text: string, quote: string): number {
  for (let j = 1; j < text.length; j++) {
    if (text[j] === "\\") {
      j += 1;
      continue;
    }
    if (text[j] === quote) return j;
    if (quote !== "`" && text[j] === "\n") return j - 1;
  }
  return text.length - 1;
}

const TOKEN_CLASS: Record<Exclude<TokenKind, "text">, string> = {
  keyword: "tok-key",
  string: "tok-str",
  comment: "tok-com",
  number: "tok-num",
  function: "tok-fn",
  punctuation: "tok-punct",
};

/** Class name for a token; plain text carries none. */
export function tokenClass(kind: TokenKind): string | undefined {
  return kind === "text" ? undefined : TOKEN_CLASS[kind];
}

/** Join the token text, used to assert losslessness. */
export function tokensToText(tokens: Token[]): string {
  return tokens.map((token) => token.text).join("");
}
