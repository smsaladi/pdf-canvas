// Comprehensive integration tests for worker handler logic.
// These tests call MuPDF directly (not through the worker RPC),
// verifying the behavior that will be factored into handler files.
import { describe, it, expect } from "vitest";
import * as mupdf from "mupdf";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  parseToUnicodeCMap,
  replaceHexTextInStream,
  extractTextOccurrences,
  replaceTextInStream,
  getAllText,
} from "../../src/content-stream";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");

function loadFixture(name: string): mupdf.PDFDocument {
  const bytes = fs.readFileSync(path.join(FIXTURES, name));
  return new mupdf.PDFDocument(bytes);
}

// ============================================================
// 1. Document lifecycle
// ============================================================

describe("Document lifecycle", () => {
  it("opens blank.pdf and reports 1 page", () => {
    const doc = loadFixture("blank.pdf");
    expect(doc.countPages()).toBe(1);
  });

  it("opens multi-page.pdf and reports 12 pages", () => {
    const doc = loadFixture("multi-page.pdf");
    expect(doc.countPages()).toBe(12);
  });

  it("returns correct letter-size dimensions for blank.pdf", () => {
    const doc = loadFixture("blank.pdf");
    const page = doc.loadPage(0);
    const bounds = page.getBounds();
    expect(bounds[2] - bounds[0]).toBeCloseTo(612, 0);
    expect(bounds[3] - bounds[1]).toBeCloseTo(792, 0);
  });

  it("returns correct dimensions for each page in multi-page.pdf", () => {
    const doc = loadFixture("multi-page.pdf");
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.loadPage(i);
      const bounds = page.getBounds();
      expect(bounds[2] - bounds[0]).toBeCloseTo(612, 0);
      expect(bounds[3] - bounds[1]).toBeCloseTo(792, 0);
    }
  });

  it("opens with-text.pdf and reports 1 page", () => {
    const doc = loadFixture("with-text.pdf");
    expect(doc.countPages()).toBe(1);
  });

  it("opens with-annotations.pdf and reports 1 page", () => {
    const doc = loadFixture("with-annotations.pdf");
    expect(doc.countPages()).toBe(1);
  });

  it("opens with-form.pdf and reports 1 page", () => {
    const doc = loadFixture("with-form.pdf");
    expect(doc.countPages()).toBe(1);
  });
});

// ============================================================
// 2. Annotation CRUD
// ============================================================

