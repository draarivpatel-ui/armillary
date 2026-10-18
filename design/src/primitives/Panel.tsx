import React from "react";

export type PanelVariant = "default" | "raised";

export interface PanelProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: PanelVariant;
  title?: string;
  header?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
}

export const Panel: React.FC<PanelProps> = ({
  variant = "default",
  title,
  header,
  footer,
  children,
  className = "",
  ...props
}) => {
  const panelClasses = [
    "obs-panel",
    variant === "raised" ? "obs-panel--raised" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const hasHeader = header || title;

  return (
    <section
      role={title ? "region" : undefined}
      aria-label={title}
      className={panelClasses}
      {...props}
    >
      {hasHeader && (
        <header className="obs-panel__header">
          {title ? <h3 className="obs-panel__title">{title}</h3> : header}
          {title && header && <div>{header}</div>}
        </header>
      )}
      <div className="obs-panel__body">{children}</div>
      {footer && <footer className="obs-panel__footer">{footer}</footer>}
    </section>
  );
};
