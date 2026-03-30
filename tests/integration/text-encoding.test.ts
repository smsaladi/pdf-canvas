// Integration tests: text encoding fixtures — WinAnsi, Type0/Identity-H, multiline, styled
import { describe, it, expect } from "vitest";
import * as mupdf from "mupdf";
import * as fs from "node:fs";
import * as path from "node:path";
import { extractTextOccurrences, getAllText, replaceTextInStream } from "../../src/content-stream";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");

function loadFixture(name: string): mupdf.PDFDocument {
  const bytes = fs.readFileSync(path.join(FIXTURES, name));
  return new mupdf.PDFDocument(bytes);
}

function getContentStream(doc: mupdf.PDFDocument, pageIdx = 0): string {
  const page = doc.loadPage(pageIdx) as mupdf.PDFPage;
  const pageObj = page.getObject();
  const contentsRef = pageObj.get("Contents");
  return contentsRef.readStream().asString();
}

function getFontDict(doc: mupdf.PDFDocument, fontName: string, pageIdx = 0): mupdf.PDFObject {
  const page = doc.loadPage(pageIdx) as mupdf.PDFPage;
  const pageObj = page.getObject();
  const resources = pageObj.get("Resources");
  const fonts = resources.get("Font");
  return fonts.get(fontName);
}

// ===== with-type0-text.pdf =====

describe("with-type0-text.pdf — WinAnsi + Type0/Identity-H encoding", () => {
  describe("text extraction via StructuredText", () => {
    it("extracts WinAnsi-encoded text", () => {
      const doc = loadFixture("with-type0-text.pdf");
      const page = doc.loadPage(0);
      const stext = page.toStructuredText();
      const text = stext.asText();

      expect(text).toContain("WinAnsi encoded text: Hello World");
      expect(text).toContain("This uses standard literal string encoding");
    });

    it("extracts Type0/hex-encoded text via StructuredText walk", () => {
      const doc = loadFixture("with-type0-text.pdf");
      const page = doc.loadPage(0);
      const stext = page.toStructuredText();

      const chars: string[] = [];
      stext.walk({
        onChar(c: string) {
          chars.push(c);
        },
      });

      const fullText = chars.join("");
      // The hex-encoded section should produce "Hello World" (or individual chars)
      // Check that both encoding sections produced readable text
      expect(fullText).toContain("Hello World");
    });
  });

  describe("content stream operators", () => {
    it("contains literal string Tj operators for WinAnsi text", () => {
      const doc = loadFixture("with-type0-text.pdf");
      const stream = getContentStream(doc);

      // WinAnsi text uses literal strings: (text) Tj
      expect(stream).toContain("(WinAnsi encoded text: Hello World) Tj");
      expect(stream).toContain("Tj");
    });

    it("contains hex string Tj operators for Type0 text", () => {
      const doc = loadFixture("with-type0-text.pdf");
      const stream = getContentStream(doc);

      // Type0 text uses hex strings: <XXXX> Tj
      // "H" = U+0048 => <0048>
      expect(stream).toMatch(/<0048>\s*Tj/);
      // "e" = U+0065 => <0065>
      expect(stream).toMatch(/<0065>\s*Tj/);
      // "l" = U+006C => <006c>
      expect(stream).toMatch(/<006c>\s*Tj/i);
    });
  });

  describe("font resources", () => {
    it("F1 is a simple TrueType/Type1 font with standard encoding", () => {
      const doc = loadFixture("with-type0-text.pdf");
      const f1 = getFontDict(doc, "F1");

      const subtype = f1.get("Subtype").asName();
      // addSimpleFont produces Type1 or TrueType
      expect(["Type1", "TrueType"]).toContain(subtype);
    });

    it("F2 is a Type0 font with Identity-H encoding", () => {
      const doc = loadFixture("with-type0-text.pdf");
      const f2 = getFontDict(doc, "F2");

      expect(f2.get("Subtype").asName()).toBe("Type0");
      expect(f2.get("Encoding").asName()).toBe("Identity-H");
    });

    it("F2 has a ToUnicode CMap", () => {
      const doc = loadFixture("with-type0-text.pdf");
      const f2 = getFontDict(doc, "F2");

      const toUnicode = f2.get("ToUnicode");
      expect(toUnicode).toBeDefined();
      // Read the CMap stream
      const cmapData = toUnicode.readStream().asString();
      expect(cmapData).toContain("beginbfchar");
      expect(cmapData).toContain("endbfchar");
      // Should contain mapping for 'H' (0048)
      expect(cmapData).toContain("<0048>");
    });

    it("F2 has a CIDFont descendant", () => {
      const doc = loadFixture("with-type0-text.pdf");
      const f2 = getFontDict(doc, "F2");

      const descendants = f2.get("DescendantFonts");
      expect(descendants.length).toBeGreaterThan(0);
      const cidFont = descendants.get(0);
      expect(cidFont.get("Subtype").asName()).toBe("CIDFontType2");
    });
  });

  describe("replaceTextInStream on WinAnsi content", () => {
    it("replaces WinAnsi literal string text", () => {
      const doc = loadFixture("with-type0-text.pdf");
      const stream = getContentStream(doc);

      const { result, count } = replaceTextInStream(
        stream,
        "Hello World",
        "Goodbye Earth"
      );
      expect(count).toBe(1);
      expect(result).toContain("Goodbye Earth");
    });

    it("WinAnsi replacement persists through save/reload", () => {
      const doc = loadFixture("with-type0-text.pdf");
      const page = doc.loadPage(0) as mupdf.PDFPage;
      const contentsObj = page.getObject().get("Contents");
      const stream = contentsObj.readStream().asString();

      const { result } = replaceTextInStream(
        stream,
        "WinAnsi encoded text: Hello World",
        "WinAnsi encoded text: Changed Text"
      );
      contentsObj.writeStream(result);

      const buf = doc.saveToBuffer("compress");
      const doc2 = new mupdf.PDFDocument(buf.asUint8Array());
      const text2 = doc2.loadPage(0).toStructuredText().asText();
      expect(text2).toContain("Changed Text");
      expect(text2).not.toContain("Hello World");
    });
  });
});