describe("Annotation CRUD", () => {
  describe("Create", () => {
    it("creates a Square annotation and verifies it appears in getAnnotations", () => {
      const doc = new mupdf.PDFDocument();
      const pageObj = doc.addPage([0, 0, 612, 792], 0, null, "");
      doc.insertPage(-1, pageObj);
      const page = doc.loadPage(0) as mupdf.PDFPage;

      expect(page.getAnnotations().length).toBe(0);

      const sq = page.createAnnotation("Square");
      sq.setRect([100, 100, 250, 200]);
      sq.setColor([0, 0, 1] as mupdf.AnnotColor);
      sq.setBorderWidth(3);
      sq.update();

      const annots = page.getAnnotations();
      expect(annots.length).toBe(1);
      expect(annots[0].getType()).toBe("Square");
    });

    it("creates multiple annotation types on the same page", () => {
      const doc = new mupdf.PDFDocument();
      const pageObj = doc.addPage([0, 0, 612, 792], 0, null, "");
      doc.insertPage(-1, pageObj);
      const page = doc.loadPage(0) as mupdf.PDFPage;

      const sq = page.createAnnotation("Square");
      sq.setRect([10, 10, 100, 100]);
      sq.setColor([1, 0, 0] as mupdf.AnnotColor);
      sq.update();

      const ft = page.createAnnotation("FreeText");
      ft.setRect([110, 10, 300, 50]);
      ft.setContents("Hello");
      ft.setDefaultAppearance("Helv", 12, [0, 0, 0]);
      ft.update();

      const note = page.createAnnotation("Text");
      note.setRect([310, 10, 334, 34]);
      note.setContents("A note");
      note.setIcon("Note");
      note.update();

      const annots = page.getAnnotations();
      expect(annots.length).toBe(3);
      const types = annots.map(a => a.getType()).sort();
      expect(types).toEqual(["FreeText", "Square", "Text"]);
    });
  });

  describe("Read properties", () => {
    it("reads color from a Square annotation", () => {
      const doc = loadFixture("with-annotations.pdf");
      const page = doc.loadPage(0) as mupdf.PDFPage;
      const sq = page.getAnnotations().find(a => a.getType() === "Square")!;
      expect(sq).toBeDefined();
      const color = sq.getColor();
      // Fixture creates Square with color [0, 0, 1] (blue)
      expect(color[0]).toBeCloseTo(0, 1);
      expect(color[1]).toBeCloseTo(0, 1);
      expect(color[2]).toBeCloseTo(1, 1);
    });

    it("reads border width from a Square annotation", () => {
      const doc = loadFixture("with-annotations.pdf");
      const page = doc.loadPage(0) as mupdf.PDFPage;
      const sq = page.getAnnotations().find(a => a.getType() === "Square")!;
      expect(sq.getBorderWidth()).toBe(2);
    });

    it("reads contents from a FreeText annotation", () => {
      const doc = loadFixture("with-annotations.pdf");
      const page = doc.loadPage(0) as mupdf.PDFPage;
      const ft = page.getAnnotations().find(a => a.getType() === "FreeText")!;
      expect(ft.getContents()).toBe("Test FreeText Annotation");
    });

    it("reads opacity from a Highlight annotation", () => {
      const doc = loadFixture("with-annotations.pdf");
      const page = doc.loadPage(0) as mupdf.PDFPage;
      const hl = page.getAnnotations().find(a => a.getType() === "Highlight")!;
      expect(hl.getOpacity()).toBeCloseTo(0.5, 1);
    });

    it("reads icon from a Text annotation", () => {
      const doc = loadFixture("with-annotations.pdf");
      const page = doc.loadPage(0) as mupdf.PDFPage;
      const note = page.getAnnotations().find(a => a.getType() === "Text")!;
      expect(note.getIcon()).toBe("Note");
    });
  });

  describe("Update (set properties)", () => {
    it("setColor changes the annotation color", () => {
      const doc = loadFixture("with-annotations.pdf");
      const page = doc.loadPage(0) as mupdf.PDFPage;
      const sq = page.getAnnotations().find(a => a.getType() === "Square")!;

      sq.setColor([1, 0, 0] as mupdf.AnnotColor);
      sq.update();

      const color = sq.getColor();
      expect(color[0]).toBeCloseTo(1, 1);
      expect(color[1]).toBeCloseTo(0, 1);
      expect(color[2]).toBeCloseTo(0, 1);
    });

    it("setRect moves the annotation to a new position", () => {
      const doc = loadFixture("with-annotations.pdf");
      const page = doc.loadPage(0) as mupdf.PDFPage;
      const sq = page.getAnnotations().find(a => a.getType() === "Square")!;

      const newRect: mupdf.Rect = [200, 300, 350, 400];
      sq.setRect(newRect);
      sq.update();

      const rect = sq.getRect();
      expect(rect[0]).toBeCloseTo(200, 0);
      expect(rect[1]).toBeCloseTo(300, 0);
      expect(rect[2]).toBeCloseTo(350, 0);
      expect(rect[3]).toBeCloseTo(400, 0);
    });

    it("setContents updates annotation text", () => {
      const doc = loadFixture("with-annotations.pdf");
      const page = doc.loadPage(0) as mupdf.PDFPage;
      const note = page.getAnnotations().find(a => a.getType() === "Text")!;

      note.setContents("New comment text");
      note.update();

      expect(note.getContents()).toBe("New comment text");
    });

    it("setOpacity changes annotation opacity", () => {
      const doc = loadFixture("with-annotations.pdf");
      const page = doc.loadPage(0) as mupdf.PDFPage;
      const hl = page.getAnnotations().find(a => a.getType() === "Highlight")!;

      hl.setOpacity(0.9);
      hl.update();

      expect(hl.getOpacity()).toBeCloseTo(0.9, 1);
    });

    it("setBorderWidth changes border thickness", () => {
      const doc = loadFixture("with-annotations.pdf");
      const page = doc.loadPage(0) as mupdf.PDFPage;
      const sq = page.getAnnotations().find(a => a.getType() === "Square")!;

      sq.setBorderWidth(5);
      sq.update();

      expect(sq.getBorderWidth()).toBe(5);
    });

    it("setIcon changes the sticky note icon", () => {
      const doc = loadFixture("with-annotations.pdf");
      const page = doc.loadPage(0) as mupdf.PDFPage;
      const note = page.getAnnotations().find(a => a.getType() === "Text")!;

      note.setIcon("Comment");
      note.update();

      expect(note.getIcon()).toBe("Comment");
    });

    it("setQuadPoints shifts highlight position", () => {
      const doc = loadFixture("with-annotations.pdf");
      const page = doc.loadPage(0) as mupdf.PDFPage;
      const hl = page.getAnnotations().find(a => a.getType() === "Highlight")!;

      const originalQuads = hl.getQuadPoints();
      const dx = 50, dy = 25;
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

      const reloaded = hl.getQuadPoints();
      expect(reloaded[0][0]).toBeCloseTo(originalQuads[0][0] + dx, 0);
      expect(reloaded[0][1]).toBeCloseTo(originalQuads[0][1] + dy, 0);
    });
  });

  describe("Delete", () => {
    it("deleteAnnotation removes the annotation from the page", () => {
      const doc = loadFixture("with-annotations.pdf");
      const page = doc.loadPage(0) as mupdf.PDFPage;
      const annots = page.getAnnotations();
      const initialCount = annots.length;
      expect(initialCount).toBe(4);

      const sq = annots.find(a => a.getType() === "Square")!;
      page.deleteAnnotation(sq);

      const remaining = page.getAnnotations();
      expect(remaining.length).toBe(initialCount - 1);
      expect(remaining.find(a => a.getType() === "Square")).toBeUndefined();
    });

    it("deleting all annotations leaves an empty list", () => {
      const doc = loadFixture("with-annotations.pdf");
      const page = doc.loadPage(0) as mupdf.PDFPage;

      // Delete all annotations one by one
      while (page.getAnnotations().length > 0) {
        const annots = page.getAnnotations();
        page.deleteAnnotation(annots[0]);
      }

      expect(page.getAnnotations().length).toBe(0);
    });

    it("deleting an annotation does not affect other annotations", () => {
      const doc = loadFixture("with-annotations.pdf");
      const page = doc.loadPage(0) as mupdf.PDFPage;
      const annots = page.getAnnotations();

      // Remember the FreeText contents before deletion
      const ft = annots.find(a => a.getType() === "FreeText")!;
      const ftContents = ft.getContents();

      // Delete the Square
      const sq = annots.find(a => a.getType() === "Square")!;
      page.deleteAnnotation(sq);

      // FreeText should still be intact
      const remaining = page.getAnnotations();
      const ft2 = remaining.find(a => a.getType() === "FreeText")!;
      expect(ft2).toBeDefined();
      expect(ft2.getContents()).toBe(ftContents);
    });
  });
});

