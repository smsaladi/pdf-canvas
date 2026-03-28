// Integration tests: annotation round-trip verification
import { describe, it, expect } from "vitest";
import * as mupdf from "mupdf";
import * as fs from "node:fs";
import * as path from "node:path";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");

function loadFixture(name: string): mupdf.PDFDocument {
  const bytes = fs.readFileSync(path.join(FIXTURES, name));
  return new mupdf.PDFDocument(bytes);
}

describe("Annotation DTO extraction matches fixture content", () => {
  it("with-annotations.pdf has 4 annotations with correct types and properties", () => {
    const doc = loadFixture("with-annotations.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const annots = page.getAnnotations();

    expect(annots.length).toBe(4);

    // Build a map by type for easy lookup
    const byType = new Map<string, mupdf.PDFAnnotation>();
    for (const a of annots) {
      byType.set(a.getType(), a);
    }

    // FreeText
    const ft = byType.get("FreeText")!;
    expect(ft).toBeDefined();
    expect(ft.getContents()).toBe("Test FreeText Annotation");
    const ftRect = ft.getRect();
    expect(ftRect[0]).toBeCloseTo(100, 0);
    expect(ftRect[1]).toBeCloseTo(100, 0);
    const ftColor = ft.getColor();
    expect(ftColor[0]).toBeCloseTo(1, 1); // red
    expect(ft.hasRect()).toBe(true);

    // Square
    const sq = byType.get("Square")!;
    expect(sq).toBeDefined();
    const sqRect = sq.getRect();
    expect(sqRect[0]).toBeCloseTo(100, 0);
    expect(sqRect[1]).toBeCloseTo(200, 0);
    expect(sqRect[2]).toBeCloseTo(250, 0);
    expect(sqRect[3]).toBeCloseTo(300, 0);
    expect(sq.getBorderWidth()).toBe(2);
    expect(sq.hasRect()).toBe(true);

    // Text (sticky note)
    const note = byType.get("Text")!;
    expect(note).toBeDefined();
    expect(note.getContents()).toBe("Test sticky note comment");
    expect(note.getIcon()).toBe("Note");

    // Highlight
    const hl = byType.get("Highlight")!;
    expect(hl).toBeDefined();
    expect(hl.getContents()).toBe("Highlighted text comment");
    expect(hl.getOpacity()).toBeCloseTo(0.5, 1);
    expect(hl.hasQuadPoints()).toBe(true);
    const quads = hl.getQuadPoints();
    expect(quads.length).toBe(1);
  });

  it("with-comments.pdf has annotations with author metadata", () => {
    const doc = loadFixture("with-comments.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const annots = page.getAnnotations();

    expect(annots.length).toBe(3);

    const note1 = annots.find(a => a.getContents() === "First comment — please review")!;
    expect(note1).toBeDefined();
    expect(note1.getAuthor()).toBe("Alice");
    expect(note1.getType()).toBe("Text");

    const note2 = annots.find(a => a.getContents() === "Second comment — looks good")!;
    expect(note2).toBeDefined();
    expect(note2.getAuthor()).toBe("Bob");
    expect(note2.getIcon()).toBe("Comment");

    const hl = annots.find(a => a.getType() === "Highlight")!;
    expect(hl).toBeDefined();
    expect(hl.getAuthor()).toBe("Alice");
    expect(hl.getContents()).toBe("Important section highlighted");
  });

  it("multi-page.pdf has annotation on page 5 only", () => {
    const doc = loadFixture("multi-page.pdf");

    // Pages 0-3 should have no annotations
    for (let i = 0; i < 4; i++) {
      const page = doc.loadPage(i) as mupdf.PDFPage;
      expect(page.getAnnotations().length).toBe(0);
    }

    // Page 4 (5th page, 0-indexed) should have 1 annotation
    const page4 = doc.loadPage(4) as mupdf.PDFPage;
    const annots = page4.getAnnotations();
    expect(annots.length).toBe(1);
    expect(annots[0].getContents()).toBe("Note on page 5");

    // Pages 5+ should have no annotations
    for (let i = 5; i < 12; i++) {
      const page = doc.loadPage(i) as mupdf.PDFPage;
      expect(page.getAnnotations().length).toBe(0);
    }
  });
});

describe("Moving an annotation persists through save/reload", () => {
  it("setRect round-trip for FreeText annotation", () => {
    const doc = loadFixture("with-annotations.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const annots = page.getAnnotations();
    const freetext = annots.find(a => a.getType() === "FreeText")!;

    const originalRect = freetext.getRect();
    const newRect: mupdf.Rect = [
      originalRect[0] + 50,
      originalRect[1] + 30,
      originalRect[2] + 50,
      originalRect[3] + 30,
    ];
    freetext.setRect(newRect);

    // Save
    const savedBuf = doc.saveToBuffer("incremental");
    const savedBytes = savedBuf.asUint8Array();

    // Reopen
    const doc2 = new mupdf.PDFDocument(savedBytes);
    const page2 = doc2.loadPage(0) as mupdf.PDFPage;
    const annots2 = page2.getAnnotations();
    const freetext2 = annots2.find(a => a.getType() === "FreeText")!;

    const reloadedRect = freetext2.getRect();
    expect(reloadedRect[0]).toBeCloseTo(newRect[0], 1);
    expect(reloadedRect[1]).toBeCloseTo(newRect[1], 1);
    expect(reloadedRect[2]).toBeCloseTo(newRect[2], 1);
    expect(reloadedRect[3]).toBeCloseTo(newRect[3], 1);
  });

  it("setColor round-trip for Square annotation", () => {
    const doc = loadFixture("with-annotations.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const square = page.getAnnotations().find(a => a.getType() === "Square")!;

    square.setColor([1, 0, 0]);
    square.update();

    const buf = doc.saveToBuffer("incremental");
    const doc2 = new mupdf.PDFDocument(buf.asUint8Array());
    const square2 = (doc2.loadPage(0) as mupdf.PDFPage).getAnnotations().find(a => a.getType() === "Square")!;

    const color = square2.getColor();
    expect(color[0]).toBeCloseTo(1, 1);
    expect(color[1]).toBeCloseTo(0, 1);
    expect(color[2]).toBeCloseTo(0, 1);
  });

  it("setContents round-trip for Text annotation", () => {
    const doc = loadFixture("with-annotations.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const note = page.getAnnotations().find(a => a.getType() === "Text")!;

    note.setContents("Updated comment text");
    note.update();

    const buf = doc.saveToBuffer("incremental");
    const doc2 = new mupdf.PDFDocument(buf.asUint8Array());
    const note2 = (doc2.loadPage(0) as mupdf.PDFPage).getAnnotations().find(a => a.getType() === "Text")!;

    expect(note2.getContents()).toBe("Updated comment text");
  });

  it("setOpacity round-trip for Highlight annotation", () => {
    const doc = loadFixture("with-annotations.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const hl = page.getAnnotations().find(a => a.getType() === "Highlight")!;

    hl.setOpacity(0.8);
    hl.update();

    const buf = doc.saveToBuffer("incremental");
    const doc2 = new mupdf.PDFDocument(buf.asUint8Array());
    const hl2 = (doc2.loadPage(0) as mupdf.PDFPage).getAnnotations().find(a => a.getType() === "Highlight")!;

    expect(hl2.getOpacity()).toBeCloseTo(0.8, 1);
  });

  it("shifting QuadPoints moves Highlight annotation", () => {
    const doc = loadFixture("with-annotations.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const hl = page.getAnnotations().find(a => a.getType() === "Highlight")!;

    const originalQuads = hl.getQuadPoints();
    const dx = 20, dy = 10;
    const newQuads = originalQuads.map(q => {
      const shifted = [...q] as mupdf.Quad;
      for (let i = 0; i < shifted.length; i += 2) {
        shifted[i] += dx;
        shifted[i + 1] += dy;
      }
      return shifted;
    });

    hl.setQuadPoints(newQuads);
    hl.update();

    const buf = doc.saveToBuffer("incremental");
    const doc2 = new mupdf.PDFDocument(buf.asUint8Array());
    const hl2 = (doc2.loadPage(0) as mupdf.PDFPage).getAnnotations().find(a => a.getType() === "Highlight")!;

    const reloadedQuads = hl2.getQuadPoints();
    expect(reloadedQuads.length).toBe(originalQuads.length);
    // Check first point shifted correctly
    expect(reloadedQuads[0][0]).toBeCloseTo(originalQuads[0][0] + dx, 0);
    expect(reloadedQuads[0][1]).toBeCloseTo(originalQuads[0][1] + dy, 0);
  });

  it("deleteAnnotation removes annotation from page", () => {
    const doc = loadFixture("with-annotations.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const annots = page.getAnnotations();
    const initialCount = annots.length;

    const square = annots.find(a => a.getType() === "Square")!;
    page.deleteAnnotation(square);

    const remaining = page.getAnnotations();
    expect(remaining.length).toBe(initialCount - 1);
    expect(remaining.find(a => a.getType() === "Square")).toBeUndefined();

    // Verify persists through save
    const buf = doc.saveToBuffer("incremental");
    const doc2 = new mupdf.PDFDocument(buf.asUint8Array());
    const page2 = doc2.loadPage(0) as mupdf.PDFPage;
    expect(page2.getAnnotations().find(a => a.getType() === "Square")).toBeUndefined();
  });
});
