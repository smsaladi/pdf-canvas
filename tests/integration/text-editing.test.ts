// Integration tests: text extraction and content stream editing
import { describe, it, expect } from "vitest";
import * as mupdf from "mupdf";
import * as fs from "node:fs";
import * as path from "node:path";
import { replaceTextInStream, extractTextOccurrences, getAllText } from "../../src/content-stream";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");

function loadFixture(name: string): mupdf.PDFDocument {
  const bytes = fs.readFileSync(path.join(FIXTURES, name));
  return new mupdf.PDFDocument(bytes);
}

describe("Text extraction via StructuredText", () => {
  it("extracts text from with-text.pdf", () => {
    const doc = loadFixture("with-text.pdf");
    const page = doc.loadPage(0);
    const stext = page.toStructuredText();
    const text = stext.asText();

    expect(text).toContain("Invoice #12345");
    expect(text).toContain("Date: January 15, 2024");
    expect(text).toContain("Customer: John Smith");
    expect(text).toContain("Amount: $1,234.56");
  });

  it("walks characters with position and font info", () => {
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
    // First character should be 'I' from "Invoice"
    expect(chars[0].c).toBe("I");
    expect(chars[0].fontSize).toBe(24);
    expect(chars[0].fontName).toContain("Helvetica");
  });

  it("search finds text with quad positions", () => {
    const doc = loadFixture("with-text.pdf");
    const page = doc.loadPage(0);
    const stext = page.toStructuredText();

    const results = stext.search("John Smith");
    expect(results.length).toBe(1);
    // Each result is an array of quads
    expect(results[0].length).toBeGreaterThan(0);
  });

  it("search returns empty for non-existent text", () => {
    const doc = loadFixture("with-text.pdf");
    const page = doc.loadPage(0);
    const stext = page.toStructuredText();

    const results = stext.search("NonExistentText12345");
    expect(results.length).toBe(0);
  });

  it("extracts no text from blank.pdf", () => {
    const doc = loadFixture("blank.pdf");
    const page = doc.loadPage(0);
    const stext = page.toStructuredText();
    expect(stext.asText().trim()).toBe("");
  });
});

describe("Content stream reading via PDF object API", () => {
  it("reads content stream from with-text.pdf", () => {
    const doc = loadFixture("with-text.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const pageObj = page.getObject();
    const contentsRef = pageObj.get("Contents");
    const stream = contentsRef.readStream();
    const text = stream.asString();

    // Should contain PDF text operators
    expect(text).toContain("BT");
    expect(text).toContain("ET");
    expect(text).toContain("Tj");
    expect(text).toContain("Invoice #12345");
  });

  it("extracts text occurrences from content stream", () => {
    const doc = loadFixture("with-text.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const pageObj = page.getObject();
    const stream = pageObj.get("Contents").readStream().asString();

    const occurrences = extractTextOccurrences(stream);
    expect(occurrences.length).toBeGreaterThan(0);

    const texts = occurrences.map((o) => o.text);
    expect(texts).toContain("Invoice #12345");
    expect(texts).toContain("Customer: John Smith");
  });

  it("getAllText returns all text from content stream", () => {
    const doc = loadFixture("with-text.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const stream = page.getObject().get("Contents").readStream().asString();

    const allText = getAllText(stream);
    expect(allText).toContain("Invoice #12345");
    expect(allText).toContain("John Smith");
  });
});

describe("Content stream text replacement", () => {
  it("replaces text in content stream and verifies via re-extraction", () => {
    const doc = loadFixture("with-text.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const pageObj = page.getObject();
    const contentsObj = pageObj.get("Contents");
    const stream = contentsObj.readStream().asString();

    // Replace "John Smith" with "Jane Smith"
    const { result, count } = replaceTextInStream(stream, "John Smith", "Jane Smith");
    expect(count).toBe(1);

    // Write back
    contentsObj.writeStream(result);

    // Re-extract to verify
    const stext = page.toStructuredText();
    const text = stext.asText();
    expect(text).toContain("Jane Smith");
    expect(text).not.toContain("John Smith");
  });

  it("replacement persists through save/reload", () => {
    const doc = loadFixture("with-text.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const contentsObj = page.getObject().get("Contents");
    const stream = contentsObj.readStream().asString();

    const { result } = replaceTextInStream(stream, "Invoice #12345", "Invoice #99999");
    contentsObj.writeStream(result);

    // Save
    const buf = doc.saveToBuffer("compress");
    const bytes = buf.asUint8Array();

    // Reload
    const doc2 = new mupdf.PDFDocument(bytes);
    const page2 = doc2.loadPage(0);
    const text = page2.toStructuredText().asText();
    expect(text).toContain("Invoice #99999");
    expect(text).not.toContain("Invoice #12345");
  });

  it("replaceAll replaces all occurrences", () => {
    const doc = loadFixture("with-text.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const contentsObj = page.getObject().get("Contents");
    const stream = contentsObj.readStream().asString();

    // "Tj" appears multiple times — but we replace text content, not operators
    // Let's search for a date substring
    const { result, count } = replaceTextInStream(stream, "2024", "2025", true);
    expect(count).toBe(1); // "2024" appears once in "January 15, 2024"
    expect(result).toContain("2025");
  });
});
