import React from "react";

export interface FilterChipProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "type" | "onClick" | "onToggle" | "disabled" | "className" | "children"> {
  label: string;
  selected: boolean;
  onToggle: (next: boolean) => void;
  count?: number;
  icon?: React.ReactNode;
  disabled?: boolean;
  className?: string;
}

export const FilterChip: React.FC<FilterChipProps> = ({
  label,
  selected,
  onToggle,
  count,
  icon,
  disabled = false,
  className = "",
  ...rest
}) => (
  <button
    {...rest}
    type="button"
    aria-pressed={selected}
    disabled={disabled}
    className={`obs-chip${selected ? " obs-chip--selected" : ""} ${className}`.trim()}
    onClick={() => onToggle(!selected)}
  >
    {selected && <span className="obs-chip__pip" aria-hidden="true" />}
    {icon && (
      <span className="obs-chip__icon" aria-hidden="true">
        {icon}
      </span>
    )}
    <span className="obs-chip__label">{label}</span>
    {count !== undefined && <span className="obs-chip__count">{count}</span>}
  </button>
);
