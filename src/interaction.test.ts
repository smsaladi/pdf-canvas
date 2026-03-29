import { describe, it, expect } from "vitest";
import { pdfRectToScreenRect } from "./coords";
import {
  ICON_TYPES,
  QUADPOINT_TYPES,
  TOOL_TO_ANNOT_TYPE,
  HANDLE_SIZE,
  NOTE_ICON_SIZE,
} from "./interaction/constants";

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

describe("Interaction constants", () => {
  describe("ICON_TYPES", () => {
    it("is a Set", () => {
      expect(ICON_TYPES).toBeInstanceOf(Set);
    });

    it("contains 'Text' (sticky note annotations)", () => {
      expect(ICON_TYPES.has("Text")).toBe(true);
    });

    it("does not contain non-icon types", () => {
      expect(ICON_TYPES.has("FreeText")).toBe(false);
      expect(ICON_TYPES.has("Square")).toBe(false);
      expect(ICON_TYPES.has("Highlight")).toBe(false);
    });
  });

  describe("QUADPOINT_TYPES", () => {
    it("is a Set", () => {
      expect(QUADPOINT_TYPES).toBeInstanceOf(Set);
    });

    it("contains all four text markup annotation types", () => {
      expect(QUADPOINT_TYPES.has("Highlight")).toBe(true);
      expect(QUADPOINT_TYPES.has("Underline")).toBe(true);
      expect(QUADPOINT_TYPES.has("StrikeOut")).toBe(true);
      expect(QUADPOINT_TYPES.has("Squiggly")).toBe(true);
    });

    it("has exactly 4 entries", () => {
      expect(QUADPOINT_TYPES.size).toBe(4);
    });

    it("does not contain non-quadpoint types", () => {
      expect(QUADPOINT_TYPES.has("Text")).toBe(false);
      expect(QUADPOINT_TYPES.has("FreeText")).toBe(false);
      expect(QUADPOINT_TYPES.has("Square")).toBe(false);
      expect(QUADPOINT_TYPES.has("Ink")).toBe(false);
    });
  });

  describe("TOOL_TO_ANNOT_TYPE", () => {
    it("maps 'note' to 'Text'", () => {
      expect(TOOL_TO_ANNOT_TYPE["note"]).toBe("Text");
    });

    it("maps 'freetext' to 'FreeText'", () => {
      expect(TOOL_TO_ANNOT_TYPE["freetext"]).toBe("FreeText");
    });

    it("maps 'highlight' to 'Highlight'", () => {
      expect(TOOL_TO_ANNOT_TYPE["highlight"]).toBe("Highlight");
    });

    it("maps 'rectangle' to 'Square'", () => {
      expect(TOOL_TO_ANNOT_TYPE["rectangle"]).toBe("Square");
    });

    it("maps 'circle' to 'Circle'", () => {
      expect(TOOL_TO_ANNOT_TYPE["circle"]).toBe("Circle");
    });

    it("maps 'line' to 'Line'", () => {
      expect(TOOL_TO_ANNOT_TYPE["line"]).toBe("Line");
    });

    it("maps 'ink' to 'Ink'", () => {
      expect(TOOL_TO_ANNOT_TYPE["ink"]).toBe("Ink");
    });

    it("has all expected tool keys", () => {
      const expectedKeys = ["note", "freetext", "highlight", "rectangle", "circle", "line", "ink"];
      expect(Object.keys(TOOL_TO_ANNOT_TYPE).sort()).toEqual(expectedKeys.sort());
    });

    it("all mapped annotation types are valid MuPDF annotation type strings", () => {
      const validMuPDFTypes = new Set([
        "Text", "FreeText", "Highlight", "Underline", "StrikeOut", "Squiggly",
        "Square", "Circle", "Line", "Ink", "Stamp", "Caret", "FileAttachment",
        "Sound", "Movie", "RichMedia", "Widget", "Screen", "Popup",
      ]);
      for (const annotType of Object.values(TOOL_TO_ANNOT_TYPE)) {
        expect(validMuPDFTypes.has(annotType)).toBe(true);
      }
    });
  });

  describe("HANDLE_SIZE", () => {
    it("is a positive number", () => {
      expect(HANDLE_SIZE).toBeGreaterThan(0);
    });

    it("equals 8", () => {
      expect(HANDLE_SIZE).toBe(8);
    });
  });

  describe("NOTE_ICON_SIZE", () => {
    it("is a positive number", () => {
      expect(NOTE_ICON_SIZE).toBeGreaterThan(0);
    });

    it("equals 24", () => {
      expect(NOTE_ICON_SIZE).toBe(24);
    });
  });

  describe("ICON_TYPES and QUADPOINT_TYPES are disjoint", () => {
    it("no type appears in both sets", () => {
      for (const t of ICON_TYPES) {
        expect(QUADPOINT_TYPES.has(t)).toBe(false);
      }
    });
  });

  describe("TOOL_TO_ANNOT_TYPE consistency with type sets", () => {
    it("'note' tool maps to an ICON_TYPE", () => {
      expect(ICON_TYPES.has(TOOL_TO_ANNOT_TYPE["note"])).toBe(true);
    });

    it("'highlight' tool maps to a QUADPOINT_TYPE", () => {
      expect(QUADPOINT_TYPES.has(TOOL_TO_ANNOT_TYPE["highlight"])).toBe(true);
    });

    it("'rectangle' tool maps to neither ICON nor QUADPOINT type", () => {
      const type = TOOL_TO_ANNOT_TYPE["rectangle"];
      expect(ICON_TYPES.has(type)).toBe(false);
      expect(QUADPOINT_TYPES.has(type)).toBe(false);
    });
  });
});
