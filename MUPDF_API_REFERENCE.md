# MuPDF.js WASM API Reference

This document covers the MuPDF JavaScript API surface relevant to PDF Canvas. It's based on MuPDF 1.27.x documentation and the `mupdf` npm package.

**Source documentation**: https://mupdf.readthedocs.io/en/latest/reference/javascript/types/
**npm package**: https://www.npmjs.com/package/mupdf
**GitHub**: https://github.com/ArtifexSoftware/mupdf.js
**License**: AGPL-3.0 or commercial (Artifex)

**Important**: MuPDF.js is ESM-only. Use `import mupdf from "mupdf"`.

---

## Document Lifecycle

```javascript
import mupdf from "mupdf";

// Open a PDF from an ArrayBuffer
var doc = mupdf.PDFDocument.openDocument(buffer, "application/pdf");

// Page count
var n = doc.countPages();

// Load a specific page (0-indexed)
var page = doc.loadPage(pageNumber);

// Save document
var buf = doc.saveToBuffer("incremental");  // options: "incremental", "compress", "clean", etc.
var bytes = buf.asUint8Array();

// Insert page from another document
doc.insertPage(index, doc.addPage([0, 0, 595, 842], 0, null, ""));

// Delete page
doc.deletePage(pageNumber);

// Graft (copy) page from another document
doc.graftPage(destinationIndex, sourceDoc, sourcePageNumber);
```

### Save Options

- `"incremental"` — append changes to end of file (fast, preserves structure)
- `"compress"` — compress streams
- `"clean"` — clean and sanitize
- `"linearize"` — MuPDF does NOT support writing linearized files (use qpdf for this)

---

## Page Rendering

```javascript
var page = doc.loadPage(0);

// Create a transformation matrix for scaling
// Identity matrix: [1, 0, 0, 1, 0, 0]
// Scale by 2x: [2, 0, 0, 2, 0, 0]
// For DPI-based scaling: scale = desiredDPI / 72
var scale = 150 / 72;  // 150 DPI
var matrix = [scale, 0, 0, scale, 0, 0];

// Render to Pixmap
var pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false);

// Get as ImageData (can paint to canvas via ctx.putImageData())
var imageData = new ImageData(
  new Uint8ClampedArray(pixmap.getPixels()),
  pixmap.getWidth(),
  pixmap.getHeight()
);

// Get page dimensions (in PDF points, 72 points = 1 inch)
var bounds = page.getBounds();  // [x1, y1, x2, y2]
var width = bounds[2] - bounds[0];
var height = bounds[3] - bounds[1];
```

### Coordinate System

MuPDF uses **top-left origin** (like screen coordinates). This differs from the raw PDF spec which uses bottom-left origin, but MuPDF handles the conversion internally. All coordinates you work with via the JS API are top-left origin.

---

## Annotations — Enumeration

```javascript
var page = doc.loadPage(0);
var annotations = page.getAnnotations();  // returns PDFAnnotation[]

for (var annot of annotations) {
  var type = annot.getType();     // "Text", "FreeText", "Square", etc.
  var rect = annot.getRect();     // [x1, y1, x2, y2]
  var hasRect = annot.hasRect();  // can this type be moved via setRect?
  console.log(type, rect);
}
```

### Annotation Types (string values from getType())

**Comment/markup types:**
- `"Text"` — sticky note icon with popup
- `"Highlight"` — highlighted text
- `"Underline"` — underlined text
- `"StrikeOut"` — strikethrough text
- `"Squiggly"` — squiggly underline

**Geometric types:**
- `"FreeText"` — text box
- `"Square"` — rectangle
- `"Circle"` — ellipse
- `"Line"` — line (with optional arrowheads)
- `"Polygon"` — closed polygon
- `"PolyLine"` — open polyline
- `"Ink"` — freehand drawing

**Other types:**
- `"Stamp"` — stamp annotation
- `"Caret"` — caret (text insertion indicator)
- `"FileAttachment"` — attached file
- `"Sound"` — audio annotation
- `"Redact"` — redaction mark (special handling)

