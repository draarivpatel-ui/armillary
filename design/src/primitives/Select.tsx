import { forwardRef, useId } from "react";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  /** Required accessible name. */
  label: string;
  /** Keep the label in the DOM but hide it visually. */
  hideLabel?: boolean;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  size?: "sm" | "md";
  id?: string;
  className?: string;
  disabled?: boolean;
}

/** A design-styled native select: native keeps keyboard and screen-reader behaviour. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  (
    {
      label,
      hideLabel = false,
      value,
      onChange,
      options,
      size = "md",
      id: providedId,
      className = "",
      disabled = false,
    },
    ref
  ) => {
    const generatedId = useId();
    const id = providedId || generatedId;

    return (
      <div className={`obs-select obs-select--${size} ${className}`.trim()}>
        <label
          htmlFor={id}
          className={`obs-field-label${hideLabel ? " obs-visually-hidden" : ""}`}
        >
          {label}
        </label>
        <div className="obs-select__box">
          <select
            ref={ref}
            id={id}
            className="obs-select__control"
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          >
            {options.map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled}>
                {o.label}
              </option>
            ))}
          </select>
          <svg
            className="obs-select__chevron"
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            aria-hidden="true"
            focusable="false"
          >
            <path
              d="M1.5 3.5 5 7l3.5-3.5"
              stroke="currentColor"
              strokeWidth="1.25"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      </div>
    );
  }
);

Select.displayName = "Select";
