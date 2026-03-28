import { describe, it, expect } from "vitest";
import {
  pdfToScreen,
  screenToPdf,
  pdfRectToScreenRect,
  screenRectToPdfRect,
  clampZoom,
  type ViewportTransform,
} from "./coords";

describe("pdfToScreen", () => {
  it("converts at scale=1 with no offset", () => {
    const t: ViewportTransform = { scale: 1, pageOffsetX: 0, pageOffsetY: 0 };
    expect(pdfToScreen(100, 200, t)).toEqual({ x: 100, y: 200 });
  });

  it("converts at scale=2 with no offset", () => {
    const t: ViewportTransform = { scale: 2, pageOffsetX: 0, pageOffsetY: 0 };
    expect(pdfToScreen(100, 200, t)).toEqual({ x: 200, y: 400 });
  });

  it("applies page offsets", () => {
    const t: ViewportTransform = { scale: 1, pageOffsetX: 50, pageOffsetY: 100 };
    expect(pdfToScreen(100, 200, t)).toEqual({ x: 150, y: 300 });
  });

  it("handles scale + offset together", () => {
    const t: ViewportTransform = { scale: 1.5, pageOffsetX: 10, pageOffsetY: 20 };
    const result = pdfToScreen(100, 200, t);
    expect(result.x).toBeCloseTo(160);
    expect(result.y).toBeCloseTo(320);
  });
});

describe("screenToPdf", () => {
  it("converts at scale=1 with no offset", () => {
    const t: ViewportTransform = { scale: 1, pageOffsetX: 0, pageOffsetY: 0 };
    expect(screenToPdf(100, 200, t)).toEqual({ x: 100, y: 200 });
  });

  it("reverses pdfToScreen (round-trip)", () => {
    const t: ViewportTransform = { scale: 2.5, pageOffsetX: 30, pageOffsetY: 45 };
    const screen = pdfToScreen(72, 144, t);
    const pdf = screenToPdf(screen.x, screen.y, t);
    expect(pdf.x).toBeCloseTo(72);
    expect(pdf.y).toBeCloseTo(144);
  });
});

describe("pdfRectToScreenRect", () => {
  it("converts a rect at scale=1", () => {
    const t: ViewportTransform = { scale: 1, pageOffsetX: 0, pageOffsetY: 0 };
    const result = pdfRectToScreenRect([100, 100, 300, 200], t);
    expect(result).toEqual({ x: 100, y: 100, width: 200, height: 100 });
  });

  it("converts a rect at scale=2 with offset", () => {
    const t: ViewportTransform = { scale: 2, pageOffsetX: 10, pageOffsetY: 20 };
    const result = pdfRectToScreenRect([50, 50, 150, 100], t);
    expect(result).toEqual({ x: 110, y: 120, width: 200, height: 100 });
  });
});

describe("screenRectToPdfRect", () => {
  it("round-trips with pdfRectToScreenRect", () => {
    const t: ViewportTransform = { scale: 1.5, pageOffsetX: 20, pageOffsetY: 30 };
    const pdfRect: [number, number, number, number] = [100, 200, 300, 400];
    const screen = pdfRectToScreenRect(pdfRect, t);
    const result = screenRectToPdfRect(screen.x, screen.y, screen.width, screen.height, t);
    expect(result[0]).toBeCloseTo(100);
    expect(result[1]).toBeCloseTo(200);
    expect(result[2]).toBeCloseTo(300);
    expect(result[3]).toBeCloseTo(400);
  });
});

describe("clampZoom", () => {
  it("clamps below minimum", () => {
    expect(clampZoom(0.1)).toBe(0.5);
  });

  it("clamps above maximum", () => {
    expect(clampZoom(10)).toBe(4.0);
  });

  it("passes through valid values", () => {
    expect(clampZoom(1.5)).toBe(1.5);
  });

  it("passes through boundary values", () => {
    expect(clampZoom(0.5)).toBe(0.5);
    expect(clampZoom(4.0)).toBe(4.0);
  });
});
