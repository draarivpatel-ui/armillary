import React, { useId } from "react";

export interface CheckboxProps
  extends Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    "type" | "checked" | "onChange" | "disabled" | "id" | "className"
  > {
  label: React.ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
  description?: string;
}

export const Checkbox: React.FC<CheckboxProps> = ({
  label,
  checked,
  onChange,
  disabled = false,
  id: providedId,
  className = "",
  description,
  ...rest
}) => {
  const generatedId = useId();
  const id = providedId || generatedId;
  const descriptionId = `${id}-description`;

  const control = (
    <label
      className={`obs-checkbox${disabled ? " obs-checkbox--disabled" : ""} ${description ? "" : className}`.trim()}
    >
      <input
        {...rest}
        type="checkbox"
        id={id}
        className="obs-checkbox__input"
        checked={checked}
        disabled={disabled}
        aria-describedby={description ? descriptionId : undefined}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="obs-checkbox__mark" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" focusable="false">
          <path
            d="M4.5 8.25 7 10.75l4.5-5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span className="obs-checkbox__label">{label}</span>
    </label>
  );

  if (!description) return control;

  return (
    <div className={`obs-checkbox-field ${className}`.trim()}>
      {control}
      <span id={descriptionId} className="obs-checkbox__description">
        {description}
      </span>
    </div>
  );
};
