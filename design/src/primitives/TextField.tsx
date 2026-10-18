import React, { forwardRef, useId } from "react";

export interface TextFieldProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> {
  label?: string;
  error?: string;
  helperText?: string;
  /** Set the value in Commit Mono (paths, commands); UI text otherwise. */
  mono?: boolean;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(
  ({ label, error, helperText, mono = false, id: providedId, className = "", ...props }, ref) => {
    const generatedId = useId();
    const id = providedId || generatedId;
    const errorId = `${id}-error`;
    const helperId = `${id}-helper`;

    const describedBy = [
      error ? errorId : null,
      helperText ? helperId : null,
      props["aria-describedby"],
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <div className="obs-text-field-container">
        {label && (
          <label htmlFor={id} className="obs-text-field__label">
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={id}
          className={`obs-text-field${mono ? " obs-text-field--mono" : ""}${error ? " obs-text-field--error" : ""} ${className}`.trim()}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={describedBy || undefined}
          {...props}
        />
        {error && (
          <span id={errorId} className="obs-text-field__error-msg" role="alert">
            {error}
          </span>
        )}
        {!error && helperText && (
          <span id={helperId} className="obs-text-field__helper-text">
            {helperText}
          </span>
        )}
      </div>
    );
  }
);

TextField.displayName = "TextField";
