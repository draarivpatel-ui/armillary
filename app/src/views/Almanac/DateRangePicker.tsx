import React, { useState, useEffect, useRef } from "react";
import { Button, IconButton, ChevronDownIcon, CloseIcon } from "@orrery/design";
import { appNow } from "../../api/client";
import "./DateRangePicker.css";

export interface DateRangePickerProps {
  from?: string; // YYYY-MM-DD
  to?: string;   // YYYY-MM-DD
  onChange: (from: string, to: string) => void;
  onClear?: () => void;
  /** Matches the design Select: sm is 28 px tall, md 32 px. */
  size?: "sm" | "md";
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const SHORT_MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const WEEKDAY_NAMES = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function toISODate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseISODate(s: string): Date | null {
  if (!s) return null;
  const parts = s.split("-").map(Number);
  if (parts.length !== 3 || isNaN(parts[0]) || isNaN(parts[1]) || isNaN(parts[2])) {
    return null;
  }
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

function shortDate(d: Date): string {
  return `${SHORT_MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function formatDisplayRange(from?: string, to?: string): string {
  const fromD = from ? parseISODate(from) : null;
  const toD = to ? parseISODate(to) : null;

  if (fromD && toD) {
    if (from === to) return shortDate(fromD);
    if (fromD.getFullYear() === toD.getFullYear()) {
      return `${SHORT_MONTH_NAMES[fromD.getMonth()]} ${fromD.getDate()} to ${shortDate(toD)}`;
    }
    return `${shortDate(fromD)} to ${shortDate(toD)}`;
  }
  if (fromD) return `From ${shortDate(fromD)}`;
  if (toD) return `Through ${shortDate(toD)}`;
  return "All dates";
}

export const DateRangePicker: React.FC<DateRangePickerProps> = ({
  from = "",
  to = "",
  onChange,
  onClear,
  size = "sm",
}) => {
  const [isOpen, setIsOpen] = useState(false);

  // Default month view is based on active selection or today (the app clock)
  const initialDate = parseISODate(from) || parseISODate(to) || new Date(appNow());
  const [viewYear, setViewYear] = useState(initialDate.getFullYear());
  const [viewMonth, setViewMonth] = useState(initialDate.getMonth()); // 0-11
  const [focusedDay, setFocusedDay] = useState(initialDate.getDate());

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  /** Set when the keyboard (or opening) should move focus onto the focused day cell. */
  const focusDayRef = useRef(false);

  // Sync view when from changes externally
  useEffect(() => {
    if (from) {
      const d = parseISODate(from);
      if (d) {
        setViewYear(d.getFullYear());
        setViewMonth(d.getMonth());
        setFocusedDay(d.getDate());
      }
    }
  }, [from]);

  // Click outside listener
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  // Move focus onto the focused day when the popover opens or an arrow key moves it
  useEffect(() => {
    if (!isOpen || !focusDayRef.current) return;
    focusDayRef.current = false;
    const iso = toISODate(new Date(viewYear, viewMonth, focusedDay));
    const cell = popoverRef.current?.querySelector<HTMLElement>(`[data-date="${iso}"]`);
    cell?.focus();
  });

  const closeToTrigger = () => {
    setIsOpen(false);
    triggerRef.current?.focus();
  };

  const handleTogglePopover = () => {
    if (!isOpen) focusDayRef.current = true;
    setIsOpen((prev) => !prev);
  };

  const handlePrevMonth = () => {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear((y) => y - 1);
    } else {
      setViewMonth((m) => m - 1);
    }
  };

  const handleNextMonth = () => {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear((y) => y + 1);
    } else {
      setViewMonth((m) => m + 1);
    }
  };

  const handleClear = () => {
    if (onClear) onClear();
    else onChange("", "");
  };

  const handleDayClick = (iso: string) => {
    if (!from || (from && to)) {
      // Start a new selection
      onChange(iso, "");
    } else {
      // Pick second date
      if (iso < from) {
        onChange(iso, from);
      } else {
        onChange(from, iso);
      }
    }
  };

  const handlePreset = (type: "today" | "last7" | "last30" | "all") => {
    const today = new Date(appNow());
    const todayIso = toISODate(today);

    if (type === "today") {
      onChange(todayIso, todayIso);
    } else if (type === "last7") {
      const past = new Date(today);
      past.setDate(past.getDate() - 6);
      onChange(toISODate(past), todayIso);
    } else if (type === "last30") {
      const past = new Date(today);
      past.setDate(past.getDate() - 29);
      onChange(toISODate(past), todayIso);
    } else if (type === "all") {
      handleClear();
    }
    setIsOpen(false);
  };

  // Escape closes from anywhere inside the control, trigger included, and hands focus back to the trigger.
  const handleControlKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && isOpen) {
      e.preventDefault();
      e.stopPropagation();
      closeToTrigger();
    }
  };

  const handlePopoverKeyDown = (e: React.KeyboardEvent) => {
    // Arrow keys move between days; Enter and Space are the day button's own click.
    if (!(e.target as HTMLElement).closest("[data-date]")) return;
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    let next: number | null = null;

    if (e.key === "ArrowLeft") next = focusedDay > 1 ? focusedDay - 1 : daysInMonth;
    else if (e.key === "ArrowRight") next = focusedDay < daysInMonth ? focusedDay + 1 : 1;
    else if (e.key === "ArrowUp") next = focusedDay > 7 ? focusedDay - 7 : focusedDay;
    else if (e.key === "ArrowDown") next = focusedDay + 7 <= daysInMonth ? focusedDay + 7 : focusedDay;
    if (next === null) return;

    e.preventDefault();
    focusDayRef.current = true;
    setFocusedDay(next);
  };

  // Calendar calculations
  const firstDayOfWeek = new Date(viewYear, viewMonth, 1).getDay();
  const totalDaysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const todayIso = toISODate(new Date(appNow()));
  const active = Boolean(from || to);
  const display = formatDisplayRange(from, to);

  const cells: Array<number | null> = [
    ...Array.from({ length: firstDayOfWeek }, () => null),
    ...Array.from({ length: totalDaysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: Array<Array<number | null>> = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  return (
    <div
      className={`obs-date-range-control obs-date-range-control--${size}`}
      ref={containerRef}
      onKeyDown={handleControlKeyDown}
    >
      <div className="obs-date-range-field">
        <button
          ref={triggerRef}
          type="button"
          className={`obs-date-range-trigger${active ? " obs-date-range-trigger--clearable" : ""}`}
          aria-label={`Date range: ${display}`}
          title={display}
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          onClick={handleTogglePopover}
        >
          <span className="obs-date-range-label">{display}</span>
          <span className="obs-date-range-chevron" aria-hidden="true">
            <ChevronDownIcon size={14} />
          </span>
        </button>
        {active && (
          <button type="button" className="obs-date-range-clear" aria-label="Clear dates" onClick={handleClear}>
            <CloseIcon size={12} />
          </button>
        )}
      </div>

      {isOpen && (
        <div
          ref={popoverRef}
          className="obs-date-range-popover"
          data-testid="date-range-popover"
          role="dialog"
          aria-label="Calendar date range picker"
          tabIndex={-1}
          onKeyDown={handlePopoverKeyDown}
        >
          <div className="obs-date-range-nav-header">
            <IconButton
              className="obs-date-range-nav-btn obs-date-range-nav-btn--prev"
              aria-label="Previous month"
              onClick={handlePrevMonth}
            >
              <ChevronDownIcon size={16} />
            </IconButton>
            <div className="obs-date-range-month-title" data-testid="calendar-month-heading">
              {MONTH_NAMES[viewMonth]} {viewYear}
            </div>
            <IconButton
              className="obs-date-range-nav-btn obs-date-range-nav-btn--next"
              aria-label="Next month"
              onClick={handleNextMonth}
            >
              <ChevronDownIcon size={16} />
            </IconButton>
          </div>

          <div className="obs-calendar-grid" role="grid" aria-label="Month days">
            <div className="obs-calendar-week" role="row">
              {WEEKDAY_NAMES.map((name) => (
                <div key={name} className="obs-calendar-weekday" role="columnheader">
                  {name}
                </div>
              ))}
            </div>

            {weeks.map((week, w) => (
              <div key={w} className="obs-calendar-week" role="row">
                {week.map((dayNum, i) => {
                  if (dayNum === null) {
                    return <div key={`empty-${i}`} className="obs-calendar-day-empty" role="gridcell" aria-hidden="true" />;
                  }
                  const iso = toISODate(new Date(viewYear, viewMonth, dayNum));

                  const isSelected = iso === from || iso === to;
                  const isInRange = Boolean(from && to && iso > from && iso < to);
                  const isToday = iso === todayIso;

                  const classNames = [
                    "obs-calendar-day",
                    isSelected ? "obs-calendar-day--selected" : "",
                    isInRange ? "obs-calendar-day--in-range" : "",
                    isToday ? "obs-calendar-day--today" : "",
                  ]
                    .filter(Boolean)
                    .join(" ");

                  return (
                    <button
                      key={iso}
                      type="button"
                      role="gridcell"
                      className={classNames}
                      data-date={iso}
                      tabIndex={dayNum === focusedDay ? 0 : -1}
                      aria-selected={isSelected || isInRange}
                      aria-current={isToday ? "date" : undefined}
                      aria-label={`${MONTH_NAMES[viewMonth]} ${dayNum}, ${viewYear}`}
                      onClick={() => {
                        handleDayClick(iso);
                        setFocusedDay(dayNum);
                      }}
                    >
                      {dayNum}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          <div className="obs-date-range-presets">
            <Button variant="ghost" size="sm" onClick={() => handlePreset("today")}>
              Today
            </Button>
            <Button variant="ghost" size="sm" onClick={() => handlePreset("last7")}>
              Last 7 days
            </Button>
            <Button variant="ghost" size="sm" onClick={() => handlePreset("last30")}>
              Last 30 days
            </Button>
            <Button variant="ghost" size="sm" onClick={() => handlePreset("all")}>
              All time
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