// ===== with-multiline-text.pdf =====

describe("with-multiline-text.pdf — duplicate text on multiple lines", () => {
  describe("text extraction via StructuredText", () => {
    it("extracts all lines of text", () => {
      const doc = loadFixture("with-multiline-text.pdf");
      const page = doc.loadPage(0);
      const text = page.toStructuredText().asText();

      expect(text).toContain("Line 1:");
      expect(text).toContain("Line 2:");
      expect(text).toContain("Line 3:");
      expect(text).toContain("Line 4:");
      expect(text).toContain("Line 5:");
      expect(text).toContain("Line 6:");
    });

    it("finds multiple search hits for duplicated text", () => {
      const doc = loadFixture("with-multiline-text.pdf");
      const page = doc.loadPage(0);
      const stext = page.toStructuredText();

      const results = stext.search("The quick brown fox");
      // Appears on lines 1, 3, and 5
      expect(results.length).toBe(3);
    });

    it("search returns quads at different Y positions", () => {
      const doc = loadFixture("with-multiline-text.pdf");
      const page = doc.loadPage(0);
      const stext = page.toStructuredText();

      const results = stext.search("The quick brown fox");
      expect(results.length).toBe(3);

      // Each result's quads should be at different Y positions
      const yPositions = results.map((quads: number[][]) => {
        // Each quad is [ulx, uly, urx, ury, llx, lly, lrx, lry]
        return quads[0][1]; // uly of first quad
      });

      // All Y positions should be distinct
      const uniqueY = new Set(yPositions);
      expect(uniqueY.size).toBe(3);
    });
  });

  describe("content stream structure", () => {
    it("contains Td operators for line positioning", () => {
      const doc = loadFixture("with-multiline-text.pdf");
      const stream = getContentStream(doc);

      expect(stream).toContain("Td");
      // Multiple Td operators for different lines
      const tdCount = (stream.match(/Td/g) || []).length;
      expect(tdCount).toBeGreaterThanOrEqual(6);
    });

    it("contains all six lines as literal strings", () => {
      const doc = loadFixture("with-multiline-text.pdf");
      const stream = getContentStream(doc);

      expect(stream).toContain("(Line 1:");
      expect(stream).toContain("(Line 2:");
      expect(stream).toContain("(Line 3:");
      expect(stream).toContain("(Line 4:");
      expect(stream).toContain("(Line 5:");
      expect(stream).toContain("(Line 6:");
    });

    it("extractTextOccurrences returns 6 text items", () => {
      const doc = loadFixture("with-multiline-text.pdf");
      const stream = getContentStream(doc);

      const occurrences = extractTextOccurrences(stream);
      expect(occurrences.length).toBe(6);
      expect(occurrences.every(o => o.operator === "Tj")).toBe(true);
    });
  });

  describe("replaceTextInStream with duplicate text", () => {
    it("replaces first occurrence of duplicated text by default", () => {
      const doc = loadFixture("with-multiline-text.pdf");
      const stream = getContentStream(doc);

      const { result, count } = replaceTextInStream(
        stream,
        "The quick brown fox jumps over the lazy dog",
        "A slow red fox rests under the big tree"
      );
      expect(count).toBe(1);
      // First occurrence replaced, but others remain
      expect(result).toContain("A slow red fox");
      // Should still have at least one remaining original
      const remaining = (result.match(/The quick brown fox/g) || []).length;
      expect(remaining).toBe(2);
    });

    it("replaceAll replaces all occurrences of duplicated text", () => {
      const doc = loadFixture("with-multiline-text.pdf");
      const stream = getContentStream(doc);

      const { result, count } = replaceTextInStream(
        stream,
        "The quick brown fox jumps over the lazy dog",
        "Replaced text on every line",
        true
      );
      expect(count).toBe(3);
      expect(result).not.toContain("The quick brown fox");
    });
  });
});

