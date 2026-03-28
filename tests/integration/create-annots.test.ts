// Integration tests: annotation creation for each type
import { describe, it, expect } from "vitest";
import * as mupdf from "mupdf";

function freshDoc(): { doc: mupdf.PDFDocument; page: mupdf.PDFPage } {
  const doc = new mupdf.PDFDocument();
  const pageObj = doc.addPage([0, 0, 612, 792], 0, null, "");
  doc.insertPage(-1, pageObj);
  return { doc, page: doc.loadPage(0) as mupdf.PDFPage };
}

describe("Creating each annotation type", () => {
  it("FreeText — transparent border, black text on white", () => {
    const { page } = freshDoc();
    const ft = page.createAnnotation("FreeText");
    ft.setRect([100, 100, 300, 140]);
    ft.setContents("Hello World");
    ft.setDefaultAppearance("Helv", 14, [0, 0, 0]);
    ft.setColor([]); // transparent border
    ft.update();

    expect(ft.getType()).toBe("FreeText");
    expect(ft.getContents()).toBe("Hello World");
    expect(ft.getColor().length).toBe(0);
  });

  it("Line — uses setLine, not setRect", () => {
    const { page } = freshDoc();
    const ln = page.createAnnotation("Line");
    ln.setColor([1, 0, 0] as mupdf.AnnotColor);
    ln.setBorderWidth(2);
    ln.setLine([100, 100] as mupdf.Point, [300, 200] as mupdf.Point);
    ln.update();

    expect(ln.getType()).toBe("Line");
    const line = ln.getLine();
    expect(line.length).toBe(2);
    expect(line[0][0]).toBeCloseTo(100, 0);
    expect(line[1][0]).toBeCloseTo(300, 0);
    // Rect is auto-computed from endpoints
    const bounds = ln.getBounds();
    expect(bounds[0]).toBeLessThanOrEqual(100);
    expect(bounds[2]).toBeGreaterThanOrEqual(300);
  });

  it("Square — red border", () => {
    const { page } = freshDoc();
    const sq = page.createAnnotation("Square");
    sq.setRect([100, 100, 250, 200]);
    sq.setColor([1, 0, 0] as mupdf.AnnotColor);
    sq.setBorderWidth(2);
    sq.update();
    expect(sq.getType()).toBe("Square");
  });

  it("Circle — blue border", () => {
    const { page } = freshDoc();
    const ci = page.createAnnotation("Circle");
    ci.setRect([100, 100, 250, 250]);
    ci.setColor([0, 0, 1] as mupdf.AnnotColor);
    ci.setBorderWidth(2);
    ci.update();
    expect(ci.getType()).toBe("Circle");
  });

  it("Ink — uses setInkList, not setRect", () => {
    const { page } = freshDoc();
    const ink = page.createAnnotation("Ink");
    ink.setColor([0, 0, 0] as mupdf.AnnotColor);
    ink.setBorderWidth(2);
    ink.setInkList([[[50, 50], [100, 80], [150, 60], [200, 100]] as mupdf.Point[]]);
    ink.update();

    expect(ink.getType()).toBe("Ink");
    const inkList = ink.getInkList();
    expect(inkList.length).toBe(1);
    expect(inkList[0].length).toBe(4);
  });

  it("Highlight — uses setQuadPoints, not setRect", () => {
    const { page } = freshDoc();
    const hl = page.createAnnotation("Highlight");
    hl.setColor([1, 1, 0] as mupdf.AnnotColor);
    hl.setOpacity(0.5);
    hl.setQuadPoints([[100, 300, 400, 300, 100, 315, 400, 315]] as mupdf.Quad[]);
    hl.update();

    expect(hl.getType()).toBe("Highlight");
    expect(hl.getQuadPoints().length).toBe(1);
  });

  it("Text (sticky note) — icon and contents", () => {
    const { page } = freshDoc();
    const note = page.createAnnotation("Text");
    note.setRect([200, 200, 224, 224]);
    note.setColor([1, 1, 0] as mupdf.AnnotColor);
    note.setIcon("Note");
    note.setContents("A comment");
    note.update();
    expect(note.getType()).toBe("Text");
    expect(note.getIcon()).toBe("Note");
  });

  it("created annotations persist through save/reload", () => {
    const { doc, page } = freshDoc();

    const sq = page.createAnnotation("Square");
    sq.setRect([50, 50, 150, 150]);
    sq.setColor([0, 1, 0] as mupdf.AnnotColor);
    sq.update();

    const note = page.createAnnotation("Text");
    note.setRect([200, 200, 224, 224]);
    note.setContents("Test note");
    note.setColor([1, 1, 0] as mupdf.AnnotColor);
    note.update();

    const buf = doc.saveToBuffer("compress");
    const doc2 = new mupdf.PDFDocument(buf.asUint8Array());
    const page2 = doc2.loadPage(0) as mupdf.PDFPage;
    const annots = page2.getAnnotations();
    expect(annots.length).toBe(2);
    expect(annots.map(a => a.getType()).sort()).toEqual(["Square", "Text"]);
  });
});
