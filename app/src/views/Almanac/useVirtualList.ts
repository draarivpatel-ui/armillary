import { useState, useEffect, useCallback, type RefObject } from "react";

export interface VirtualRangeParams {
  totalCount: number;
  itemHeight: number;
  viewportHeight: number;
  scrollTop: number;
  overscan?: number;
}

export interface VirtualRange {
  startIndex: number;
  endIndex: number;
  topSpacerHeight: number;
  bottomSpacerHeight: number;
  totalHeight: number;
  visibleCount: number;
}

/**
 * Pure calculation function for virtual scroll range.
 * Given itemHeight, viewport height, and scroll position, computes
 * the visible item slice and spacer heights.
 */
export function calculateVirtualRange({
  totalCount,
  itemHeight,
  viewportHeight,
  scrollTop,
  overscan = 5,
}: VirtualRangeParams): VirtualRange {
  if (totalCount <= 0 || itemHeight <= 0) {
    return {
      startIndex: 0,
      endIndex: 0,
      topSpacerHeight: 0,
      bottomSpacerHeight: 0,
      totalHeight: 0,
      visibleCount: 0,
    };
  }

  const effectiveViewportHeight = viewportHeight > 0 ? viewportHeight : 600;
  const rawStartIndex = Math.floor(Math.max(0, scrollTop) / itemHeight);
  const visibleItems = Math.ceil(effectiveViewportHeight / itemHeight);

  const startIndex = Math.max(0, rawStartIndex - overscan);
  const endIndex = Math.min(totalCount, rawStartIndex + visibleItems + overscan);

  const topSpacerHeight = startIndex * itemHeight;
  const bottomSpacerHeight = Math.max(0, (totalCount - endIndex) * itemHeight);
  const totalHeight = totalCount * itemHeight;

  return {
    startIndex,
    endIndex,
    topSpacerHeight,
    bottomSpacerHeight,
    totalHeight,
    visibleCount: endIndex - startIndex,
  };
}

export interface VariableRangeParams {
  /** Top edge of every item, ascending (item i starts at tops[i]). */
  tops: readonly number[];
  heights: readonly number[];
  viewportHeight: number;
  scrollTop: number;
  /** Extra pixels rendered above and below the viewport. */
  overscanPx?: number;
}

export interface VariableRange {
  startIndex: number;
  /** Exclusive. */
  endIndex: number;
  topSpacerHeight: number;
  bottomSpacerHeight: number;
  totalHeight: number;
}

/**
 * Window over items of known, differing heights (the Almanac's day pages). An item is rendered when it
 * touches the viewport widened by overscanPx; the spacers stand in for everything not rendered.
 */
export function calculateVariableRange({
  tops,
  heights,
  viewportHeight,
  scrollTop,
  overscanPx = 0,
}: VariableRangeParams): VariableRange {
  const count = tops.length;
  if (count === 0) {
    return { startIndex: 0, endIndex: 0, topSpacerHeight: 0, bottomSpacerHeight: 0, totalHeight: 0 };
  }
  const totalHeight = tops[count - 1] + heights[count - 1];
  const effectiveViewport = viewportHeight > 0 ? viewportHeight : 600;
  const lo = Math.max(0, scrollTop) - overscanPx;
  const hi = Math.max(0, scrollTop) + effectiveViewport + overscanPx;

  // first item whose bottom edge is below `lo`
  let a = 0;
  let b = count;
  while (a < b) {
    const mid = (a + b) >> 1;
    if (tops[mid] + heights[mid] > lo) b = mid;
    else a = mid + 1;
  }
  const startIndex = Math.min(a, count - 1);

  // first item whose top edge is at or below `hi`
  a = startIndex;
  b = count;
  while (a < b) {
    const mid = (a + b) >> 1;
    if (tops[mid] >= hi) b = mid;
    else a = mid + 1;
  }
  const endIndex = Math.max(a, startIndex + 1);

  const topSpacerHeight = tops[startIndex];
  const bottomSpacerHeight = Math.max(0, totalHeight - (tops[endIndex - 1] + heights[endIndex - 1]));
  return { startIndex, endIndex, topSpacerHeight, bottomSpacerHeight, totalHeight };
}

export interface ScrollWindowOptions {
  containerRef?: RefObject<HTMLElement | null>;
  initialViewportHeight?: number;
}

/** Scroll position and viewport height of a scroll container, kept in state. */
export function useScrollWindow({ containerRef, initialViewportHeight = 600 }: ScrollWindowOptions) {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(initialViewportHeight);

  const syncFromElement = useCallback(() => {
    const el = containerRef?.current;
    if (!el) return;
    if (el.clientHeight > 0) setViewportHeight(el.clientHeight);
    setScrollTop(el.scrollTop);
  }, [containerRef]);

  useEffect(() => {
    const el = containerRef?.current;
    if (!el) return;

    syncFromElement();
    const handleScroll = () => setScrollTop(el.scrollTop);
    el.addEventListener("scroll", handleScroll, { passive: true });

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => syncFromElement());
      resizeObserver.observe(el);
    }
    return () => {
      el.removeEventListener("scroll", handleScroll);
      if (resizeObserver) resizeObserver.disconnect();
    };
  }, [containerRef, syncFromElement]);

  const onScroll = useCallback((e: React.UIEvent<HTMLElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
    if (e.currentTarget.clientHeight > 0) setViewportHeight(e.currentTarget.clientHeight);
  }, []);

  return { scrollTop, viewportHeight, onScroll, syncFromElement };
}

export interface UseVirtualListOptions {
  totalCount: number;
  itemHeight: number;
  overscan?: number;
  containerRef?: RefObject<HTMLElement | null>;
  initialViewportHeight?: number;
}

export function useVirtualList({
  totalCount,
  itemHeight,
  overscan = 5,
  containerRef,
  initialViewportHeight = 600,
}: UseVirtualListOptions) {
  const { scrollTop, viewportHeight, onScroll } = useScrollWindow({ containerRef, initialViewportHeight });

  const range = calculateVirtualRange({
    totalCount,
    itemHeight,
    viewportHeight,
    scrollTop,
    overscan,
  });

  return {
    ...range,
    scrollTop,
    viewportHeight,
    onScroll,
  };
}
