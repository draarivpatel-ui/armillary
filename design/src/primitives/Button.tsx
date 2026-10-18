import React, { forwardRef } from "react";

export type ButtonVariant = "default" | "gilt" | "destructive" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: React.ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "default", size = "md", className = "", children, disabled, ...props }, ref) => {
    const classNames = [
      "obs-button",
      `obs-button--${variant}`,
      size !== "md" ? `obs-button--${size}` : "",
      className,
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <button
        ref={ref}
        type="button"
        className={classNames}
        disabled={disabled}
        aria-disabled={disabled ? "true" : undefined}
        {...props}
      >
        {children}
      </button>
    );
  }
);

Button.displayName = "Button";
