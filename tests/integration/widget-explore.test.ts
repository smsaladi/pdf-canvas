// Integration tests: widget operations
import { describe, it, expect } from "vitest";
import * as mupdf from "mupdf";
import * as fs from "node:fs";
import * as path from "node:path";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");

function loadFixture(name: string): mupdf.PDFDocument {
  const bytes = fs.readFileSync(path.join(FIXTURES, name));
  return new mupdf.PDFDocument(bytes);
}

describe("Form widget operations", () => {
  it("enumerates widgets from with-form.pdf", () => {
    const doc = loadFixture("with-form.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const widgets = page.getWidgets();

    expect(widgets.length).toBe(3);
    // Two text fields and one button (checkbox)
    const types = widgets.map(w => w.getFieldType()).sort();
    expect(types).toEqual(["checkbox", "text", "text"]);

    // Text fields should have names
    const textWidgets = widgets.filter(w => w.isText());
    expect(textWidgets.length).toBe(2);
    const names = textWidgets.map(w => w.getName()).sort();
    expect(names).toEqual(["email", "name"]);
  });

  it("widget setRect persists through save/reload", () => {
    const doc = loadFixture("with-form.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const widgets = page.getWidgets();
    const w = widgets[0];

    const origRect = w.getRect();
    const newRect: mupdf.Rect = [origRect[0] + 30, origRect[1] + 20, origRect[2] + 30, origRect[3] + 20];
    w.setRect(newRect);
    w.update();

    const buf = doc.saveToBuffer("incremental");
    const doc2 = new mupdf.PDFDocument(buf.asUint8Array());
    const page2 = doc2.loadPage(0) as mupdf.PDFPage;
    const w2 = page2.getWidgets()[0];

    const reloaded = w2.getRect();
    expect(reloaded[0]).toBeCloseTo(newRect[0], 0);
    expect(reloaded[1]).toBeCloseTo(newRect[1], 0);
    expect(reloaded[2]).toBeCloseTo(newRect[2], 0);
    expect(reloaded[3]).toBeCloseTo(newRect[3], 0);
  });

  it("saveToBuffer incremental produces valid PDF", () => {
    const doc = loadFixture("with-annotations.pdf");
    const buf = doc.saveToBuffer("incremental");
    const bytes = buf.asUint8Array();

    expect(bytes.length).toBeGreaterThan(0);
    const header = String.fromCharCode(...bytes.slice(0, 5));
    expect(header).toBe("%PDF-");
  });

  it("widgets are separate from annotations", () => {
    const doc = loadFixture("with-form.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;

    expect(page.getWidgets().length).toBe(3);
    expect(page.getAnnotations().length).toBe(0);
  });
});
