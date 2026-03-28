# PDF Canvas — Research: Existing Open-Source PDF Editor Projects

This document captures research on existing open-source browser-based and desktop PDF editing projects. It's intended as a reference during development — these projects contain code, architectural patterns, and lessons learned that may be useful.

---

## 1. ts-pdf (yermolim/ts-pdf)

**URL**: https://github.com/yermolim/ts-pdf
**License**: AGPL-3.0
**Language**: TypeScript (99.4%)
**Stars**: ~99 | **Forks**: ~21 | **Commits**: 483
**Status**: Appears dormant (last significant activity ~2023)

### What It Does

A PDF.js-based viewer with a custom annotation interaction layer. This is the most architecturally ambitious open-source browser PDF annotation editor.

### Architecture (Key Insight)

1. Has its own **custom PDF parser written from scratch** in TypeScript
2. Strips supported annotations out of the source PDF
3. Hands the "clean" PDF to PDF.js for page rendering
4. Renders extracted annotations as **SVG overlays** on top of pages using a custom PDF appearance stream renderer
5. Users interact with SVG elements — select, move, resize, edit
6. Changes are written back to a new PDF byte array

### Supported Annotation Types

Ink, Stamp, Line, Square, Circle, Polygon, Polyline, Highlight, Underline, Squiggly, Strikeout, Text (note icon), FreeText

### Supported Encryption

V1R2 (RC4 40-bit), V2R3 (RC4 128-bit), V4R4 (RC4/AES 128-bit)

### Key Features

- Annotation import/export to JSON DTOs (useful for database storage)
- PDF spec v1.7 compliance
- Encrypted PDF support
- Shadow DOM to minimize CSS conflicts
- Web Workers for parsing (background threads)
- Keyboard shortcuts
- Document comparison mode (side-by-side diff)
- Responsive UI with touch support

### External Dependencies

PDF.js (pdfjs-dist), CryptoES, pako (compression), uuid

### What We Can Learn From It

- **SVG overlay approach for annotations** — proven to work, good interaction model
- **Custom appearance stream renderer** — this is the hard part they solved
- **The annotation DTO pattern** — clean serialization for import/export
- **Their TODO list reveals pain points**: no AES-256, no LZW, incomplete encoding support, no localization, limited tests

### Why We're Not Using It Directly

- Reimplements a PDF parser in TypeScript — fragile compared to MuPDF's 20-year C engine
- AGPL license (same as MuPDF, so no disadvantage)
- Appears unmaintained
- Missing many annotation types and encoding algorithms

---

## 2. PDFJsAnnotations (RavishaHesh/PDFJsAnnotations)

**URL**: https://github.com/RavishaHesh/PDFJsAnnotations
**License**: MIT
**Language**: JavaScript (vanilla, with jQuery)
**Stars**: ~377 | **Forks**: ~105 | **Commits**: 39
**Status**: Dormant (last release Dec 2020)

### What It Does

Puts a **Fabric.js canvas** on top of each PDF page rendered by PDF.js. Lets users add text, arrows, rectangles, images, and freehand drawing. Objects can be selected, moved, resized, and rotated via Fabric.js's built-in interaction.

### Architecture

1. PDF.js renders each page to a canvas
2. A Fabric.js canvas is overlaid on top
3. User interactions go through Fabric.js object model
4. State is serialized to JSON (Fabric.js format) and can be reloaded
5. Export: renders each page + annotations to a flat image → jsPDF assembles into new PDF

### Key Files (Entire Codebase)

- `pdfannotate.js` — main class (~500 lines)
- `arrow.fabric.js` — custom Fabric.js arrow shape
- `script.js` — demo UI wiring
- `index.html` — demo page

### API