// ============================================================
// 3. Widget operations
// ============================================================

describe("Widget operations", () => {
  it("loads widgets from with-form.pdf", () => {
    const doc = loadFixture("with-form.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const widgets = page.getWidgets();

    expect(widgets.length).toBe(3);
  });

  it("returns correct widget field types", () => {
    const doc = loadFixture("with-form.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const widgets = page.getWidgets();
    const types = widgets.map(w => w.getFieldType()).sort();

    expect(types).toEqual(["checkbox", "text", "text"]);
  });

  it("returns correct widget field names", () => {
    const doc = loadFixture("with-form.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const widgets = page.getWidgets();
    const textWidgets = widgets.filter(w => w.isText());
    const names = textWidgets.map(w => w.getName()).sort();

    expect(names).toEqual(["email", "name"]);
  });

  it("widgets are enumerated separately from annotations", () => {
    const doc = loadFixture("with-form.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;

    expect(page.getWidgets().length).toBe(3);
    expect(page.getAnnotations().length).toBe(0);
  });

  it("widget rect matches fixture values", () => {
    const doc = loadFixture("with-form.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const widgets = page.getWidgets();
    // First widget (name text field) was created at [100, 100, 400, 130]
    const nameWidget = widgets.find(w => w.getName() === "name")!;
    expect(nameWidget).toBeDefined();
    const rect = nameWidget.getRect();
    expect(rect[0]).toBeCloseTo(100, 0);
    expect(rect[1]).toBeCloseTo(100, 0);
    expect(rect[2]).toBeCloseTo(400, 0);
    expect(rect[3]).toBeCloseTo(130, 0);
  });

  it("set text widget value via setTextValue", () => {
    const doc = loadFixture("with-form.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const widgets = page.getWidgets();
    const nameWidget = widgets.find(w => w.getName() === "name")!;

    nameWidget.setTextValue("Jane Doe");
    nameWidget.update();

    expect(nameWidget.getValue()).toBe("Jane Doe");
  });

  it("widget value persists through save/reload", () => {
    const doc = loadFixture("with-form.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const nameWidget = page.getWidgets().find(w => w.getName() === "name")!;

    nameWidget.setTextValue("Test User");
    nameWidget.update();

    const buf = doc.saveToBuffer("incremental");
    const doc2 = new mupdf.PDFDocument(buf.asUint8Array());
    const page2 = doc2.loadPage(0) as mupdf.PDFPage;
    const nameWidget2 = page2.getWidgets().find(w => w.getName() === "name")!;

    expect(nameWidget2.getValue()).toBe("Test User");
  });

  it("widget setRect persists through save/reload", () => {
    const doc = loadFixture("with-form.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const w = page.getWidgets()[0];
    const origRect = w.getRect();

    const newRect: mupdf.Rect = [origRect[0] + 50, origRect[1] + 40, origRect[2] + 50, origRect[3] + 40];
    w.setRect(newRect);
    w.update();

    const buf = doc.saveToBuffer("incremental");
    const doc2 = new mupdf.PDFDocument(buf.asUint8Array());
    const w2 = doc2.loadPage(0) as mupdf.PDFPage;
    const widget2 = w2.getWidgets()[0];

    const reloaded = widget2.getRect();
    expect(reloaded[0]).toBeCloseTo(newRect[0], 0);
    expect(reloaded[1]).toBeCloseTo(newRect[1], 0);
    expect(reloaded[2]).toBeCloseTo(newRect[2], 0);
    expect(reloaded[3]).toBeCloseTo(newRect[3], 0);
  });
});

// ============================================================
// 4. Save round-trip
// ============================================================

describe("Save round-trip", () => {
  it("saveToBuffer('compress') produces valid PDF", () => {
    const doc = loadFixture("blank.pdf");
    const buf = doc.saveToBuffer("compress");
    const bytes = buf.asUint8Array();

    expect(bytes.length).toBeGreaterThan(0);
    const header = String.fromCharCode(...bytes.slice(0, 5));
    expect(header).toBe("%PDF-");
  });

  it("saveToBuffer('incremental') produces valid PDF", () => {
    const doc = loadFixture("with-annotations.pdf");
    const buf = doc.saveToBuffer("incremental");
    const bytes = buf.asUint8Array();

    expect(bytes.length).toBeGreaterThan(0);
    const header = String.fromCharCode(...bytes.slice(0, 5));
    expect(header).toBe("%PDF-");
  });

  it("annotation creation persists through save/reload", () => {
    const doc = new mupdf.PDFDocument();
    const pageObj = doc.addPage([0, 0, 612, 792], 0, null, "");
    doc.insertPage(-1, pageObj);
    const page = doc.loadPage(0) as mupdf.PDFPage;

    const sq = page.createAnnotation("Square");
    sq.setRect([50, 50, 200, 200]);
    sq.setColor([1, 0, 0] as mupdf.AnnotColor);
    sq.setBorderWidth(3);
    sq.update();

    const buf = doc.saveToBuffer("compress");
    const doc2 = new mupdf.PDFDocument(buf.asUint8Array());
    const page2 = doc2.loadPage(0) as mupdf.PDFPage;
    const annots = page2.getAnnotations();

    expect(annots.length).toBe(1);
    expect(annots[0].getType()).toBe("Square");
    expect(annots[0].getBorderWidth()).toBe(3);

    const color = annots[0].getColor();
    expect(color[0]).toBeCloseTo(1, 1);
    expect(color[1]).toBeCloseTo(0, 1);
    expect(color[2]).toBeCloseTo(0, 1);
  });

  it("annotation move persists through save/reload", () => {
    const doc = loadFixture("with-annotations.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const ft = page.getAnnotations().find(a => a.getType() === "FreeText")!;

    const origRect = ft.getRect();
    const newRect: mupdf.Rect = [origRect[0] + 100, origRect[1] + 50, origRect[2] + 100, origRect[3] + 50];
    ft.setRect(newRect);
    ft.update();

    const buf = doc.saveToBuffer("incremental");
    const doc2 = new mupdf.PDFDocument(buf.asUint8Array());
    const ft2 = (doc2.loadPage(0) as mupdf.PDFPage).getAnnotations().find(a => a.getType() === "FreeText")!;

    const reloaded = ft2.getRect();
    expect(reloaded[0]).toBeCloseTo(newRect[0], 1);
    expect(reloaded[1]).toBeCloseTo(newRect[1], 1);
    expect(reloaded[2]).toBeCloseTo(newRect[2], 1);
    expect(reloaded[3]).toBeCloseTo(newRect[3], 1);
  });

  it("annotation deletion persists through save/reload", () => {
    const doc = loadFixture("with-annotations.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const annots = page.getAnnotations();
    const sq = annots.find(a => a.getType() === "Square")!;
    page.deleteAnnotation(sq);

    const buf = doc.saveToBuffer("incremental");
    const doc2 = new mupdf.PDFDocument(buf.asUint8Array());
    const page2 = doc2.loadPage(0) as mupdf.PDFPage;

    expect(page2.getAnnotations().find(a => a.getType() === "Square")).toBeUndefined();
    // Other annotations still present
    expect(page2.getAnnotations().length).toBe(3);
  });

  it("multiple mutations persist through a single save/reload", () => {
    const doc = loadFixture("with-annotations.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;

    // Move FreeText
    const ft = page.getAnnotations().find(a => a.getType() === "FreeText")!;
    ft.setRect([200, 200, 400, 250]);
    ft.update();

    // Change Square color
    const sq = page.getAnnotations().find(a => a.getType() === "Square")!;
    sq.setColor([0, 1, 0] as mupdf.AnnotColor);
    sq.update();

    // Update sticky note contents
    const note = page.getAnnotations().find(a => a.getType() === "Text")!;
    note.setContents("Modified comment");
    note.update();

    // Save and reload
    const buf = doc.saveToBuffer("incremental");
    const doc2 = new mupdf.PDFDocument(buf.asUint8Array());
    const page2 = doc2.loadPage(0) as mupdf.PDFPage;
    const annots2 = page2.getAnnotations();

    const ft2 = annots2.find(a => a.getType() === "FreeText")!;
    expect(ft2.getRect()[0]).toBeCloseTo(200, 0);

    const sq2 = annots2.find(a => a.getType() === "Square")!;
    expect(sq2.getColor()[1]).toBeCloseTo(1, 1);

    const note2 = annots2.find(a => a.getType() === "Text")!;
    expect(note2.getContents()).toBe("Modified comment");
  });

  it("page count is preserved through save/reload", () => {
    const doc = loadFixture("multi-page.pdf");
    const buf = doc.saveToBuffer("compress");
    const doc2 = new mupdf.PDFDocument(buf.asUint8Array());
    expect(doc2.countPages()).toBe(12);
  });
});

// ============================================================
// 5. Text extraction
// ============================================================

describe("Text extraction", () => {
  it("extracts text from with-text.pdf via StructuredText", () => {
    const doc = loadFixture("with-text.pdf");
    const page = doc.loadPage(0);
    const stext = page.toStructuredText();
    const text = stext.asText();

    expect(text).toContain("Invoice #12345");
    expect(text).toContain("Date: January 15, 2024");
    expect(text).toContain("Customer: John Smith");
    expect(text).toContain("Amount: $1,234.56");
  });

  it("character count is positive and reasonable", () => {
    const doc = loadFixture("with-text.pdf");
    const page = doc.loadPage(0);
    const stext = page.toStructuredText();

    const chars: string[] = [];
    stext.walk({
      onChar(c: string) {
        chars.push(c);
      },
    });

    // The fixture has at least "Invoice #12345", "Date: ...", "Customer: ...", "Amount: ..."
    expect(chars.length).toBeGreaterThan(50);
    expect(chars.length).toBeLessThan(500); // sanity upper bound
  });

  it("search finds known text with quad positions", () => {
    const doc = loadFixture("with-text.pdf");
    const page = doc.loadPage(0);
    const stext = page.toStructuredText();

    const results = stext.search("John Smith");
    expect(results.length).toBe(1);
    expect(results[0].length).toBeGreaterThan(0);
  });

  it("search returns empty for text that does not exist", () => {
    const doc = loadFixture("with-text.pdf");
    const page = doc.loadPage(0);
    const stext = page.toStructuredText();

    const results = stext.search("ZZZZZ_NONEXISTENT_99999");
    expect(results.length).toBe(0);
  });

  it("extracts no text from blank.pdf", () => {
    const doc = loadFixture("blank.pdf");
    const page = doc.loadPage(0);
    const stext = page.toStructuredText();
    expect(stext.asText().trim()).toBe("");
  });

  it("walks characters with font info", () => {
    const doc = loadFixture("with-text.pdf");
    const page = doc.loadPage(0);
    const stext = page.toStructuredText();

    const chars: Array<{ c: string; fontSize: number; fontName: string }> = [];
    stext.walk({
      onChar(c: string, _origin: any, font: any, size: number) {
        chars.push({ c, fontSize: size, fontName: font.getName() });
      },
    });

    expect(chars.length).toBeGreaterThan(0);
    expect(chars[0].c).toBe("I"); // "Invoice"
    expect(chars[0].fontSize).toBe(24);
    expect(chars[0].fontName).toContain("Helvetica");
  });
});

// ============================================================
// 6. Content stream replacement
// ============================================================

describe("Content stream replacement", () => {
  it("replaces 'John Smith' with 'Jane Smith' in content stream", () => {
    const doc = loadFixture("with-text.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const contentsObj = page.getObject().get("Contents");
    const stream = contentsObj.readStream().asString();

    const { result, count } = replaceTextInStream(stream, "John Smith", "Jane Smith");
    expect(count).toBe(1);

    contentsObj.writeStream(result);

    const stext = page.toStructuredText();
    const text = stext.asText();
    expect(text).toContain("Jane Smith");
    expect(text).not.toContain("John Smith");
  });

  it("content stream replacement persists through save/reload", () => {
    const doc = loadFixture("with-text.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const contentsObj = page.getObject().get("Contents");
    const stream = contentsObj.readStream().asString();

    const { result } = replaceTextInStream(stream, "John Smith", "Jane Smith");
    contentsObj.writeStream(result);

    const buf = doc.saveToBuffer("compress");
    const doc2 = new mupdf.PDFDocument(buf.asUint8Array());
    const page2 = doc2.loadPage(0);
    const text = page2.toStructuredText().asText();

    expect(text).toContain("Jane Smith");
    expect(text).not.toContain("John Smith");
    // Other text should be unaffected
    expect(text).toContain("Invoice #12345");
  });

  it("replaces invoice number and verifies via extraction", () => {
    const doc = loadFixture("with-text.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const contentsObj = page.getObject().get("Contents");
    const stream = contentsObj.readStream().asString();

    const { result, count } = replaceTextInStream(stream, "Invoice #12345", "Invoice #99999");
    expect(count).toBe(1);

    contentsObj.writeStream(result);

    const text = page.toStructuredText().asText();
    expect(text).toContain("Invoice #99999");
    expect(text).not.toContain("Invoice #12345");
  });

  it("replacement with text not found returns count=0 and unchanged stream", () => {
    const doc = loadFixture("with-text.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const stream = page.getObject().get("Contents").readStream().asString();

    const { result, count } = replaceTextInStream(stream, "NONEXISTENT_TEXT", "Replacement");
    expect(count).toBe(0);
    expect(result).toBe(stream);
  });
});

// ============================================================
// 7. Page rotation
// ============================================================

describe("Page rotation", () => {
  it("rotated.pdf has pages with different rotations", () => {
    const doc = loadFixture("rotated.pdf");
    expect(doc.countPages()).toBe(3);
  });

  it("rotated pages have swapped effective dimensions", () => {
    const doc = loadFixture("rotated.pdf");

    // Page 0: 0 degrees — normal 612x792
    const page0 = doc.loadPage(0);
    const bounds0 = page0.getBounds();
    const w0 = bounds0[2] - bounds0[0];
    const h0 = bounds0[3] - bounds0[1];
    expect(w0).toBeCloseTo(612, 0);
    expect(h0).toBeCloseTo(792, 0);

    // Page 1: 90 degrees — effective dimensions should be 792x612
    const page1 = doc.loadPage(1);
    const bounds1 = page1.getBounds();
    const w1 = bounds1[2] - bounds1[0];
    const h1 = bounds1[3] - bounds1[1];
    // MuPDF getBounds() on a rotated page returns the rotated dimensions
    expect(w1).toBeCloseTo(792, 0);
    expect(h1).toBeCloseTo(612, 0);

    // Page 2: 180 degrees — same dimensions as original (just flipped)
    const page2 = doc.loadPage(2);
    const bounds2 = page2.getBounds();
    const w2 = bounds2[2] - bounds2[0];
    const h2 = bounds2[3] - bounds2[1];
    expect(w2).toBeCloseTo(612, 0);
    expect(h2).toBeCloseTo(792, 0);
  });

  it("rendering a rotated page produces correctly dimensioned pixmap", () => {
    const doc = loadFixture("rotated.pdf");

    // 90-degree rotated page at scale=1 should produce 792x612 pixmap
    const page1 = doc.loadPage(1);
    const matrix: mupdf.Matrix = [1, 0, 0, 1, 0, 0];
    const pixmap = page1.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false);

    expect(pixmap.getWidth()).toBeCloseTo(792, 0);
    expect(pixmap.getHeight()).toBeCloseTo(612, 0);
  });
});

// ============================================================
// 8. parseToUnicodeCMap
// ============================================================

describe("parseToUnicodeCMap", () => {
  it("parses beginbfchar mappings", () => {
    const cmapData = `
/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
3 beginbfchar
<0003> <0020>
<002B> <0048>
<0044> <0061>
endbfchar
endcmap
`;
    const { gidToUnicode, unicodeToGid } = parseToUnicodeCMap(cmapData);

    expect(gidToUnicode.get(0x0003)).toBe(" ");   // space
    expect(gidToUnicode.get(0x002B)).toBe("H");   // H
    expect(gidToUnicode.get(0x0044)).toBe("a");   // a

    expect(unicodeToGid.get(" ")).toBe(0x0003);
    expect(unicodeToGid.get("H")).toBe(0x002B);
    expect(unicodeToGid.get("a")).toBe(0x0044);
  });

  it("parses beginbfrange mappings", () => {
    const cmapData = `
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
1 beginbfrange
<0041> <0043> <0041>
endbfrange
`;
    const { gidToUnicode, unicodeToGid } = parseToUnicodeCMap(cmapData);

    expect(gidToUnicode.get(0x0041)).toBe("A");
    expect(gidToUnicode.get(0x0042)).toBe("B");
    expect(gidToUnicode.get(0x0043)).toBe("C");

    expect(unicodeToGid.get("A")).toBe(0x0041);
    expect(unicodeToGid.get("B")).toBe(0x0042);
    expect(unicodeToGid.get("C")).toBe(0x0043);
  });

  it("parses a realistic CMap with mixed bfchar and bfrange", () => {
    // Simulates the kind of CMap typically found in Type0 fonts
    const cmapData = `
/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo
<< /Registry (Adobe)
/Ordering (UCS)
/Supplement 0
>> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
8 beginbfchar
<0003> <0020>
<001D> <003A>
<0024> <0041>
<002B> <0048>
<002F> <004C>
<0037> <0054>
<0044> <0061>
<004C> <0069>
endbfchar
2 beginbfrange
<0048> <004A> <0065>
<0057> <005A> <0074>
endbfrange
endcmap
`;
    const { gidToUnicode, unicodeToGid } = parseToUnicodeCMap(cmapData);

    // bfchar entries
    expect(gidToUnicode.get(0x0003)).toBe(" ");
    expect(gidToUnicode.get(0x001D)).toBe(":");
    expect(gidToUnicode.get(0x0024)).toBe("A");
    expect(gidToUnicode.get(0x002B)).toBe("H");
    expect(gidToUnicode.get(0x0037)).toBe("T");
    expect(gidToUnicode.get(0x0044)).toBe("a");
    expect(gidToUnicode.get(0x004C)).toBe("i");

    // bfrange entries: <0048> <004A> <0065> maps to e, f, g
    expect(gidToUnicode.get(0x0048)).toBe("e");
    expect(gidToUnicode.get(0x0049)).toBe("f");
    expect(gidToUnicode.get(0x004A)).toBe("g");

    // bfrange entries: <0057> <005A> <0074> maps to t, u, v, w
    expect(gidToUnicode.get(0x0057)).toBe("t");
    expect(gidToUnicode.get(0x0058)).toBe("u");
    expect(gidToUnicode.get(0x0059)).toBe("v");
    expect(gidToUnicode.get(0x005A)).toBe("w");

    // Reverse mappings
    expect(unicodeToGid.get("T")).toBe(0x0037);
    expect(unicodeToGid.get("e")).toBe(0x0048);
    expect(unicodeToGid.get("t")).toBe(0x0057);
  });

  it("handles empty CMap data gracefully", () => {
    const { gidToUnicode, unicodeToGid } = parseToUnicodeCMap("");
    expect(gidToUnicode.size).toBe(0);
    expect(unicodeToGid.size).toBe(0);
  });

  it("handles CMap with only codespacerange and no char/range sections", () => {
    const cmapData = `
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
`;
    const { gidToUnicode } = parseToUnicodeCMap(cmapData);
    expect(gidToUnicode.size).toBe(0);
  });

  it("handles multiple bfchar sections", () => {
    const cmapData = `
2 beginbfchar
<0041> <0041>
<0042> <0042>
endbfchar
2 beginbfchar
<0043> <0043>
<0044> <0044>
endbfchar
`;
    const { gidToUnicode } = parseToUnicodeCMap(cmapData);
    expect(gidToUnicode.get(0x0041)).toBe("A");
    expect(gidToUnicode.get(0x0042)).toBe("B");
    expect(gidToUnicode.get(0x0043)).toBe("C");
    expect(gidToUnicode.get(0x0044)).toBe("D");
  });
});

// ============================================================
// 9. replaceHexTextInStream
// ============================================================

describe("replaceHexTextInStream", () => {
  // Build a simple GID mapping for testing
  function buildTestMapping() {
    const gidToUnicode = new Map<number, string>();
    const unicodeToGid = new Map<string, number>();

    // Map some characters: H=0x002B, e=0x0048, l=0x004F, o=0x0052
    // W=0x003A, r=0x0055, d=0x0047, space=0x0003
    // J=0x002D, a=0x0044, n=0x0051
    const mapping: Array<[number, string]> = [
      [0x002B, "H"], [0x0048, "e"], [0x004F, "l"], [0x0052, "o"],
      [0x003A, "W"], [0x0055, "r"], [0x0047, "d"], [0x0003, " "],
      [0x002D, "J"], [0x0044, "a"], [0x0051, "n"],
    ];

    for (const [gid, ch] of mapping) {
      gidToUnicode.set(gid, ch);
      unicodeToGid.set(ch, gid);
    }

    return { gidToUnicode, unicodeToGid };
  }

  it("replaces hex-encoded text in a simple BT/ET block", () => {
    const { gidToUnicode, unicodeToGid } = buildTestMapping();

    // Build a content stream with hex-encoded "Hello"
    // H=002B, e=0048, l=004F, l=004F, o=0052
    const stream = [
      "BT",
      "1 0 0 1 72 700 Tm",
      "5 0 Td <002B> Tj",  // H
      "5 0 Td <0048> Tj",  // e
      "5 0 Td <004F> Tj",  // l
      "5 0 Td <004F> Tj",  // l
      "5 0 Td <0052> Tj",  // o
      "ET",
    ].join("\n");

    const { result, count, missingChars } = replaceHexTextInStream(
      stream, "Hello", "Jello", gidToUnicode, unicodeToGid
    );

    expect(count).toBe(1);
    expect(missingChars.length).toBe(0);
    // J=002D should replace H=002B at the first hex position (lowercase hex output)
    expect(result).toContain("<002d>");
    // Remaining characters unchanged
    expect(result).toContain("<0048>"); // e
    expect(result).toContain("<004f>"); // l
    expect(result).toContain("<0052>"); // o
  });

  it("returns count=0 when target text not found", () => {
    const { gidToUnicode, unicodeToGid } = buildTestMapping();

    const stream = [
      "BT",
      "1 0 0 1 72 700 Tm",
      "5 0 Td <002B> Tj",  // H
      "ET",
    ].join("\n");

    const { result, count } = replaceHexTextInStream(
      stream, "World", "Earth", gidToUnicode, unicodeToGid
    );

    expect(count).toBe(0);
    expect(result).toBe(stream);
  });

  it("reports missing characters not in the font", () => {
    const { gidToUnicode, unicodeToGid } = buildTestMapping();

    const stream = [
      "BT",
      "1 0 0 1 72 700 Tm",
      "5 0 Td <002B> Tj",  // H
      "ET",
    ].join("\n");

    // Try to replace with a character not in our mapping (e.g., "Z")
    const { missingChars } = replaceHexTextInStream(
      stream, "H", "Z", gidToUnicode, unicodeToGid
    );

    expect(missingChars).toContain("Z");
  });

  it("handles replacement text shorter than original", () => {
    const { gidToUnicode, unicodeToGid } = buildTestMapping();

    // "Hello" -> "He" (shorter replacement; extra chars become spaces)
    const stream = [
      "BT",
      "1 0 0 1 72 700 Tm",
      "5 0 Td <002B> Tj",  // H
      "5 0 Td <0048> Tj",  // e
      "5 0 Td <004F> Tj",  // l
      "5 0 Td <004F> Tj",  // l
      "5 0 Td <0052> Tj",  // o
      "ET",
    ].join("\n");

    const { result, count } = replaceHexTextInStream(
      stream, "Hello", "He", gidToUnicode, unicodeToGid
    );

    expect(count).toBe(1);
    // First two chars should remain H and e (lowercase hex output)
    expect(result).toContain("<002b>"); // H
    expect(result).toContain("<0048>"); // e
    // Remaining chars should become space (0x0003)
    // Count the space GIDs in the result
    const spaceMatches = result.match(/<0003>/g);
    expect(spaceMatches).not.toBeNull();
    expect(spaceMatches!.length).toBe(3); // l, l, o -> space, space, space
  });

  it("disambiguates by y-coordinate when multiple blocks contain the target text", () => {
    const { gidToUnicode, unicodeToGid } = buildTestMapping();

    // Two BT/ET blocks both containing "He" at different y positions
    const stream = [
      "BT",
      "1 0 0 1 72 700 Tm",
      "5 0 Td <002B> Tj",  // H
      "5 0 Td <0048> Tj",  // e
      "ET",
      "BT",
      "1 0 0 1 72 500 Tm",
      "5 0 Td <002B> Tj",  // H
      "5 0 Td <0048> Tj",  // e
      "ET",
    ].join("\n");

    // Target the block at y=500 (closer to selectionY=500)
    const { result, count } = replaceHexTextInStream(
      stream, "He", "Ha", gidToUnicode, unicodeToGid,
      undefined, 500
    );

    expect(count).toBe(1);

    // The second block should have been modified (a=0044, lowercase hex)
    // Split by BT to isolate blocks
    const blocks = result.split("BT");
    // blocks[1] is the first block (y=700), blocks[2] is the second (y=500)
    expect(blocks[1]).toContain("<002B>"); // first block H unchanged (original case)
    expect(blocks[1]).toContain("<0048>"); // first block e unchanged (original case)
    expect(blocks[2].toLowerCase()).toContain("<002b>"); // second block H unchanged
    expect(blocks[2].toLowerCase()).toContain("<0044>"); // second block e -> a
  });
});

// ============================================================
// Additional edge cases
// ============================================================

describe("Edge cases and robustness", () => {
  it("opening then saving a document with no modifications produces valid PDF", () => {
    const doc = loadFixture("with-annotations.pdf");
    const buf = doc.saveToBuffer("incremental");
    const bytes = buf.asUint8Array();

    expect(bytes.length).toBeGreaterThan(0);
    const header = String.fromCharCode(...bytes.slice(0, 5));
    expect(header).toBe("%PDF-");

    // Reload and verify annotations are intact
    const doc2 = new mupdf.PDFDocument(bytes);
    const page = doc2.loadPage(0) as mupdf.PDFPage;
    expect(page.getAnnotations().length).toBe(4);
  });

  it("creating annotation on multi-page document only affects target page", () => {
    const doc = loadFixture("multi-page.pdf");
    const page3 = doc.loadPage(2) as mupdf.PDFPage;

    const sq = page3.createAnnotation("Square");
    sq.setRect([50, 50, 150, 150]);
    sq.setColor([1, 0, 0] as mupdf.AnnotColor);
    sq.update();

    // Page 2 should have 1 annotation
    expect((doc.loadPage(2) as mupdf.PDFPage).getAnnotations().length).toBe(1);

    // Page 0, 1 should have 0
    expect((doc.loadPage(0) as mupdf.PDFPage).getAnnotations().length).toBe(0);
    expect((doc.loadPage(1) as mupdf.PDFPage).getAnnotations().length).toBe(0);

    // Page 4 should still have its original annotation
    expect((doc.loadPage(4) as mupdf.PDFPage).getAnnotations().length).toBe(1);
  });

  it("rendering page with annotations produces non-empty pixmap", () => {
    const doc = loadFixture("with-annotations.pdf");
    const page = doc.loadPage(0);
    const matrix: mupdf.Matrix = [1, 0, 0, 1, 0, 0];
    const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false);

    expect(pixmap.getWidth()).toBe(612);
    expect(pixmap.getHeight()).toBe(792);

    const pixels = pixmap.getPixels();
    expect(pixels.length).toBe(612 * 792 * 3);
    // At least some pixels should not be pure white (annotations render on page)
    let nonWhiteCount = 0;
    for (let i = 0; i < pixels.length; i += 3) {
      if (pixels[i] !== 255 || pixels[i + 1] !== 255 || pixels[i + 2] !== 255) {
        nonWhiteCount++;
      }
    }
    expect(nonWhiteCount).toBeGreaterThan(0);
  });

  it("content stream contains PDF text operators for with-text.pdf", () => {
    const doc = loadFixture("with-text.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const pageObj = page.getObject();
    const stream = pageObj.get("Contents").readStream().asString();

    expect(stream).toContain("BT");
    expect(stream).toContain("ET");
    expect(stream).toContain("Tj");
  });

  it("extractTextOccurrences from with-text.pdf content stream finds known strings", () => {
    const doc = loadFixture("with-text.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const stream = page.getObject().get("Contents").readStream().asString();

    const occurrences = extractTextOccurrences(stream);
    expect(occurrences.length).toBeGreaterThan(0);

    const texts = occurrences.map(o => o.text);
    expect(texts).toContain("Invoice #12345");
    expect(texts).toContain("Customer: John Smith");
  });

  it("getAllText returns concatenated text from content stream", () => {
    const doc = loadFixture("with-text.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const stream = page.getObject().get("Contents").readStream().asString();

    const allText = getAllText(stream);
    expect(allText).toContain("Invoice #12345");
    expect(allText).toContain("John Smith");
    expect(allText).toContain("$1,234.56");
  });

  it("double save/reload preserves modifications", () => {
    const doc = loadFixture("with-annotations.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const ft = page.getAnnotations().find(a => a.getType() === "FreeText")!;

    ft.setContents("First edit");
    ft.update();

    // First save/reload
    const buf1 = doc.saveToBuffer("incremental");
    const doc2 = new mupdf.PDFDocument(buf1.asUint8Array());
    const page2 = doc2.loadPage(0) as mupdf.PDFPage;
    const ft2 = page2.getAnnotations().find(a => a.getType() === "FreeText")!;
    expect(ft2.getContents()).toBe("First edit");

    // Second modification
    ft2.setContents("Second edit");
    ft2.update();

    // Second save/reload
    const buf2 = doc2.saveToBuffer("incremental");
    const doc3 = new mupdf.PDFDocument(buf2.asUint8Array());
    const page3 = doc3.loadPage(0) as mupdf.PDFPage;
    const ft3 = page3.getAnnotations().find(a => a.getType() === "FreeText")!;
    expect(ft3.getContents()).toBe("Second edit");
  });
});
