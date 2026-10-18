import React from "react";

export type BadgeVariant =
  | "default"
  | "gilt"
  | "verdigris"
  | "vermilion"
  | "anthropic"
  | "openai"
  | "google"
  | "github-microsoft"
  | "cursor"
  | "open-source-clis"
  | "chinese-labs"
  | "other";

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  children: React.ReactNode;
}

export const Badge: React.FC<BadgeProps> = ({
  variant = "default",
  children,
  className = "",
  ...props
}) => {
  return (
    <span
      className={`obs-badge obs-badge--${variant} ${className}`.trim()}
      {...props}
    >
      {children}
    </span>
  );
};
