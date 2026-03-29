import { describe, it, expect } from "vitest";
import * as mupdf from "mupdf";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildGlyphMap, findMappingsForSelection, editMappedGlyphs } from "../../src/content-map";
import { parseToUnicodeCMap } from "../../src/content-stream";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");

describe("Content stream mapping", () => {
  it("builds complete glyph map for WinAnsi PDF", () => {
    const doc = new mupdf.PDFDocument(fs.readFileSync(path.join(FIXTURES, "with-text.pdf")));
    const page = doc.loadPage(0) as mupdf.PDFPage;

    const map = buildGlyphMap(page);
    expect(map.length).toBeGreaterThan(0);

    // Every mapping should have valid data
    for (const m of map) {
      expect(m.char).toBeTruthy();
      expect(m.hexStart).toBeGreaterThanOrEqual(0);
      expect(m.hexEnd).toBeGreaterThan(m.hexStart);
    }

    // Text should read correctly
    const text = map.map(m => m.char).join("");
    expect(text).toContain("Invoice #12345");
    expect(text).toContain("John Smith");

    console.log(`Mapped ${map.length} glyphs`);
    console.log(`Text: "${text.substring(0, 60)}..."`);
  });

  it("finds selection by position for WinAnsi PDF", () => {
    const doc = new mupdf.PDFDocument(fs.readFileSync(path.join(FIXTURES, "with-text.pdf")));
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const map = buildGlyphMap(page);

    // Find "John Smith" — get its y-coordinate from the map
    const johnIdx = map.findIndex(m => m.char === "J" &&
      map.slice(map.indexOf(m), map.indexOf(m) + 10).map(m2 => m2.char).join("") === "John Smith");
    expect(johnIdx).toBeGreaterThan(-1);
    const johnY = map[johnIdx].y;

    const selection = findMappingsForSelection(map, "John Smith", map[johnIdx].x, johnY);
    expect(selection).not.toBeNull();
    expect(selection!.length).toBe(10);
    expect(selection!.map(m => m.char).join("")).toBe("John Smith");
  });

  it("edits mapped glyphs in WinAnsi PDF (literal strings)", () => {
    const doc = new mupdf.PDFDocument(fs.readFileSync(path.join(FIXTURES, "with-text.pdf")));
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const map = buildGlyphMap(page);

    // Find "John"
    const johnIdx = map.findIndex(m => m.char === "J" &&
      map.slice(map.indexOf(m), map.indexOf(m) + 4).map(m2 => m2.char).join("") === "John");
    const johnMappings = map.slice(johnIdx, johnIdx + 4);

    // Read the stream
    const stream = page.getObject().get("Contents").readStream().asString();
    const streams = [stream];

    // Replace "John" with "Jane"
    const edited = editMappedGlyphs(streams, johnMappings, ["J", "a", "n", "e"]);
    expect(edited[0]).toContain("Jane");
    expect(edited[0]).not.toContain("John");
  });

  it("builds glyph map for Type0/hex PDF (invoice)", () => {
    const pdfPath = "/Users/saladi/Downloads/Invoice 1310.pdf";
    if (!fs.existsSync(pdfPath)) { console.log("Invoice not found, skipping"); return; }

    const doc = new mupdf.PDFDocument(fs.readFileSync(pdfPath));
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const map = buildGlyphMap(page);

    expect(map.length).toBeGreaterThan(0);

    const text = map.map(m => m.char).join("");
    expect(text).toContain("Neelyx");
    expect(text).toContain("www.neelyx.com");
    expect(text).toContain("accounting");

    // All hex entries should be hex
    const hexEntries = map.filter(m => m.isHex);
    expect(hexEntries.length).toBeGreaterThan(0);
    console.log(`Mapped ${map.length} glyphs (${hexEntries.length} hex)`);
  });

  it("disambiguates 'com' in different lines by y-coordinate", () => {
    const pdfPath = "/Users/saladi/Downloads/Invoice 1310.pdf";
    if (!fs.existsSync(pdfPath)) { console.log("Invoice not found, skipping"); return; }

    const doc = new mupdf.PDFDocument(fs.readFileSync(pdfPath));
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const map = buildGlyphMap(page);

    // Find all "com" occurrences
    const comPositions: Array<{ idx: number; y: number; context: string }> = [];
    for (let i = 0; i <= map.length - 3; i++) {
      if (map[i].char === "c" && map[i+1].char === "o" && map[i+2].char === "m") {
        const context = map.slice(Math.max(0, i-10), i+13).map(m => m.char).join("");
        comPositions.push({ idx: i, y: map[i].y, context });
      }
    }

    console.log(`Found ${comPositions.length} "com" occurrences:`);
    for (const cp of comPositions) {
      console.log(`  y=${cp.y.toFixed(1)}: "...${cp.context}..."`);
    }

    // There should be at least 2 (accounting@neelyx.com and www.neelyx.com)
    expect(comPositions.length).toBeGreaterThanOrEqual(2);

    // Different y-coordinates should distinguish them
    if (comPositions.length >= 2) {
      expect(comPositions[0].y).not.toBeCloseTo(comPositions[1].y, 0);
    }

    // findMappingsForSelection should pick the right one based on y
    for (const cp of comPositions) {
      const sel = findMappingsForSelection(map, "com", map[cp.idx].x, cp.y);
      expect(sel).not.toBeNull();
      expect(sel![0].y).toBeCloseTo(cp.y, 0);
    }
  });
});
