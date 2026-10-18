import React, { forwardRef } from "react";

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  "aria-label": string;
  children: React.ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className = "", children, disabled, ...props }, ref) => {
    return (
      <button
        ref={ref}
        type="button"
        className={`obs-icon-button ${className}`.trim()}
        disabled={disabled}
        aria-disabled={disabled ? "true" : undefined}
        {...props}
      >
        {children}
      </button>
    );
  }
);

IconButton.displayName = "IconButton";