```javascript
var pdf = new PDFAnnotate('container-id', 'url-to.pdf');
pdf.enableSelector();        // move/select mode
pdf.enablePencil();          // freehand draw
pdf.enableAddText();         // add text
pdf.enableAddArrow();        // add arrow
pdf.enableRectangle();       // add rectangle
pdf.addImageToCanvas();      // add image
pdf.deleteSelectedObject();  // delete selected
pdf.clearActivePage();       // clear page
pdf.savePdf();               // export as PDF (images)
pdf.serializePdf(callback);  // serialize to JSON
pdf.loadFromJSON(json);      // reload from JSON
pdf.setColor(color);         // set tool color
pdf.setBrushSize(width);     // set brush size
pdf.setFontSize(size);       // set font size
```

### Critical Limitation

**Export destroys the PDF structure.** The output PDF is a set of rasterized page images. Text selectability, form fields, bookmarks — all lost. The README acknowledges this: "exported file will be a PDF with set of images."

### What We Can Learn From It

- **Fabric.js as an interaction layer is proven** — selection, drag, resize, rotate all work out of the box
- **The API design is clean** — simple mode-switching for tools
- **JSON serialization for state** — good for undo/redo and session persistence
- **But**: Fabric.js adds ~300KB minified, and its canvas-based approach means no DOM overlays for annotations

### Why We're Not Using It

- Destroys PDF structure on export (non-starter)
- Doesn't parse existing PDF annotations (only adds new ones)
- jQuery dependency, no TypeScript, no build system
- Dormant

---

## 3. pdf-annotate.js (Instructure/Submitty/taoky fork)

**URL**: https://github.com/taoky/pdf-annotate.js (maintained fork)
**Original**: https://github.com/instructure/pdf-annotate.js (Canvas LMS)
**License**: MIT-ish (Instructure origin)
**Status**: Maintained fork was a class project; may not be actively maintained

### What It Does

Provides a low-level annotation layer for PDF.js with a pluggable `StoreAdapter` backend. Annotations are stored externally (your database), not written back into the PDF binary.

### Architecture

- Annotation layer renders on top of PDF.js pages
- `StoreAdapter` interface: you provide `getAnnotations()`, `addAnnotation()`, `deleteAnnotation()`, etc.
- Supports: text, drawing, rectangles, point annotations
- UI layer is optional — you can use just the rendering

### Key Insight

This is a **collaborative annotation** system, not a **PDF editing** system. Annotations live outside the PDF. Good for Google Docs-style commenting, bad for "edit and save the PDF."

### What We Can Learn From It

- **StoreAdapter pattern** — clean separation of annotation storage from rendering
- **The coordinate system challenges are well-documented** in their code/issues
- **Proof that PDF.js alone is insufficient** — the author documents extensive struggles with PDF.js's annotation layer

---

## 4. ElasticPDF

**URL**: https://github.com/ElasticPDF/elasticpdf | https://www.elasticpdf.com/
**License**: Commercial (not open source despite GitHub presence)
**Language**: JavaScript (vanilla, built on pdf.js-dist)

### What It Does

The most feature-complete browser-based PDF annotation editor found. Pure JavaScript on top of pdf.js-dist. Supports:

- Create text annotations by inserting and dragging (all languages)
- Modify font shape, font size by dragging
- Create polygons: arrows, lines, rectangles, circles, checkmarks, stamps
- Modify color, size, position, orientation of all annotations
- Hyperlink creation (URL, page number, online document)
- Partial eraser for annotation objects
- Undo/redo (10 steps)
- Export/import annotations as JSON for multi-device sync
- Annotations written into PDF in standard format
- Page operations: move up/down, pin, insert blank, delete

### Architecture

Adds several JS files to the pdf.js-dist code package. No online dependencies. Runs fully offline. Can be embedded via `<iframe>` or `<webview>`.

### Key Insight

**This is what our project would look like if built on pdf.js instead of MuPDF WASM.** It proves the concept works with pure browser-side JS. But it's commercial — you need to buy a license to get the code.

### What We Can Learn From It

- **The feature list is our target** — this is the quality bar
- **Their JSON export approach** for annotation sync is worth studying
- **They chose to rewrite annotations from scratch** rather than relying on pdf.js's annotation layer — same conclusion we reached