**Special types (handled with separate APIs):**
- `"Link"` — use page link APIs
- `"Widget"` — use page.getWidgets()
- `"Popup"` — display-only, associated with parent annotation

---

## Annotations — Position & Size

```javascript
// Check if annotation supports direct rect manipulation
annot.hasRect();  // true for Square, Circle, FreeText, Text, Stamp, etc.
                  // false for Line, Polygon, Ink (use vertices/inkList instead)

// Get bounding box
var rect = annot.getRect();  // [x1, y1, x2, y2]

// Set bounding box (MOVE or RESIZE)
annot.setRect([x1, y1, x2, y2]);

// For annotations where hasRect() is false, the Rect is auto-calculated
// from vertices, inkList, quadPoints, or line endpoints.
```

### Type-specific positioning:

**Line annotations:**
```javascript
annot.getLine();                           // [[x1,y1], [x2,y2]]
annot.setLine([[x1,y1], [x2,y2]]);
annot.getLineEndingStyles();               // e.g. ["None", "OpenArrow"]
annot.setLineEndingStyles("None", "OpenArrow");
// Available styles: "None", "Square", "Circle", "Diamond",
//   "OpenArrow", "ClosedArrow", "Butt",
//   "ROpenArrow", "RClosedArrow", "Slash"
```

**Polygon/Polyline annotations:**
```javascript
annot.getVertices();                       // [[x1,y1], [x2,y2], ...]
annot.setVertices([[x1,y1], [x2,y2], ...]); 
```

**Ink annotations:**
```javascript
annot.getInkList();    // [stroke1, stroke2, ...] where each stroke is [[x,y], [x,y], ...]
annot.setInkList([
  [[0,0], [10,0], [10,10], [0,10], [0,0]],   // stroke 1
  [[10,0], [0,10]],                            // stroke 2
]);
annot.clearInkList();
annot.addInkListStroke();                      // add new empty stroke
annot.addInkListStrokeVertex([x, y]);          // append vertex to last stroke
```

**Text markup annotations (Highlight, Underline, StrikeOut, Squiggly):**
```javascript
annot.getQuadPoints();    // [[x1,y1,x2,y2,x3,y3,x4,y4], ...] — 4 points per quad
annot.setQuadPoints([...]);
annot.clearQuadPoints();
annot.addQuadPoint([x1,y1,x2,y2,x3,y3,x4,y4]);

// QuadPoint ordering: upper-left, upper-right, lower-left, lower-right
// Each quad defines one highlighted region (typically one line of text)
// Multiple quads = multi-line highlight

// IMPORTANT: When moving a text markup annotation, shift ALL quad point
// coordinates by the drag delta. MuPDF auto-updates the parent Rect.
```

---

## Annotations — Appearance & Style

```javascript
// Color (border or main color depending on type)
annot.getColor();                    // [r, g, b] normalized 0-1, or [] for transparent
annot.setColor([1, 0, 0]);          // red
annot.setColor([]);                  // transparent

// Interior/fill color
annot.hasInteriorColor();            // check if supported
annot.getInteriorColor();
annot.setInteriorColor([0.5, 0.5, 1]);

// Opacity
annot.getOpacity();                  // 0-1
annot.setOpacity(0.5);

// Border width
annot.getBorderWidth();
annot.setBorderWidth(2);

// Border effect (e.g., cloudy borders)
annot.getBorderEffect();             // "None" or "Cloudy"
annot.setBorderEffect("Cloudy");
annot.getBorderEffectIntensity();
annot.setBorderEffectIntensity(2);

// Border dash pattern
annot.getBorderDashCount();
annot.getBorderDashItem(index);
annot.clearBorderDash();
annot.addBorderDashItem(length);
```

---

## Annotations — Text Content

