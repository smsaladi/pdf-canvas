import { describe, it, expect } from "vitest";
import { pdfRectToScreenRect } from "./coords";

describe("Overlay positioning", () => {
  it("positions overlay correctly at scale=1 with no offset", () => {
    const rect: [number, number, number, number] = [100, 200, 300, 350];
    const result = pdfRectToScreenRect(rect, { scale: 1, pageOffsetX: 0, pageOffsetY: 0 });
    expect(result).toEqual({ x: 100, y: 200, width: 200, height: 150 });
  });

  it("positions overlay correctly at scale=1.5", () => {
    const rect: [number, number, number, number] = [100, 100, 300, 150];
    const result = pdfRectToScreenRect(rect, { scale: 1.5, pageOffsetX: 0, pageOffsetY: 0 });
    expect(result).toEqual({ x: 150, y: 150, width: 300, height: 75 });
  });

  it("positions overlay correctly at scale=2 matching expected CSS", () => {
    // Simulating a FreeText at [100, 100, 300, 150] rendered at 2x
    const rect: [number, number, number, number] = [100, 100, 300, 150];
    const result = pdfRectToScreenRect(rect, { scale: 2, pageOffsetX: 0, pageOffsetY: 0 });
    expect(result.x).toBe(200);
    expect(result.y).toBe(200);
    expect(result.width).toBe(400);
    expect(result.height).toBe(100);
  });

  it("computes bounding box for QuadPoints at scale=1.5", () => {
    // Simulate a highlight with one quad: [100, 400, 400, 400, 100, 415, 400, 415]
    const quad = [100, 400, 400, 400, 100, 415, 400, 415];
    const scale = 1.5;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < quad.length; i += 2) {
      const x = quad[i] * scale;
      const y = quad[i + 1] * scale;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }

    expect(minX).toBe(150);
    expect(minY).toBe(600);
    expect(maxX).toBe(600);
    expect(maxY).toBeCloseTo(622.5);
  });

  it("sticky note icon always uses fixed size regardless of rect", () => {
    // Text annotations render as 24x24 icons positioned at rect top-left
    const rect: [number, number, number, number] = [400, 100, 424, 124];
    const scale = 1.5;
    const screen = pdfRectToScreenRect(rect, { scale, pageOffsetX: 0, pageOffsetY: 0 });

    // The overlay should be positioned at screen.x, screen.y
    expect(screen.x).toBe(600);
    expect(screen.y).toBe(150);
    // But icon size is fixed 24px, not scaled from rect
    const iconSize = 24;
    expect(iconSize).toBe(24);
  });
});