---

## 5. leed (rudi-q/leed_pdf_viewer)

**URL**: https://github.com/rudi-q/leed_pdf_viewer | https://leed.my
**License**: (check repo)
**Language**: SvelteKit + Tauri
**Status**: Active development

### What It Does

Transforms PDFs into an interactive canvas for drawing and annotating. Focus on pen/stylus input with drawing tablet support. Privacy-first (no uploads).

### Architecture

SvelteKit for web, Tauri for desktop. Uses Canvas API for drawing.

### What We Can Learn From It

- **SvelteKit + Tauri is a viable desktop deployment path** if we ever want native apps
- **Pen/stylus input handling** — their ink code could be reference for our Ink annotation tool
- Not useful for our core use case (structured annotation editing)

---

## 6. Silent Editor (silenteditor.com)

**URL**: https://silenteditor.com
**License**: Freemium (not fully open source)

### What It Does

Browser-based PDF editor using PDF.js + pdf-lib. All processing client-side. Supports:

- Text replacement (select and replace existing text spans)
- Font matching to preserve original appearance
- Signatures with name, date stamp, custom text
- Page operations: insert, import, duplicate, delete, reorder
- Highlights and rectangular shapes
- Export as compact (selectable text) or "Visual Perfect" (rasterized)

### Architecture

PDF.js (rendering) → local state (edits) → pdf-lib (serialization). No server.

### Key Limitation

Text editing is replace-in-place only. Cannot freely move text blocks. Form field widgets added as "comments" cannot be repositioned — this was the original user's complaint that started this research thread.

### What We Can Learn From It

- **pdf-lib's limitations are real** — it can't manipulate existing annotation positions well
- **The "Visual Perfect" export mode** (rasterize for fidelity) is a good fallback option
- **Validates the market need** for a better browser-based editor

---

## 7. Stirling PDF

**URL**: https://github.com/Stirling-Tools/Stirling-PDF | https://docs.stirlingpdf.com
**License**: Open source (AGPL for enterprise features)
**Language**: Java (Spring Boot) + React frontend

### What It Does

60+ PDF tools in a self-hosted web application. The #1 open-source PDF app on GitHub. Requires Docker/server.

### Server-side Tools

- **PDFBox** — core PDF manipulation
- **LibreOffice** — format conversion (Office docs ↔ PDF)
- **qpdf** — structural transformations (linearize, flatten, encrypt/decrypt, repair, overlay/underlay)
- **Tesseract OCR** — text extraction from images
- **OpenCV** — image processing

### Browser-side Tools

- **PDF.js** — rendering
- **pdf-lib** — client-side manipulation
- **EmbedPDF** — viewer with annotation support

### Full Feature List

**Page operations**: merge, split, rotate, reorder, extract, remove, crop, multi-page layout, scale, auto-split (scanned page dividers), convert to single page

**Conversion**: PDF ↔ images, any file → PDF (LibreOffice), PDF → Word/PowerPoint/Excel (LibreOffice), HTML/URL/Markdown → PDF

**Security**: add/remove passwords, change permissions, watermark, certify/sign, sanitize, auto-redact

**Other**: signatures, PDF repair, blank page detection, compare PDFs (text diff), add images, compress, extract images, page numbers, auto-rename by header text, OCR, PDF/A conversion, edit metadata, flatten, JSON export of PDF info, detect JavaScript

### What We Can Learn From It

- **It's the benchmark** for feature completeness
- **Their architecture choice (server-side processing) is both their strength and weakness** — powerful but not private, not offline
- **The features that require server-side** (LibreOffice conversion, Tesseract OCR) are the ones we can never replicate client-side. That's fine — different product.
- **The features that DON'T require server-side** (page operations, merge/split, annotations, encrypt/decrypt) are all things MuPDF WASM can handle. This is our roadmap.
- **qpdf is used for specific structural operations** we can't do with MuPDF: flatten annotations, flatten rotation, linearize, overlay/underlay, repair