```javascript
// Contents (comment text for all annotation types)
annot.getContents();                 // plain text string
annot.setContents("Updated comment text");

// Rich text (if supported)
annot.hasRichContents();             // check
annot.getRichContents();
annot.setRichContents("<body>...</body>");
annot.getDefaultRichStyle();
annot.setDefaultRichStyle("font: 12pt Helvetica; color: red");

// FreeText default appearance
annot.getDefaultAppearance();        // { font: "Helv", size: 12, color: [0,0,0] }
annot.setDefaultAppearance("Helv", 14, [0, 0, 0]);
// Common font names: "Helv" (Helvetica), "TiRo" (Times Roman), "Cour" (Courier)

// Text justification (FreeText only)
annot.hasQuadding();
annot.getQuadding();                 // 0=left, 1=center, 2=right
annot.setQuadding(1);                // center
```

---

## Annotations — Metadata

```javascript
// Author
annot.getAuthor();
annot.setAuthor("John Doe");

// Modification date
annot.getModificationDate();         // Date object
annot.setModificationDate(new Date());

// Creation date
annot.getCreationDate();
annot.setCreationDate(new Date());

// Open state (for Text/sticky note annotations)
annot.getIsOpen();                   // is popup displayed open?
annot.setIsOpen(true);

// Icon (for Text annotations)
annot.getIcon();                     // "Note", "Comment", "Help", "Insert", etc.
annot.setIcon("Comment");
// Available icons: "Comment", "Help", "Insert", "Key", "NewParagraph",
//                  "Note", "Paragraph"
```

---

## Annotations — CRUD

```javascript
// Create new annotation
var annot = page.createAnnotation("FreeText");
annot.setRect([100, 100, 300, 150]);
annot.setContents("Hello World");
annot.setDefaultAppearance("Helv", 16, [0, 0, 0]);
annot.setColor([1, 0, 0]);

// Another example: sticky note
var note = page.createAnnotation("Text");
note.setRect([200, 10, 250, 50]);
note.setContents("Please review this section");
note.setColor([1, 1, 0]);  // yellow
note.setIcon("Note");

// Delete annotation
page.deleteAnnotation(annot);

// Update (regenerate appearance stream)
annot.update();
// Note: setting properties via the PDFAnnotation interface auto-flags
// the annotation for appearance regeneration. You usually don't need
// to call update() explicitly — just re-render the page.
```

---

## Annotations — Appearance Stream

```javascript
// Check if needs new appearance
annot.getNeedsNewAppearance();

// Flag for regeneration (usually automatic)
annot.setNeedsNewAppearance();

// Update appearance stream
annot.update();
// This is called automatically when you re-render the page.
// Only call explicitly if you need to inspect the appearance before rendering.

// Get the underlying PDF object (for advanced manipulation)
var obj = annot.getObject();
// This returns a PDFObject that gives you direct access to the
// annotation dictionary — useful for reading IRT references,
// popup associations, and other properties not exposed via the high-level API.
```

---

## Annotations — Pointer Events

MuPDF provides methods for annotation hit-testing and event handling:

```javascript
annot.eventEnter();    // cursor enters annotation area
annot.eventExit();     // cursor exits
annot.eventDown();     // button pressed in annotation area
annot.eventUp();       // button released
annot.eventFocus();    // annotation gains focus
annot.eventBlur();     // annotation loses focus
```

These trigger appearance changes (e.g., button press state) and any JavaScript actions attached to the annotation. Useful for form widgets.

---

## Annotations — Redaction

```javascript
// Create redaction annotation
var redact = page.createAnnotation("Redact");
redact.setRect([100, 100, 300, 130]);

// Apply single redaction (permanently removes content under it)
redact.applyRedaction();

// Apply all redactions on page
page.applyRedactions();

// IMPORTANT: Redaction is destructive and permanent after saving.
// The content under the redaction area is removed from the PDF.
```

---

## Form Widgets

Widgets (form fields) are enumerated separately from annotations:

