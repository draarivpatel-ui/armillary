import { describe, it, expect } from "vitest";
import { calculateVirtualRange } from "../src/views/Almanac/useVirtualList";

describe("Virtual List Calculations", () => {
  it("calculates correct window for 10,000 items", () => {
    const totalCount = 10000;
    const itemHeight = 60;
    const viewportHeight = 600; // 10 items visible
    const scrollTop = 1200; // Scrolled down 20 items
    const overscan = 5;

    const range = calculateVirtualRange({
      totalCount,
      itemHeight,
      viewportHeight,
      scrollTop,
      overscan,
    });

    expect(range.startIndex).toBe(15); // 20 - 5 overscan
    expect(range.endIndex).toBe(35); // 20 + 10 visible + 5 overscan
    expect(range.topSpacerHeight).toBe(15 * 60);
    expect(range.bottomSpacerHeight).toBe((10000 - 35) * 60);
    expect(range.totalHeight).toBe(10000 * 60);
  });

  it("clamps at the start and end boundaries", () => {
    // Start boundary
    const startRange = calculateVirtualRange({
      totalCount: 10000,
      itemHeight: 50,
      viewportHeight: 500,
      scrollTop: 0,
      overscan: 5,
    });
    expect(startRange.startIndex).toBe(0);
    expect(startRange.endIndex).toBe(15);
    expect(startRange.topSpacerHeight).toBe(0);

    // End boundary
    const endRange = calculateVirtualRange({
      totalCount: 100,
      itemHeight: 50,
      viewportHeight: 500,
      scrollTop: 5000,
      overscan: 5,
    });
    expect(endRange.endIndex).toBe(100);
    expect(endRange.bottomSpacerHeight).toBe(0);
  });

  it("handles empty or 0 item lists safely", () => {
    const range = calculateVirtualRange({
      totalCount: 0,
      itemHeight: 50,
      viewportHeight: 500,
      scrollTop: 0,
      overscan: 5,
    });
    expect(range.startIndex).toBe(0);
    expect(range.endIndex).toBe(0);
    expect(range.totalHeight).toBe(0);
  });
});
