import React from "react";

export interface FigureProps {
  value: React.ReactNode;
  label: string;
  tone?: "default" | "gilt" | "alert" | "success";
  size?: "md" | "lg";
  className?: string;
  title?: string;
}

/** A typographic statistic: a large numeral beside a quiet label. */
export const Figure: React.FC<FigureProps> = ({
  value,
  label,
  tone = "default",
  size = "md",
  className = "",
  title,
}) => (
  <div
    className={`obs-figure obs-figure--${tone} obs-figure--${size} ${className}`.trim()}
    title={title}
  >
    <span className="obs-figure__value">{value}</span>
    <span className="obs-figure__label">{label}</span>
  </div>
);

export interface FigureGroupProps {
  children: React.ReactNode;
  className?: string;
  "aria-label"?: string;
}

export const FigureGroup: React.FC<FigureGroupProps> = ({
  children,
  className = "",
  "aria-label": ariaLabel,
}) => (
  <div role="group" aria-label={ariaLabel} className={`obs-figures ${className}`.trim()}>
    {children}
  </div>
);