---

## 8. MuPDF WebViewer

**URL**: https://webviewer.mupdf.com | https://mupdf.com/wasm
**License**: AGPL or commercial (Artifex)

### What It Does

Artifex's own web viewer using MuPDF WASM. Demonstrates that MuPDF WASM is production-ready for browser PDF rendering with annotation support.

### Key Features Demonstrated

- Full page rendering via WASM
- Annotation display and creation
- Form filling
- Redaction
- Signatures
- All client-side, zero server dependencies

### What We Can Learn From It

- **Proof that MuPDF WASM works in production browsers** — this is the vendor's own demo
- **Their viewer architecture** (single HTML page + WASM library) validates our approach
- **They don't provide a full interactive editor** — that's the gap we fill

---

## 9. Key Libraries (Not Full Editors)

### pdf-lib (npm: pdf-lib)

**URL**: https://github.com/Hopding/pdf-lib | https://pdf-lib.js.org
**License**: MIT
**Purpose**: Create and modify PDF documents in any JavaScript environment

**Capabilities**: Create PDFs from scratch, modify existing PDFs, add text/images/vector graphics, create/fill/read form fields (text, checkbox, radio, dropdown), set document metadata, embed fonts.

**Limitations**: Cannot parse or manipulate existing annotation positions. No rendering. No appearance stream handling. Best for creating new content, not editing existing annotations.

**Relevance**: We chose MuPDF WASM instead because it handles both rendering AND annotation manipulation with proper appearance stream regeneration.

### PDF.js (Mozilla)

**URL**: https://github.com/mozilla/pdf.js
**License**: Apache 2.0
**Purpose**: PDF rendering in the browser using Canvas/SVG

**Capabilities**: Page rendering, text search, thumbnails, zoom, rotation, displaying annotations. Limited annotation editor (free text, highlight, stamp, ink) added in recent versions.

**Limitations**: Primarily a viewer. Annotation editor is basic (4 types). Saving changes back to PDF requires additional implementation. No built-in save functionality.

**Relevance**: We chose MuPDF WASM for rendering instead, which eliminates the need for a separate rendering library.

### pdfAnnotate (highkite/pdfAnnotate)

**URL**: https://github.com/highkite/pdfAnnotate
**License**: (check repo)
**Purpose**: JavaScript library for writing annotation objects directly into PDF files

**Key Insight**: The author tried PDF.js → couldn't write annotations. Tried pdfkit, pdfmake, jspdf → couldn't clone PDF documents properly. Ended up writing a library that appends annotation objects to the PDF's incremental update section directly.

**Approach**: Uses PDF's incremental update mechanism — appends new cross-reference sections and annotation objects to the end of the file without modifying existing content. This is the correct low-level approach.

**Relevance**: Validates that incremental PDF updates (which MuPDF's `saveToBuffer("incremental")` does) are the right serialization strategy.

### Fabric.js

**URL**: https://github.com/fabricjs/fabric.js
**License**: MIT
**Purpose**: Canvas-based object model with selection, drag, resize, rotate, group, z-order

**Relevance**: PDFJsAnnotations proved this works as an interaction layer on top of PDF pages. We chose custom SVG/HTML overlays instead for MVP simplicity, but Fabric.js remains a viable option if interaction requirements grow complex.

---

## Summary: Why MuPDF WASM Is The Right Foundation

Every project above hit the same fundamental problem: **the gap between rendering a PDF and editing its internal structure**. They all tried to bridge this gap with JavaScript — custom parsers (ts-pdf), overlay canvases (PDFJsAnnotations), external storage (pdf-annotate.js), or commercial code (ElasticPDF).

MuPDF WASM eliminates this gap entirely. It's a complete PDF engine — parser, renderer, annotation CRUD, appearance stream generator, and serializer — compiled to run in the browser. The 20 years of C code handles edge cases that no JavaScript reimplementation will match.

Our job is to build the UI layer on top. That's a tractable frontend engineering problem, not a PDF specification problem.
