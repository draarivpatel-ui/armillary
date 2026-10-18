import "@testing-library/jest-dom";

// Canvas stub to silence jsdom "HTMLCanvasElement.prototype.getContext not implemented" warning
if (typeof HTMLCanvasElement !== "undefined") {
  const originalGetContext = HTMLCanvasElement.prototype.getContext;

  HTMLCanvasElement.prototype.getContext = function (
    this: HTMLCanvasElement,
    contextId: string,
    ...args: any[]
  ) {
    if (contextId === "2d") {
      return {
        canvas: this,
        fillRect: () => {},
        clearRect: () => {},
        getImageData: (_x = 0, _y = 0, w = 1, h = 1) => ({
          data: new Uint8ClampedArray(w * h * 4),
          width: w,
          height: h,
        }),
        putImageData: () => {},
        createImageData: () => [],
        setTransform: () => {},
        drawImage: () => {},
        save: () => {},
        fillText: () => {},
        strokeText: () => {},
        restore: () => {},
        beginPath: () => {},
        moveTo: () => {},
        lineTo: () => {},
        closePath: () => {},
        stroke: () => {},
        translate: () => {},
        scale: () => {},
        rotate: () => {},
        arc: () => {},
        arcTo: () => {},
        fill: () => {},
        measureText: (text = "") => ({
          width: text.length * 8,
          actualBoundingBoxAscent: 8,
          actualBoundingBoxDescent: 2,
        }),
        transform: () => {},
        rect: () => {},
        clip: () => {},
        resetTransform: () => {},
        createLinearGradient: () => ({
          addColorStop: () => {},
        }),
        createRadialGradient: () => ({
          addColorStop: () => {},
        }),
        createPattern: () => null,
        // Methods the Orrery renderer draws with (so the real controller runs in view tests).
        ellipse: () => {},
        setLineDash: () => {},
        getLineDash: () => [],
        quadraticCurveTo: () => {},
        bezierCurveTo: () => {},
        strokeRect: () => {},
      } as unknown as CanvasRenderingContext2D;
    }
    return originalGetContext ? originalGetContext.apply(this, [contextId, ...args] as any) : null;
  } as any;

  if (!HTMLCanvasElement.prototype.toDataURL) {
    HTMLCanvasElement.prototype.toDataURL = () => "";
  }
}

// In-memory localStorage fallback for jsdom environments where window.localStorage is missing
if (typeof window !== "undefined" && !window.localStorage) {
  const store = new Map<string, string>();
  const mockStorage: Storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, String(value)),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(window, "localStorage", {
    value: mockStorage,
    writable: true,
  });
}