// ===== with-styled-text.pdf =====

describe("with-styled-text.pdf — bold, italic, and regular fonts", () => {
  describe("text extraction via StructuredText", () => {
    it("extracts text from all font styles", () => {
      const doc = loadFixture("with-styled-text.pdf");
      const page = doc.loadPage(0);
      const text = page.toStructuredText().asText();

      expect(text).toContain("Regular text introduction");
      expect(text).toContain("Bold heading text");
      expect(text).toContain("Italic emphasis text");
      expect(text).toContain("Bold label:");
      expect(text).toContain("Italic note:");
    });

    it("walk reports different font names for different styles", () => {
      const doc = loadFixture("with-styled-text.pdf");
      const page = doc.loadPage(0);
      const stext = page.toStructuredText();

      const fontNames = new Set<string>();
      stext.walk({
        onChar(_c: string, _origin: any, font: any) {
          fontNames.add(font.getName());
        },
      });

      // Should have at least 3 distinct font names (regular, bold, italic)
      expect(fontNames.size).toBeGreaterThanOrEqual(3);

      const names = [...fontNames];
      // At least one should contain "Bold" and one "Oblique" or "Italic"
      expect(names.some(n => /bold/i.test(n))).toBe(true);
      expect(names.some(n => /oblique|italic/i.test(n))).toBe(true);
    });
  });

  describe("font resources", () => {
    it("has three font resources F1, F2, F3", () => {
      const doc = loadFixture("with-styled-text.pdf");
      const page = doc.loadPage(0) as mupdf.PDFPage;
      const resources = page.getObject().get("Resources");
      const fonts = resources.get("Font");

      expect(fonts.get("F1")).toBeDefined();
      expect(fonts.get("F2")).toBeDefined();
      expect(fonts.get("F3")).toBeDefined();
    });

    it("F1 (regular) has Helvetica base font", () => {
      const doc = loadFixture("with-styled-text.pdf");
      const f1 = getFontDict(doc, "F1");
      const baseName = f1.get("BaseFont").asName();
      expect(baseName).toContain("Helvetica");
      expect(baseName).not.toContain("Bold");
      expect(baseName).not.toContain("Oblique");
    });

    it("F2 (bold) has Helvetica-Bold base font", () => {
      const doc = loadFixture("with-styled-text.pdf");
      const f2 = getFontDict(doc, "F2");
      const baseName = f2.get("BaseFont").asName();
      expect(baseName).toContain("Bold");
    });

    it("F3 (italic) has Helvetica-Oblique base font", () => {
      const doc = loadFixture("with-styled-text.pdf");
      const f3 = getFontDict(doc, "F3");
      const baseName = f3.get("BaseFont").asName();
      expect(baseName).toContain("Oblique");
    });

    it("all font resources have Type1 or TrueType subtype", () => {
      const doc = loadFixture("with-styled-text.pdf");
      for (const name of ["F1", "F2", "F3"]) {
        const font = getFontDict(doc, name);
        const subtype = font.get("Subtype").asName();
        expect(["Type1", "TrueType"]).toContain(subtype);
      }
    });
  });

  describe("content stream font switching", () => {
    it("contains Tf operators for all three fonts", () => {
      const doc = loadFixture("with-styled-text.pdf");
      const stream = getContentStream(doc);

      expect(stream).toMatch(/\/F1\s+\d+\s+Tf/);
      expect(stream).toMatch(/\/F2\s+\d+\s+Tf/);
      expect(stream).toMatch(/\/F3\s+\d+\s+Tf/);
    });

    it("uses Tj operator for text rendering", () => {
      const doc = loadFixture("with-styled-text.pdf");
      const stream = getContentStream(doc);

      const occurrences = extractTextOccurrences(stream);
      expect(occurrences.length).toBeGreaterThan(0);
      expect(occurrences.every(o => o.operator === "Tj")).toBe(true);
    });

    it("getAllText returns concatenated text from all styles", () => {
      const doc = loadFixture("with-styled-text.pdf");
      const stream = getContentStream(doc);

      const allText = getAllText(stream);
      expect(allText).toContain("Regular text introduction");
      expect(allText).toContain("Bold heading text");
      expect(allText).toContain("Italic emphasis text");
    });
  });

  describe("replaceTextInStream on styled text", () => {
    it("can replace text within a bold section", () => {
      const doc = loadFixture("with-styled-text.pdf");
      const stream = getContentStream(doc);

      const { result, count } = replaceTextInStream(
        stream,
        "Bold heading text",
        "New bold heading"
      );
      expect(count).toBe(1);
      expect(result).toContain("New bold heading");
      expect(result).not.toContain("Bold heading text");
    });

    it("replacement in styled text persists through save/reload", () => {
      const doc = loadFixture("with-styled-text.pdf");
      const page = doc.loadPage(0) as mupdf.PDFPage;
      const contentsObj = page.getObject().get("Contents");
      const stream = contentsObj.readStream().asString();

      const { result } = replaceTextInStream(
        stream,
        "Italic emphasis text",
        "Changed italic text"
      );
      contentsObj.writeStream(result);

      const buf = doc.saveToBuffer("compress");
      const doc2 = new mupdf.PDFDocument(buf.asUint8Array());
      const text2 = doc2.loadPage(0).toStructuredText().asText();
      expect(text2).toContain("Changed italic text");
      expect(text2).not.toContain("Italic emphasis text");
    });
  });
});
