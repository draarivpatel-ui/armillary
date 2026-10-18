import { useCallback, useEffect, useRef, useState } from "react";

export interface ScrollEdges {
  /** The content is wider than the box, so the box scrolls sideways. */
  scrollable: boolean;
  atStart: boolean;
  atEnd: boolean;
}

/** Tracks whether an element scrolls sideways and which edges still hide content (for the edge fades). */
export function useScrollEdges<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [edges, setEdges] = useState<ScrollEdges>({ scrollable: false, atStart: true, atEnd: true });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const next: ScrollEdges = {
      scrollable: max > 1,
      atStart: el.scrollLeft <= 1,
      atEnd: el.scrollLeft >= max - 1,
    };
    setEdges((prev) =>
      prev.scrollable === next.scrollable && prev.atStart === next.atStart && prev.atEnd === next.atEnd ? prev : next,
    );
  }, []);

  useEffect(() => {
    measure();
    const el = ref.current;
    el?.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" || !el ? null : new ResizeObserver(measure);
    if (el) observer?.observe(el);
    return () => {
      el?.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [measure]);

  return { ref, edges, measure };
}
