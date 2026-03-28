// Integration tests: MuPDF operations via direct API (no worker thread in Node)
import { describe, it, expect } from "vitest";
import * as mupdf from "mupdf";
import * as fs from "node:fs";
import * as path from "node:path";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");

function loadFixture(name: string): mupdf.PDFDocument {
  const bytes = fs.readFileSync(path.join(FIXTURES, name));
  return new mupdf.PDFDocument(bytes);
}

describe("MuPDF WASM — document loading", () => {
  it("loads blank.pdf and reports 1 page", () => {
    const doc = loadFixture("blank.pdf");
    expect(doc.countPages()).toBe(1);
  });

  it("loads multi-page.pdf and reports 12 pages", () => {
    const doc = loadFixture("multi-page.pdf");
    expect(doc.countPages()).toBe(12);
  });

  it("returns correct page dimensions for letter-size", () => {
    const doc = loadFixture("blank.pdf");
    const page = doc.loadPage(0);
    const bounds = page.getBounds();
    // Letter: 612 x 792 points
    expect(bounds[2] - bounds[0]).toBeCloseTo(612, 0);
    expect(bounds[3] - bounds[1]).toBeCloseTo(792, 0);
  });
});

describe("MuPDF WASM — page rendering", () => {
  it("renders a page to pixmap with correct dimensions at scale=1", () => {
    const doc = loadFixture("blank.pdf");
    const page = doc.loadPage(0);
    const matrix: mupdf.Matrix = [1, 0, 0, 1, 0, 0];
    const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false);

    expect(pixmap.getWidth()).toBe(612);
    expect(pixmap.getHeight()).toBe(792);
  });

  it("renders at scale=2 with doubled dimensions", () => {
    const doc = loadFixture("blank.pdf");
    const page = doc.loadPage(0);
    const scale = 2;
    const matrix: mupdf.Matrix = [scale, 0, 0, scale, 0, 0];
    const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false);

    expect(pixmap.getWidth()).toBe(1224);
    expect(pixmap.getHeight()).toBe(1584);
  });

  it("returns RGB pixel data", () => {
    const doc = loadFixture("blank.pdf");
    const page = doc.loadPage(0);
    const matrix: mupdf.Matrix = [1, 0, 0, 1, 0, 0];
    const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false);
    const pixels = pixmap.getPixels();

    // RGB: 3 bytes per pixel
    expect(pixels.length).toBe(612 * 792 * 3);
    // Blank page should be white (255, 255, 255)
    expect(pixels[0]).toBe(255);
    expect(pixels[1]).toBe(255);
    expect(pixels[2]).toBe(255);
  });
});

describe("MuPDF WASM — annotation enumeration", () => {
  it("returns annotations from with-annotations.pdf", () => {
    const doc = loadFixture("with-annotations.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const annots = page.getAnnotations();

    // We created 4 annotations: FreeText, Square, Text, Highlight
    expect(annots.length).toBe(4);
  });

  it("returns correct annotation types", () => {
    const doc = loadFixture("with-annotations.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const annots = page.getAnnotations();
    const types = annots.map((a) => a.getType());

    expect(types).toContain("FreeText");
    expect(types).toContain("Square");
    expect(types).toContain("Text");
    expect(types).toContain("Highlight");
  });

  it("returns correct FreeText rect and contents", () => {
    const doc = loadFixture("with-annotations.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const annots = page.getAnnotations();
    const freetext = annots.find((a) => a.getType() === "FreeText")!;

    expect(freetext).toBeDefined();
    const rect = freetext.getRect();
    expect(rect[0]).toBeCloseTo(100, 0);
    expect(rect[1]).toBeCloseTo(100, 0);
    expect(freetext.getContents()).toBe("Test FreeText Annotation");
  });

  it("returns correct sticky note properties", () => {
    const doc = loadFixture("with-annotations.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const annots = page.getAnnotations();
    const note = annots.find((a) => a.getType() === "Text")!;

    expect(note).toBeDefined();
    expect(note.getContents()).toBe("Test sticky note comment");
    expect(note.getIcon()).toBe("Note");
    const color = note.getColor();
    expect(color[0]).toBeCloseTo(1, 1);
    expect(color[1]).toBeCloseTo(1, 1);
    expect(color[2]).toBeCloseTo(0, 1);
  });

  it("returns correct highlight with QuadPoints", () => {
    const doc = loadFixture("with-annotations.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const annots = page.getAnnotations();
    const hl = annots.find((a) => a.getType() === "Highlight")!;

    expect(hl).toBeDefined();
    expect(hl.getContents()).toBe("Highlighted text comment");
    expect(hl.getOpacity()).toBeCloseTo(0.5, 1);
    const quads = hl.getQuadPoints();
    expect(quads.length).toBe(1);
  });

  it("returns no annotations for blank.pdf", () => {
    const doc = loadFixture("blank.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const annots = page.getAnnotations();
    expect(annots.length).toBe(0);
  });
});

describe("MuPDF WASM — save", () => {
  it("saves to buffer producing valid PDF bytes", () => {
    const doc = loadFixture("blank.pdf");
    const buf = doc.saveToBuffer("compress");
    const bytes = buf.asUint8Array();

    expect(bytes.length).toBeGreaterThan(0);
    // Check PDF magic bytes
    const header = String.fromCharCode(...bytes.slice(0, 5));
    expect(header).toBe("%PDF-");
  });
});
