import { describe, it, expect } from "vitest";

describe("Canvas Stub (app test setup)", () => {
  it("provides a working 2d canvas context stub that silences jsdom not implemented noise", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 300;
    canvas.height = 150;

    const ctx = canvas.getContext("2d");
    expect(ctx).not.toBeNull();
    expect(typeof ctx?.fillRect).toBe("function");
    expect(typeof ctx?.clearRect).toBe("function");
    expect(typeof ctx?.beginPath).toBe("function");
    expect(typeof ctx?.arc).toBe("function");
    expect(typeof ctx?.fill).toBe("function");
    expect(typeof ctx?.stroke).toBe("function");

    // Calling context methods should execute cleanly without throwing
    expect(() => {
      ctx?.fillRect(0, 0, 100, 100);
      ctx?.beginPath();
      ctx?.arc(50, 50, 20, 0, Math.PI * 2);
      ctx?.fill();
    }).not.toThrow();
  });
});
