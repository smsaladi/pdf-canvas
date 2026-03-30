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

// 7. with-text.pdf — page with actual text content in the content stream
function createWithText() {
  const doc = new mupdf.PDFDocument();

  // Create a font resource
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));

  // Build resources dictionary
  const resources = doc.newDictionary();
  const fonts = doc.newDictionary();
  fonts.put("F1", font);
  resources.put("Font", fonts);

  // PDF content stream with text operators
  const contentStream = `
BT
/F1 24 Tf
72 700 Td
(Invoice #12345) Tj
0 -36 Td
/F1 14 Tf
(Date: January 15, 2024) Tj
0 -24 Td
(Customer: John Smith) Tj
0 -24 Td
(Amount: $1,234.56) Tj
0 -48 Td
/F1 12 Tf
(Thank you for your business.) Tj
0 -20 Td
(Please remit payment within 30 days.) Tj
ET
`;

  const pageObj = doc.addPage([0, 0, 612, 792], 0, resources, contentStream);
  doc.insertPage(-1, pageObj);
  save(doc, "with-text.pdf");
}

// 8. with-image.pdf — page with an embedded image XObject
function createWithImage() {
  const doc = new mupdf.PDFDocument();

  // Create a 4x4 red pixel image as raw RGB data
  const width = 4, height = 4;
  const pixels = new Uint8Array(width * height * 3);
  for (let i = 0; i < pixels.length; i += 3) {
    pixels[i] = 255;     // R
    pixels[i + 1] = 0;   // G
    pixels[i + 2] = 0;   // B
  }

  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], false);
  const pxData = pixmap.getPixels();
  pxData.set(pixels);
  const image = new mupdf.Image(pixmap);
  const imgRef = doc.addImage(image);

  // Build page with content stream that draws the image
  const resources = doc.newDictionary();
  const xobjects = doc.newDictionary();
  xobjects.put("Im0", imgRef);
  resources.put("XObject", xobjects);

  const contentStream = `q\n200 0 0 150 100 300 cm\n/Im0 Do\nQ`;
  const pageObj = doc.addPage([0, 0, 612, 792], 0, resources, contentStream);
  doc.insertPage(-1, pageObj);

  save(doc, "with-image.pdf");
}

