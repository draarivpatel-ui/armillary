import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export interface VirtualOptions {
  count: number;
  estimate: number;
  overscan: number;
  /** Used when the container has no layout yet (server render, jsdom). */
  fallbackViewport: number;
  enabled: boolean;
}

export interface VirtualList {
  scrollRef: (node: HTMLElement | null) => void;
  measure: (index: number) => (node: HTMLElement | null) => void;
  totalHeight: number;
  offsetOf: (index: number) => number;
  first: number;
  last: number;
  range: number[];
  scrollToIndex: (index: number) => void;
}

/** Windowed list with measured heights and a per-item estimate for anything not on screen. */
export function useVirtualList(options: VirtualOptions): VirtualList {
  const { count, estimate, overscan, fallbackViewport, enabled } = options;
  const containerRef = useRef<HTMLElement | null>(null);
  const heights = useRef<Map<number, number>>(new Map());
  const offsets = useRef<number[]>([]);
  const scrollPosition = useRef(0);
  const viewport = useRef(fallbackViewport);
  const [window, setWindow] = useState<{ first: number; last: number }>({
    first: 0,
    last: enabled ? Math.min(count, Math.ceil(fallbackViewport / estimate) + overscan * 2) : count,
  });

  const computeOffsets = useCallback(() => {
    const table: number[] = new Array(count + 1);
    table[0] = 0;
    for (let index = 0; index < count; index++) {
      table[index + 1] = table[index] + (heights.current.get(index) ?? estimate);
    }
    offsets.current = table;
  }, [count, estimate]);

  const recompute = useCallback(() => {
    if (count === 0) {
      setWindow({ first: 0, last: 0 });
      return;
    }
    const table = offsets.current;
    const top = scrollPosition.current;
    const bottom = top + viewport.current;

    let first = 0;
    while (first < count - 1 && table[first + 1] <= top) first++;
    let last = first;
    while (last < count && table[last] < bottom) last++;

    const nextFirst = Math.max(0, first - overscan);
    const nextLast = Math.min(count, last + overscan);
    setWindow((previous) =>
      previous.first === nextFirst && previous.last === nextLast ? previous : { first: nextFirst, last: nextLast },
    );
  }, [count, overscan]);

  const handleScroll = useCallback(() => {
    const node = containerRef.current;
    if (!node) return;
    scrollPosition.current = node.scrollTop;
    const measured = node.clientHeight;
    if (measured > 0) viewport.current = measured;
    if (enabled) recompute();
  }, [enabled, recompute]);

  const scrollRef = useCallback(
    (node: HTMLElement | null) => {
      if (node === containerRef.current) return;
      if (containerRef.current) containerRef.current.removeEventListener("scroll", handleScroll);
      containerRef.current = node;
      if (node) {
        node.addEventListener("scroll", handleScroll);
        const measured = node.clientHeight;
        viewport.current = measured > 0 ? measured : fallbackViewport;
        scrollPosition.current = node.scrollTop;
        if (enabled) recompute();
      }
    },
    [enabled, fallbackViewport, handleScroll, recompute],
  );

  const measure = useCallback(
    (index: number) => (node: HTMLElement | null) => {
      if (!node) return;
      const height = node.offsetHeight;
      if (height <= 0) return;
      if (heights.current.get(index) === height) return;
      heights.current.set(index, height);
      computeOffsets();
      if (enabled) recompute();
    },
    [computeOffsets, enabled, recompute],
  );

  useLayoutEffect(() => {
    computeOffsets();
    recompute();
  }, [computeOffsets, recompute]);

  useEffect(() => {
    heights.current = new Map();
    computeOffsets();
    recompute();
  }, [count, computeOffsets, recompute]);

  const scrollToIndex = useCallback(
    (index: number) => {
      const node = containerRef.current;
      if (!node) return;
      const target = Math.max(0, (offsets.current[index] ?? 0) - 8);
      node.scrollTop = target;
      scrollPosition.current = target;
      recompute();
    },
    [recompute],
  );

  const range: number[] = [];
  for (let index = window.first; index < window.last; index++) range.push(index);

  return {
    scrollRef,
    measure,
    totalHeight: offsets.current[count] ?? 0,
    offsetOf: (index: number) => offsets.current[index] ?? 0,
    first: window.first,
    last: window.last,
    range,
    scrollToIndex,
  };
}
