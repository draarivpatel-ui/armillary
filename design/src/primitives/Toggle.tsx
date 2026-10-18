import React, { useId } from "react";

export interface ToggleProps {
  label?: string;
  checked: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  id?: string;
}

export const Toggle: React.FC<ToggleProps> = ({
  label,
  checked,
  onChange,
  disabled = false,
  className = "",
  id: providedId,
}) => {
  const generatedId = useId();
  const id = providedId || generatedId;

  const handleClick = () => {
    if (!disabled) {
      onChange?.(!checked);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      onChange?.(!checked);
    }
  };

  return (
    <label htmlFor={id} className={`obs-toggle-container ${className}`.trim()}>
      <button
        type="button"
        role="switch"
        id={id}
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        className="obs-toggle"
      >
        <span className="obs-toggle__thumb" />
      </button>
      {label && <span className="obs-toggle__label">{label}</span>}
    </label>
  );
};
