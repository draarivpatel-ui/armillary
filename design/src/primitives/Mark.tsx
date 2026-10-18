import React from "react";

export interface MarkProps {
  tone?: "neutral" | "gilt" | "success" | "alert";
  shape?: "dot" | "ring" | "diamond";
  children: React.ReactNode;
  /** Colours the text with the tone's text token. */
  emphasis?: boolean;
  className?: string;
  title?: string;
}

/** A quiet status mark: a small engraved shape beside plain text, no pill. */
export const Mark: React.FC<MarkProps> = ({
  tone = "neutral",
  shape = "dot",
  children,
  emphasis = false,
  className = "",
  title,
}) => (
  <span
    className={`obs-mark obs-mark--${tone} obs-mark--${shape}${emphasis ? " obs-mark--emphasis" : ""} ${className}`.trim()}
    title={title}
  >
    <span className="obs-mark__shape" aria-hidden="true" />
    <span className="obs-mark__text">{children}</span>
  </span>
);