```javascript
var widgets = page.getWidgets();  // PDFWidget[]

for (var widget of widgets) {
  var type = widget.getFieldType();   // "text", "button", "choice", "signature"
  var name = widget.getFieldName();   // field name
  var value = widget.getValue();      // field value
  var rect = widget.getRect();        // [x1, y1, x2, y2]
}

// Set field value
widget.setValue("new value");

// Widget positioning works the same as annotations:
widget.getRect();
widget.setRect([x1, y1, x2, y2]);
```

### Widget Types

- `"text"` — text input field
- `"button"` — checkbox, radio button, or push button
- `"choice"` — dropdown or list box
- `"signature"` — signature field

---

## Text Extraction (for future text-selection-based highlights)

```javascript
var stext = page.toStructuredText();

// Search for text
var results = stext.search("search term");
// Returns array of quad arrays: [[x1,y1,x2,y2,x3,y3,x4,y4], ...]
// These quads can be used directly as QuadPoints for highlight annotations

// Walk the text structure
stext.walk({
  onChar: function(c, origin, font, size, quad) {
    // c = character string
    // origin = [x, y] baseline origin
    // font = font name
    // size = font size
    // quad = [x1,y1,...,x8,y8] character bounding quad
  }
});
```

---

## PDF Object Access (Low-level)

For properties not exposed via the high-level API (like IRT references for reply chains):

```javascript
// Get the annotation's underlying PDF dictionary
var obj = annot.getObject();

// Read a property
var irt = obj.get("IRT");         // In Reply To reference
var subtype = obj.get("Subtype"); // annotation subtype as PDF name

// Resolve indirect references
if (irt) {
  var parentAnnotObj = irt.resolve();
  // Now you can read properties of the parent annotation
}

// Get the document trailer (for metadata access)
var trailer = doc.getTrailer();
var info = trailer.get("Info").resolve();
var title = info.get("Title");

// Modify PDF objects directly
obj.put("Contents", "new text");
```

---

## Complete Annotation Creation Examples

```javascript
// Circle with cloudy border
var circle = page.createAnnotation("Circle");
circle.setRect([100, 100, 300, 300]);
circle.setColor([0, 1, 1]);
circle.setInteriorColor([0.5, 0, 0]);
circle.setBorderEffect("Cloudy");
circle.setBorderEffectIntensity(4);
circle.setBorderWidth(10);

// Polygon
var poly = page.createAnnotation("Polygon");
poly.setColor([1, 0, 0]);
poly.setInteriorColor([1, 1, 0]);
poly.setVertices([[100,100], [200,50], [300,100], [250,200], [150,200]]);

// Highlight with comment
var highlight = page.createAnnotation("Highlight");
highlight.setColor([1, 1, 0]);  // yellow
highlight.setOpacity(0.5);
highlight.setQuadPoints([
  [100, 200, 300, 200, 100, 215, 300, 215]  // one quad for one line
]);
highlight.setContents("Important finding");
highlight.setAuthor("Reviewer");

// Ink (freehand)
var ink = page.createAnnotation("Ink");
ink.setColor([0, 0, 1]);
ink.setBorderWidth(2);
ink.setInkList([
  [[100,100], [110,95], [120,100], [130,105], [140,100]]
]);

// Line with arrow
var line = page.createAnnotation("Line");
line.setLine([[100, 100], [300, 200]]);
line.setColor([1, 0, 0]);
line.setBorderWidth(2);
line.setLineEndingStyles("None", "OpenArrow");
line.setContents("See this section");

// Stamp
var stamp = page.createAnnotation("Stamp");
stamp.setRect([100, 100, 300, 200]);
stamp.setIcon("Approved");
// Standard stamp icons: "Approved", "Experimental", "NotApproved",
//   "AsIs", "Expired", "NotForPublicRelease",
//   "Confidential", "Final", "Sold", "Departmental",
//   "ForComment", "TopSecret", "Draft", "ForPublicRelease"
```

---

## Web Worker Usage Pattern