// 9. with-type0-text.pdf — page with WinAnsi text via addSimpleFont (TrueType),
//    plus a manually constructed Type0/Identity-H font with hex glyph IDs and ToUnicode CMap.
//    This tests the two major encoding families found in real-world PDFs.
function createWithType0Text() {
  const doc = new mupdf.PDFDocument();

  // --- Font F1: Standard WinAnsi TrueType via addSimpleFont ---
  const winAnsiFont = doc.addSimpleFont(new mupdf.Font("Helvetica"));

  // --- Font F2: Type0/Identity-H font built from raw PDF objects ---
  // We create a minimal Type0 font that maps glyph IDs to Unicode via a ToUnicode CMap.
  // The text "Hello World" will be encoded as hex glyph IDs.

  // Define the glyph ID mapping: we use simple 1:1 mapping where GID = Unicode codepoint
  const testText = "Hello World";
  const chars = [...new Set(testText)];
  const gidMap: Record<string, number> = {};
  for (const ch of chars) {
    gidMap[ch] = ch.charCodeAt(0);
  }

  // Build ToUnicode CMap
  const bfcharEntries = chars
    .map(ch => `<${ch.charCodeAt(0).toString(16).padStart(4, "0")}> <${ch.charCodeAt(0).toString(16).padStart(4, "0")}>`)
    .join("\n");

  const cmapStream = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${chars.length} beginbfchar
${bfcharEntries}
endbfchar
endcmap
CMapSpelling CMapName /CMap defineresource pop
end
end`;

  // Create the ToUnicode stream object
  const toUnicodeObj = doc.newDictionary();
  const toUnicodeRef = doc.addStream(cmapStream, toUnicodeObj);

  // Use the same base font (Helvetica) but wrap it as Type0
  const baseFont = doc.addSimpleFont(new mupdf.Font("Helvetica"));

  // Create CIDFont descriptor (Type2 = TrueType-based CID font)
  const cidFontDict = doc.newDictionary();
  cidFontDict.put("Type", doc.newName("Font"));
  cidFontDict.put("Subtype", doc.newName("CIDFontType2"));
  cidFontDict.put("BaseFont", doc.newName("Helvetica-Identity"));

  const cidSystemInfo = doc.newDictionary();
  cidSystemInfo.put("Registry", doc.newString("Adobe"));
  cidSystemInfo.put("Ordering", doc.newString("Identity"));
  cidSystemInfo.put("Supplement", doc.newInteger(0));
  cidFontDict.put("CIDSystemInfo", cidSystemInfo);

  // Build the Type0 font dictionary
  const type0Font = doc.newDictionary();
  type0Font.put("Type", doc.newName("Font"));
  type0Font.put("Subtype", doc.newName("Type0"));
  type0Font.put("BaseFont", doc.newName("Helvetica-Identity"));
  type0Font.put("Encoding", doc.newName("Identity-H"));

  const descendantFonts = doc.newArray();
  const cidFontRef = doc.addObject(cidFontDict);
  descendantFonts.push(cidFontRef);
  type0Font.put("DescendantFonts", descendantFonts);
  type0Font.put("ToUnicode", toUnicodeRef);

  const type0FontRef = doc.addObject(type0Font);

  // Build resources with both fonts
  const resources = doc.newDictionary();
  const fonts = doc.newDictionary();
  fonts.put("F1", winAnsiFont);
  fonts.put("F2", type0FontRef);
  resources.put("Font", fonts);

  // Build hex-encoded text for "Hello World" using glyph IDs
  const hexChars = [...testText].map(ch => {
    const gid = gidMap[ch];
    return `<${gid.toString(16).padStart(4, "0")}> Tj`;
  });

  // Content stream with both encoding styles
  const contentStream = `
BT
/F1 18 Tf
72 700 Td
(WinAnsi encoded text: Hello World) Tj
0 -30 Td
(This uses standard literal string encoding) Tj
ET
BT
/F2 18 Tf
72 620 Td
${hexChars.join("\n")}
ET
`;

  const pageObj = doc.addPage([0, 0, 612, 792], 0, resources, contentStream);
  doc.insertPage(-1, pageObj);
  save(doc, "with-type0-text.pdf");
}

// 10. with-multiline-text.pdf — page with repeated text on multiple lines at different Y positions
function createWithMultilineText() {
  const doc = new mupdf.PDFDocument();

  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  const resources = doc.newDictionary();
  const fonts = doc.newDictionary();
  fonts.put("F1", font);
  resources.put("Font", fonts);

  // Multiple lines with some text appearing on more than one line
  const contentStream = `
BT
/F1 14 Tf
72 720 Td
(Line 1: The quick brown fox jumps over the lazy dog) Tj
0 -24 Td
(Line 2: A different sentence with unique words) Tj
0 -24 Td
(Line 3: The quick brown fox jumps over the lazy dog) Tj
0 -24 Td
(Line 4: Yet another line of text for testing) Tj
0 -24 Td
(Line 5: The quick brown fox jumps over the lazy dog) Tj
0 -24 Td
(Line 6: Final line with distinct content here) Tj
ET
`;

  const pageObj = doc.addPage([0, 0, 612, 792], 0, resources, contentStream);
  doc.insertPage(-1, pageObj);
  save(doc, "with-multiline-text.pdf");
}

// 11. with-styled-text.pdf — page with bold, italic, and regular text using different font resources
function createWithStyledText() {
  const doc = new mupdf.PDFDocument();

  // Create three font resources: regular, bold, italic
  const regularFont = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  const boldFont = doc.addSimpleFont(new mupdf.Font("Helvetica-Bold"));
  const italicFont = doc.addSimpleFont(new mupdf.Font("Helvetica-Oblique"));

  const resources = doc.newDictionary();
  const fonts = doc.newDictionary();
  fonts.put("F1", regularFont);
  fonts.put("F2", boldFont);
  fonts.put("F3", italicFont);
  resources.put("Font", fonts);

  // Content stream switching between fonts
  const contentStream = `
BT
/F1 16 Tf
72 700 Td
(Regular text introduction) Tj
0 -28 Td
/F2 16 Tf
(Bold heading text) Tj
0 -28 Td
/F3 16 Tf
(Italic emphasis text) Tj
0 -28 Td
/F1 12 Tf
(Back to regular smaller text for body content) Tj
0 -20 Td
/F2 12 Tf
(Bold label:) Tj
( ) Tj
/F1 12 Tf
(followed by regular value) Tj
0 -20 Td
/F3 12 Tf
(Italic note:) Tj
( ) Tj
/F1 12 Tf
(with regular continuation) Tj
ET
`;

  const pageObj = doc.addPage([0, 0, 612, 792], 0, resources, contentStream);
  doc.insertPage(-1, pageObj);
  save(doc, "with-styled-text.pdf");
}

// 12. with-type0-kerned-text.pdf — Type0/Identity-H with TJ arrays containing
//     multi-glyph hex strings and kerning values, mimicking Chrome/iText output.
//     Also includes two Type0 fonts (regular + bold) to test font targeting.
function createWithType0KernedText() {
  const doc = new mupdf.PDFDocument();

  // Build two Type0 fonts: F1 (regular) and F2 (bold)
  const testChars = [..."Hello World Test Line Bold"];
  const uniqueChars = [...new Set(testChars)];

  function buildType0Font(name: string): mupdf.PDFObject {
    const bfcharEntries = uniqueChars
      .map(ch => `<${ch.charCodeAt(0).toString(16).padStart(4, "0")}> <${ch.charCodeAt(0).toString(16).padStart(4, "0")}>`)
      .join("\n");
    const cmapStream = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000><FFFF>
endcodespacerange
${uniqueChars.length} beginbfchar
${bfcharEntries}
endbfchar
endcmap
CMapSpelling CMapName /CMap defineresource pop
end
end`;
    const toUnicodeRef = doc.addStream(cmapStream, doc.newDictionary());
    const cidFontDict = doc.newDictionary();
    cidFontDict.put("Type", doc.newName("Font"));
    cidFontDict.put("Subtype", doc.newName("CIDFontType2"));
    cidFontDict.put("BaseFont", doc.newName(name));
    const cidSysInfo = doc.newDictionary();
    cidSysInfo.put("Registry", doc.newString("Adobe"));
    cidSysInfo.put("Ordering", doc.newString("Identity"));
    cidSysInfo.put("Supplement", doc.newInteger(0));
    cidFontDict.put("CIDSystemInfo", cidSysInfo);
    // Add DW (default width)
    cidFontDict.put("DW", doc.newInteger(1000));

    const type0 = doc.newDictionary();
    type0.put("Type", doc.newName("Font"));
    type0.put("Subtype", doc.newName("Type0"));
    type0.put("BaseFont", doc.newName(name));
    type0.put("Encoding", doc.newName("Identity-H"));
    const descFonts = doc.newArray();
    descFonts.push(doc.addObject(cidFontDict));
    type0.put("DescendantFonts", descFonts);
    type0.put("ToUnicode", toUnicodeRef);
    return doc.addObject(type0);
  }

  const f1Ref = buildType0Font("TestRegular");
  const f2Ref = buildType0Font("TestBold");

  const resources = doc.newDictionary();
  const fonts = doc.newDictionary();
  fonts.put("F1", f1Ref);
  fonts.put("F2", f2Ref);
  resources.put("Font", fonts);

  // Helper: encode text as multi-glyph hex string
  const toHex = (text: string) => [...text].map(ch => ch.charCodeAt(0).toString(16).padStart(4, "0")).join("");

  // Content stream: TJ arrays with multi-glyph hex + kerning
  const contentStream = `
BT
/F1 18 Tf
72 700 Td
[<${toHex("Hello")}> -50 <${toHex(" World")}>] TJ
ET
BT
/F1 14 Tf
72 660 Td
[<${toHex("Test")}> -30 <${toHex(" Line")}>] TJ
ET
BT
/F2 16 Tf
72 620 Td
[<${toHex("Bold")}> -40 <${toHex(" Text")}>] TJ
ET
`;

  const pageObj = doc.addPage([0, 0, 612, 792], 0, resources, contentStream);
  doc.insertPage(-1, pageObj);
  save(doc, "with-type0-kerned-text.pdf");
}

// Run all generators
createBlank();
createWithAnnotations();
createWithComments();
createWithForm();
createMultiPage();
createRotated();
createWithText();
createWithImage();
createWithType0Text();
createWithMultilineText();
createWithStyledText();
createWithType0KernedText();

console.log("\nAll fixtures generated successfully!");
