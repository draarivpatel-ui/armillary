import React, { useRef } from "react";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
  title?: string;
}

export interface SegmentedControlProps<T extends string> {
  /** Accessible name of the group. */
  label: string;
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: "sm" | "md";
  className?: string;
  /** When false, each segment shows only its icon and uses the option label as aria-label. */
  showLabels?: boolean;
}

export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  size = "md",
  className = "",
  showLabels = true,
}: SegmentedControlProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = options.findIndex((o) => o.value === value);
  // If nothing matches, keep the group reachable by making the first segment tabbable.
  const tabbableIndex = selectedIndex >= 0 ? selectedIndex : 0;

  const moveTo = (index: number) => {
    const next = options[index];
    if (!next) return;
    onChange(next.value);
    refs.current[index]?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = options.length - 1;
    let target: number | null = null;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        target = index >= last ? 0 : index + 1;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        target = index <= 0 ? last : index - 1;
        break;
      case "Home":
        target = 0;
        break;
      case "End":
        target = last;
        break;
      default:
        return;
    }
    e.preventDefault();
    moveTo(target);
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`obs-segmented obs-segmented--${size} ${className}`.trim()}
    >
      {options.map((o, i) => {
        const selected = i === selectedIndex;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={showLabels ? undefined : o.label}
            title={o.title}
            tabIndex={i === tabbableIndex ? 0 : -1}
            className={`obs-segment${selected ? " obs-segment--selected" : ""}`}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => handleKeyDown(e, i)}
          >
            {o.icon && (
              <span className="obs-segment__icon" aria-hidden="true">
                {o.icon}
              </span>
            )}
            {showLabels && <span className="obs-segment__label">{o.label}</span>}
          </button>
        );
      })}
    </div>
  );
}
