import React, { useEffect, useId, useRef } from "react";
import { IconButton } from "./IconButton";

export interface DialogProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}

const FOCUSABLE_SELECTORS = [
  "a[href]",
  "area[href]",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "button:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

export const Dialog: React.FC<DialogProps> = ({
  isOpen,
  onClose,
  title,
  children,
  footer,
  className = "",
}) => {
  const titleId = useId();
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  // Store opener element when opening
  useEffect(() => {
    if (isOpen) {
      if (document.activeElement instanceof HTMLElement) {
        openerRef.current = document.activeElement;
      }
    }
  }, [isOpen]);

  // Focus restoration upon closing or unmounting
  useEffect(() => {
    return () => {
      if (openerRef.current && typeof openerRef.current.focus === "function") {
        openerRef.current.focus();
      }
    };
  }, []);

  const prevOpenRef = useRef(isOpen);
  useEffect(() => {
    if (prevOpenRef.current && !isOpen) {
      if (openerRef.current && typeof openerRef.current.focus === "function") {
        openerRef.current.focus();
      }
    }
    prevOpenRef.current = isOpen;
  }, [isOpen]);

  // Focus trapping and Escape key handling
  useEffect(() => {
    if (!isOpen) return;

    const getFocusableElements = (): HTMLElement[] => {
      if (!dialogRef.current) return [];
      return Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS)
      ).filter(
        (el) =>
          !el.hasAttribute("disabled") &&
          el.getAttribute("aria-hidden") !== "true"
      );
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }

      if (e.key === "Tab") {
        const focusables = getFocusableElements();
        if (focusables.length === 0) {
          e.preventDefault();
          dialogRef.current?.focus();
          return;
        }

        const firstEl = focusables[0];
        const lastEl = focusables[focusables.length - 1];
        const currentEl = document.activeElement;

        if (e.shiftKey) {
          if (currentEl === firstEl || currentEl === dialogRef.current) {
            e.preventDefault();
            lastEl.focus();
          }
        } else {
          if (currentEl === lastEl) {
            e.preventDefault();
            firstEl.focus();
          }
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    // Initial focus
    const focusTimer = setTimeout(() => {
      const focusables = getFocusableElements();
      if (focusables.length > 0) {
        focusables[0].focus();
      } else {
        dialogRef.current?.focus();
      }
    }, 0);

    return () => {
      clearTimeout(focusTimer);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  // Background inertness: mark background elements inert while open
  useEffect(() => {
    if (!isOpen || !overlayRef.current) return;

    const toRestore: Array<{
      el: HTMLElement;
      prevInert: boolean;
      prevAriaHidden: string | null;
    }> = [];

    let node: HTMLElement | null = overlayRef.current;
    while (node && node.parentElement && node.parentElement !== document.documentElement) {
      const parent: HTMLElement = node.parentElement;
      const children = Array.from(parent.children) as HTMLElement[];
      for (const child of children) {
        if (child !== node && !child.contains(node)) {
          toRestore.push({
            el: child,
            prevInert: (child as any).inert ?? child.hasAttribute("inert"),
            prevAriaHidden: child.getAttribute("aria-hidden"),
          });
          (child as any).inert = true;
          child.setAttribute("inert", "");
          child.setAttribute("aria-hidden", "true");
        }
      }
      node = parent;
    }

    return () => {
      for (const item of toRestore) {
        if (item.prevInert) {
          (item.el as any).inert = true;
          item.el.setAttribute("inert", "");
        } else {
          (item.el as any).inert = false;
          item.el.removeAttribute("inert");
        }

        if (item.prevAriaHidden !== null) {
          item.el.setAttribute("aria-hidden", item.prevAriaHidden);
        } else {
          item.el.removeAttribute("aria-hidden");
        }
      }
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      ref={overlayRef}
      className="obs-dialog-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`obs-dialog ${className}`.trim()}
      >
        <header className="obs-dialog__header">
          <h2 id={titleId} className="obs-dialog__title">
            {title}
          </h2>
          <IconButton aria-label="Close dialog" onClick={onClose}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            >
              <line x1="3" y1="3" x2="13" y2="13" />
              <line x1="13" y1="3" x2="3" y2="13" />
            </svg>
          </IconButton>
        </header>
        <div className="obs-dialog__body">{children}</div>
        {footer && <footer className="obs-dialog__footer">{footer}</footer>}
      </div>
    </div>
  );
};
