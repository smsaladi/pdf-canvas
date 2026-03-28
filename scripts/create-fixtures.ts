// Generate deterministic test PDF fixtures using MuPDF
import * as mupdf from "mupdf";
import * as fs from "node:fs";
import * as path from "node:path";

const FIXTURES_DIR = path.join(import.meta.dirname, "..", "tests", "fixtures");
fs.mkdirSync(FIXTURES_DIR, { recursive: true });

function save(doc: mupdf.PDFDocument, name: string) {
  const buf = doc.saveToBuffer("compress");
  const bytes = buf.asUint8Array();
  fs.writeFileSync(path.join(FIXTURES_DIR, name), bytes);
  console.log(`Created ${name} (${bytes.length} bytes)`);
}

// 1. blank.pdf — single blank letter-size page
function createBlank() {
  const doc = new mupdf.PDFDocument();
  const pageObj = doc.addPage([0, 0, 612, 792], 0, null, "");
  doc.insertPage(-1, pageObj);
  save(doc, "blank.pdf");
}

// 2. with-annotations.pdf — page with various annotation types
function createWithAnnotations() {
  const doc = new mupdf.PDFDocument();
  const pageObj = doc.addPage([0, 0, 612, 792], 0, null, "");
  doc.insertPage(-1, pageObj);
  const page = doc.loadPage(0) as mupdf.PDFPage;

  // FreeText annotation
  const freetext = page.createAnnotation("FreeText");
  freetext.setRect([100, 100, 300, 150]);
  freetext.setContents("Test FreeText Annotation");
  freetext.setDefaultAppearance("Helv", 12, [0, 0, 0]);
  freetext.setColor([1, 0, 0]);
  freetext.update();

  // Square annotation
  const square = page.createAnnotation("Square");
  square.setRect([100, 200, 250, 300]);
  square.setColor([0, 0, 1]);
  square.setBorderWidth(2);
  square.update();

  // Text (sticky note) annotation
  const note = page.createAnnotation("Text");
  note.setRect([400, 100, 424, 124]);
  note.setContents("Test sticky note comment");
  note.setColor([1, 1, 0]);
  note.setIcon("Note");
  note.update();

  // Highlight annotation
  const highlight = page.createAnnotation("Highlight");
  highlight.setColor([1, 1, 0]);
  highlight.setOpacity(0.5);
  highlight.setQuadPoints([[100, 400, 400, 400, 100, 415, 400, 415]]);
  highlight.setContents("Highlighted text comment");
  highlight.update();

  save(doc, "with-annotations.pdf");
}

// 3. with-comments.pdf — sticky notes with replies
function createWithComments() {
  const doc = new mupdf.PDFDocument();
  const pageObj = doc.addPage([0, 0, 612, 792], 0, null, "");
  doc.insertPage(-1, pageObj);
  const page = doc.loadPage(0) as mupdf.PDFPage;

  const note1 = page.createAnnotation("Text");
  note1.setRect([100, 100, 124, 124]);
  note1.setContents("First comment — please review");
  note1.setColor([1, 1, 0]);
  note1.setIcon("Note");
  note1.setAuthor("Alice");
  note1.update();

  const note2 = page.createAnnotation("Text");
  note2.setRect([200, 100, 224, 124]);
  note2.setContents("Second comment — looks good");
  note2.setColor([0, 1, 0]);
  note2.setIcon("Comment");
  note2.setAuthor("Bob");
  note2.update();

  const highlight = page.createAnnotation("Highlight");
  highlight.setColor([0.5, 0.8, 1]);
  highlight.setOpacity(0.4);
  highlight.setQuadPoints([[50, 300, 500, 300, 50, 320, 500, 320]]);
  highlight.setContents("Important section highlighted");
  highlight.setAuthor("Alice");
  highlight.update();

  save(doc, "with-comments.pdf");
}

// 4. with-form.pdf — page with text fields and a checkbox
function createWithForm() {
  const doc = new mupdf.PDFDocument();
  const pageObj = doc.addPage([0, 0, 612, 792], 0, null, "");
  doc.insertPage(-1, pageObj);
  const page = doc.loadPage(0) as mupdf.PDFPage;

  // Text field: Name
  const w1 = page.createAnnotation("Widget");
  w1.setRect([100, 100, 400, 130]);
  const obj1 = w1.getObject();
  obj1.put("FT", doc.newName("Tx"));
  obj1.put("T", doc.newString("name"));
  obj1.put("V", doc.newString(""));
  w1.setDefaultAppearance("Helv", 12, [0, 0, 0]);
  try { w1.update(); } catch {}

  // Text field: Email
  const w2 = page.createAnnotation("Widget");
  w2.setRect([100, 160, 400, 190]);
  const obj2 = w2.getObject();
  obj2.put("FT", doc.newName("Tx"));
  obj2.put("T", doc.newString("email"));
  obj2.put("V", doc.newString(""));
  w2.setDefaultAppearance("Helv", 12, [0, 0, 0]);
  try { w2.update(); } catch {}

  // Checkbox
  const w3 = page.createAnnotation("Widget");
  w3.setRect([100, 220, 120, 240]);
  const obj3 = w3.getObject();
  obj3.put("FT", doc.newName("Btn"));
  obj3.put("T", doc.newString("agree"));
  try { w3.update(); } catch {}

  save(doc, "with-form.pdf");
}

// 5. multi-page.pdf — 12 pages with different content
function createMultiPage() {
  const doc = new mupdf.PDFDocument();
  for (let i = 0; i < 12; i++) {
    const pageObj = doc.addPage([0, 0, 612, 792], 0, null, "");
    doc.insertPage(-1, pageObj);
  }

  // Add a note on page 5 for testing
  const page5 = doc.loadPage(4) as mupdf.PDFPage;
  const note = page5.createAnnotation("Text");
  note.setRect([300, 400, 324, 424]);
  note.setContents("Note on page 5");
  note.setColor([1, 0.5, 0]);
  note.update();

  save(doc, "multi-page.pdf");
}

// 6. rotated.pdf — page with rotation
function createRotated() {
  const doc = new mupdf.PDFDocument();
  // Normal page
  const page0 = doc.addPage([0, 0, 612, 792], 0, null, "");
  doc.insertPage(-1, page0);
  // 90° rotated page
  const page1 = doc.addPage([0, 0, 612, 792], 90, null, "");
  doc.insertPage(-1, page1);
  // 180° rotated page
  const page2 = doc.addPage([0, 0, 612, 792], 180, null, "");
  doc.insertPage(-1, page2);

  save(doc, "rotated.pdf");
}

// Run all generators
createBlank();
createWithAnnotations();
createWithComments();
createWithForm();
createMultiPage();
createRotated();

console.log("\nAll fixtures generated successfully!");