```javascript
// worker.ts
import mupdf from "mupdf";

let doc = null;

self.onmessage = async function(e) {
  const { type, ...params } = e.data;
  
  switch (type) {
    case "open": {
      doc = mupdf.PDFDocument.openDocument(params.data, "application/pdf");
      self.postMessage({ type: "opened", pageCount: doc.countPages() });
      break;
    }
    case "renderPage": {
      const page = doc.loadPage(params.page);
      const scale = params.scale || (150 / 72);
      const pixmap = page.toPixmap([scale,0,0,scale,0,0], mupdf.ColorSpace.DeviceRGB, false);
      const w = pixmap.getWidth();
      const h = pixmap.getHeight();
      const pixels = pixmap.getPixels();  // Uint8Array (RGB)
      
      // Convert RGB to RGBA for ImageData
      const rgba = new Uint8ClampedArray(w * h * 4);
      for (let i = 0, j = 0; i < pixels.length; i += 3, j += 4) {
        rgba[j]   = pixels[i];
        rgba[j+1] = pixels[i+1];
        rgba[j+2] = pixels[i+2];
        rgba[j+3] = 255;
      }
      
      const imageData = new ImageData(rgba, w, h);
      const bitmap = await createImageBitmap(imageData);
      self.postMessage({ type: "pageRendered", page: params.page, bitmap }, [bitmap]);
      break;
    }
    case "getAnnotations": {
      const page = doc.loadPage(params.page);
      const annots = page.getAnnotations();
      const dtos = annots.map((a, i) => ({
        id: `${params.page}-${i}`,
        type: a.getType(),
        rect: a.getRect(),
        color: a.getColor(),
        opacity: a.getOpacity(),
        contents: a.getContents(),
        borderWidth: a.getBorderWidth(),
        hasRect: a.hasRect(),
        author: a.getAuthor?.() || "",
        // ... extract other properties as needed
      }));
      self.postMessage({ type: "annotations", page: params.page, annots: dtos });
      break;
    }
    case "save": {
      const buf = doc.saveToBuffer(params.options || "incremental");
      const bytes = buf.asUint8Array();
      self.postMessage({ type: "saved", buffer: bytes.buffer }, [bytes.buffer]);
      break;
    }
  }
};
```

---

## Vite Configuration Notes

```typescript
// vite.config.ts
import { defineConfig } from 'vite';

export default defineConfig({
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['mupdf'],  // Don't try to pre-bundle the WASM module
  },
  build: {
    target: 'esnext',     // MuPDF.js uses modern JS features
  },
});

// The mupdf package includes its WASM binary. Vite should handle
// the WASM file automatically, but you may need to configure
// assetsInclude or use vite-plugin-wasm if there are loading issues.
```

---

## Key Gotchas

1. **MuPDF.js is ESM-only** — no `require()`, only `import`.

2. **Pixmap getPixels() returns RGB, not RGBA** — you must add an alpha channel before creating ImageData. Alternatively, pass `true` for the alpha parameter in `toPixmap()` to get RGBA directly, but then transparent areas start transparent (not white).

3. **Annotation indexing** — `getAnnotations()` returns an array, but annotations don't have stable IDs. If you delete an annotation, indices shift. Use a combination of page number + annotation index, or read the underlying PDF object reference for stability.

4. **QuadPoints coordinate order** — PDF spec says upper-left, upper-right, lower-left, lower-right (8 numbers per quad). Some PDFs get this wrong. MuPDF handles the common cases.

5. **setRect() on text markup annotations** — For Highlight/Underline/etc., `hasRect()` returns false because the Rect is auto-calculated from QuadPoints. To move these, modify the QuadPoints directly.

6. **Incremental save preserves signatures** — Using `"incremental"` save mode appends changes without modifying the original file content, which preserves digital signatures on unchanged content.

7. **Memory management** — MuPDF objects are backed by C memory managed via the WASM runtime. In long sessions with many document operations, be mindful of keeping references to old page/annotation objects. Load pages fresh when needed.

8. **Font names in setDefaultAppearance** — Use the internal PDF font names: "Helv" (Helvetica), "TiRo" (Times Roman), "Cour" (Courier). For custom fonts, you'd need to embed them via the low-level PDF object API.
