import { describe, it, expect } from "vitest";
import { pointInQuad, hitTestText } from "./text-layer";
import type { PageTextData } from "./types";

describe("pointInQuad", () => {
  it("returns true for point inside quad", () => {
    // Quad: upper-left, upper-right, lower-left, lower-right
    const quad: [number, number, number, number, number, number, number, number] =
      [100, 200, 120, 200, 100, 215, 120, 215];
    expect(pointInQuad(110, 210, quad)).toBe(true);
  });

  it("returns false for point outside quad", () => {
    const quad: [number, number, number, number, number, number, number, number] =
      [100, 200, 120, 200, 100, 215, 120, 215];
    expect(pointInQuad(50, 210, quad)).toBe(false);
    expect(pointInQuad(110, 100, quad)).toBe(false);
  });

  it("returns true for point on boundary", () => {
    const quad: [number, number, number, number, number, number, number, number] =
      [100, 200, 120, 200, 100, 215, 120, 215];
    expect(pointInQuad(100, 200, quad)).toBe(true);
  });
});

describe("hitTestText", () => {
  const mockData: PageTextData = {
    page: 0,
    blocks: [{
      bbox: [50, 100, 400, 140],
      lines: [{
        bbox: [50, 100, 400, 120],
        wmode: 0,
        chars: [
          { c: "H", origin: [50, 115], quad: [50, 100, 65, 100, 50, 120, 65, 120], fontSize: 12, fontName: "Helvetica", fontFlags: { isMono: false, isSerif: false, isBold: false, isItalic: false }, color: [0, 0, 0] },
          { c: "i", origin: [65, 115], quad: [65, 100, 72, 100, 65, 120, 72, 120], fontSize: 12, fontName: "Helvetica", fontFlags: { isMono: false, isSerif: false, isBold: false, isItalic: false }, color: [0, 0, 0] },
        ],
      }],
    }],
  };

  it("finds character at correct position", () => {
    const hit = hitTestText(mockData, 55, 110);
    expect(hit).not.toBeNull();
    expect(hit!.info.c).toBe("H");
    expect(hit!.block).toBe(0);
    expect(hit!.line).toBe(0);
    expect(hit!.charIdx).toBe(0);
  });

  it("finds second character", () => {
    const hit = hitTestText(mockData, 68, 110);
    expect(hit).not.toBeNull();
    expect(hit!.info.c).toBe("i");
    expect(hit!.charIdx).toBe(1);
  });

  it("returns null for miss", () => {
    const hit = hitTestText(mockData, 10, 10);
    expect(hit).toBeNull();
  });

  it("returns null for empty data", () => {
    const hit = hitTestText({ page: 0, blocks: [] }, 55, 110);
    expect(hit).toBeNull();
  });
});
