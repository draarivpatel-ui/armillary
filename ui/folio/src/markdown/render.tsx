import type { ReactNode } from "react";
import { Fragment } from "react";
import { highlight, tokenClass } from "../highlight";
import { decorate, keys, type FindState, EMPTY_FIND } from "../find";
import { parseMarkdown, type Block, type Inline } from "./index";
import { classifyHref, imagePlaceholderText } from "./links";

export interface RenderOptions {
  /** Shared with the finder so marks land on the right piece of text. */
  keyPrefix: string;
  find?: FindState;
}

function text(key: string, value: string, find: FindState): ReactNode {
  return <Fragment key={key}>{decorate(key, value, find)}</Fragment>;
}

function inlineNodes(nodes: Inline[], base: string, find: FindState): ReactNode[] {
  return nodes.map((node, index) => {
    const key = keys.inline(base, index);
    switch (node.type) {
      case "text":
        return text(key, node.text, find);
      case "code":
        return (
          <code key={key} className="inline-code">
            {decorate(key, node.text, find)}
          </code>
        );
      case "bold":
        return <strong key={key}>{inlineNodes(node.children, key, find)}</strong>;
      case "italic":
        return <em key={key}>{inlineNodes(node.children, key, find)}</em>;
      case "link": {
        // Never an <a>: see links.ts. Only the label and a cleaned, visible copy of the target are shown.
        const target = classifyHref(node.href);
        const label = decorate(key, node.text, find);
        const shown = target.safe ? target.url : target.display;
        const url = shown !== "" && shown !== node.text ? <span className="folio-link__url">{` (${shown})`}</span> : null;
        if (!target.safe) {
          return (
            <Fragment key={key}>
              {label}
              {url}
            </Fragment>
          );
        }
        return (
          <span key={key} className="folio-link">
            {label}
            {url}
          </span>
        );
      }
      case "image":
        // A text placeholder only: no <img>, no src, nothing is fetched.
        return (
          <span
            key={key}
            className="folio-image-placeholder"
            role="img"
            aria-label={node.alt.trim() === "" ? "Image" : `Image: ${node.alt.trim()}`}
          >
            {imagePlaceholderText(node.alt)}
          </span>
        );
    }
  });
}

export function CodeBlock({
  lang,
  text: source,
  blockKey,
  find = EMPTY_FIND,
}: {
  lang: string;
  text: string;
  blockKey: string;
  find?: FindState;
}) {
  const codeKey = keys.code(blockKey);
  return (
    <div className="folio-code" role="region" aria-label="Code snippet" data-lang={lang || "text"} tabIndex={0}>
      <pre>
        <code>
          {highlight(source, lang).map((token, index) => {
            const key = keys.token(codeKey, index);
            const className = tokenClass(token.kind);
            return (
              <span key={key} className={className}>
                {decorate(key, token.text, find)}
              </span>
            );
          })}
        </code>
      </pre>
    </div>
  );
}

export function Checklist({
  items,
  label,
  blockKey,
  find = EMPTY_FIND,
}: {
  items: { text: string; done: boolean }[];
  label: string;
  blockKey: string;
  find?: FindState;
}) {
  return (
    <ul className="folio-checklist" role="list" aria-label={label}>
      {items.map((item, index) => {
        const key = `${blockKey}-${index}`;
        return (
          <li key={key} className="folio-checklist__item">
            <input
              className="folio-checklist__box"
              type="checkbox"
              checked={item.done}
              readOnly
              aria-label={item.text}
              tabIndex={-1}
            />
            <span className="folio-checklist__text">{decorate(key, item.text, find)}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function renderBlocks(blocks: Block[], options: RenderOptions): ReactNode {
  const { keyPrefix } = options;
  const find = options.find ?? EMPTY_FIND;

  return blocks.map((block, index) => {
    const blockKey = keys.block(keyPrefix, index);
    switch (block.type) {
      case "heading": {
        const Tag = `h${Math.min(6, block.level)}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
        return (
          <Tag key={blockKey} className={`folio-md folio-md--h${block.level}`}>
            {inlineNodes(block.children, blockKey, find)}
          </Tag>
        );
      }
      case "paragraph":
        return (
          <p key={blockKey} className="folio-md folio-md--p">
            {inlineNodes(block.children, blockKey, find)}
          </p>
        );
      case "code":
        return <CodeBlock key={blockKey} lang={block.lang} text={block.text} blockKey={blockKey} find={find} />;
      case "list": {
        const children = block.items.map((item, itemIndex) => (
          <li key={`${blockKey}-${itemIndex}`}>
            {inlineNodes(item.children, `${blockKey}-${itemIndex}`, find)}
          </li>
        ));
        return block.ordered ? (
          <ol key={blockKey} className="folio-md-list">
            {children}
          </ol>
        ) : (
          <ul key={blockKey} className="folio-md-list">
            {children}
          </ul>
        );
      }
      case "checklist":
        return (
          <Checklist key={blockKey} items={block.items} label="Checklist" blockKey={blockKey} find={find} />
        );
      case "quote":
        return (
          <blockquote key={blockKey} className="folio-quote">
            {renderBlocks(block.blocks, { keyPrefix: `${blockKey}q`, find })}
          </blockquote>
        );
      case "rule":
        return <hr key={blockKey} className="folio-rule" />;
    }
  });
}

export function renderMarkdown(source: string, options?: Partial<RenderOptions>): ReactNode {
  return (
    <>
      {renderBlocks(parseMarkdown(source), {
        keyPrefix: options?.keyPrefix ?? "k0",
        find: options?.find ?? EMPTY_FIND,
      })}
    </>
  );
}
