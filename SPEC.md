# PDF Canvas — Product & Technical Specification

## Vision

A fully client-side, browser-based PDF editor that lets users open a PDF, visually select annotations and form fields, drag/resize/reposition them, edit their properties, and save the modified PDF — all without any server. Think "Mac Preview Plus" in the browser.

**Differentiator vs Stirling PDF**: Stirling PDF is a tool *collection* (60 separate upload→process→download operations). PDF Canvas is an interactive *editor* — you open a file, manipulate objects visually in real-time, and save. We're better at interactive editing; they're better at batch operations and format conversion.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Browser                                                │
│                                                         │
│  ┌──────────────┐   ┌──────────────┐   ┌─────────────┐ │
│  │  MuPDF WASM  │   │  Interaction │   │   UI Shell   │ │
│  │              │   │    Layer     │   │              │ │
│  │ • Parse PDF  │◄─►│              │◄─►│ • Toolbar    │ │
│  │ • Render     │   │ • Hit-test   │   │ • Properties │ │
│  │ • Read/write │   │ • Drag/move  │   │ • Page nav   │ │
│  │   annots     │   │ • Resize     │   │ • File I/O   │ │
│  │ • Read/write │   │ • Select     │   │              │ │
│  │   widgets    │   │ • Multi-sel  │   │              │ │
│  │ • Save PDF   │   │              │   │              │ │
│  └──────────────┘   └──────────────┘   └─────────────┘ │
│        ▲                   ▲                  ▲         │
│        │                   │                  │         │
│        └───────── Web Worker ─────────────────┘         │
│                                                         │
│  Zero network traffic. All files stay in the browser.   │
└─────────────────────────────────────────────────────────┘
```

### Core Technology Choices

| Layer | Technology | Rationale |
|---|---|---|
| PDF engine | **MuPDF WASM** (npm: `mupdf`) | Full PDF object model in C compiled to WASM. Handles parsing, rendering, annotation CRUD, appearance stream regeneration, and serialization. 20+ years of edge-case handling. AGPL licensed. |
| Rendering | **MuPDF Pixmap → Canvas** | MuPDF renders pages to pixel buffers natively. No need for PDF.js. |
| Interaction layer | **Custom SVG/HTML overlay** | Lightweight overlay divs/SVGs positioned over the canvas for each annotation. Handles drag, resize, select. No heavy dependency like Fabric.js needed for MVP. |
| UI framework | **Vanilla TS / Preact** | Keep it minimal. No React/Vue build complexity for MVP. |
| Threading | **Web Worker** | MuPDF WASM runs in a worker to keep UI responsive. Message-passing for render requests and annotation mutations. |
| Future: structural transforms | **qpdf WASM** (lazy-loaded) | For linearization, annotation flattening, rotation flattening, overlay/underlay, and PDF repair. Apache 2.0 licensed. Loaded on-demand only when needed. |

---

## MVP Scope

### In Scope (MVP)

1. **Open PDF** — file picker or drag-and-drop. Load into MuPDF WASM.
2. **Render pages** — display pages at configurable zoom, scroll through multi-page documents.
3. **Enumerate existing annotations** — on page load, call `page.getAnnotations()` and render interactive handles for each.
4. **Select annotation** — click to select. Show bounding box with resize handles. Display properties in a side panel.
5. **Move annotation** — drag to reposition. Calls `annot.setRect()` on the MuPDF object, then re-render.
6. **Resize annotation** — drag corner/edge handles. Update rect accordingly.
7. **Comment / Popup annotations** — first-class support for the annotation types most commonly referred to as "comments" in PDF readers:
   - **Text annotations** (sticky note icons): move the icon, edit the popup text, change icon color. These are the yellow/blue/green note icons users see in Acrobat/Preview.
   - **Highlight / Underline / StrikeOut / Squiggly** (text markup): select and move these as a group via their QuadPoints. Edit color, opacity, and the associated comment text that appears in the popup.
   - **Popup association**: when a markup annotation has an associated Popup, display the popup text in the properties panel for editing. The popup text is stored via `annot.getContents()` / `annot.setContents()` on the parent annotation, not on the Popup object itself.
   - **Author & date**: display (read-only in MVP) the annotation author and modification date in the properties panel.
   - **Reply threads**: display existing reply chains in the properties panel (read-only in MVP). Replies are annotations with an IRT (In Reply To) reference — MuPDF exposes this. Adding new replies is post-MVP.
8. **Edit annotation properties** — side panel to change:
   - Color (border and fill)
   - Border width
   - Opacity
   - Text contents / comment text (for Text, FreeText, and all markup annotations)
   - Font size (for FreeText)
   - Icon type (for Text annotations: Note, Comment, Help, Insert, Key, NewParagraph, Paragraph)
9. **Create new annotations** — toolbar to add:
   - FreeText (text box)
   - Square/Rectangle
   - Circle/Ellipse
   - Line (with optional arrow endpoints)
   - Ink/freehand drawing
   - Text note (sticky note icon with popup comment)
   - Highlight (select text region → highlight with comment)
10. **Delete annotation** — select and press Delete/Backspace, or button. Deleting a parent annotation also removes its associated Popup and any reply annotations.
11. **Enumerate form widgets** — call `page.getWidgets()`, render interactive overlays.
12. **Move/resize form widgets** — same drag/resize interaction as annotations.
13. **Save PDF** — `doc.saveToBuffer("incremental")` → download as file. MuPDF handles all appearance stream regeneration automatically.
14. **Undo/Redo** — maintain a stack of annotation state snapshots (rect, color, contents) for undo.

### Out of Scope (Post-MVP)

- OCR (possible later via Tesseract.js WASM)
- PDF form filling (displaying/editing field values)
- Text content editing (modifying the page's text stream — extremely hard)
- Text-selection-based highlight creation (MVP uses rectangle regions; snapping to actual text runs requires text extraction + coordinate matching)
- Adding new replies to comment threads (displaying existing threads is in MVP)
- PDF conversion (to/from Word, images — requires LibreOffice, inherently server-side)
- Multi-user collaboration / real-time sync
- Digital signatures
- Localization

---

## Detailed Design

### 1. MuPDF Worker

All MuPDF operations run in a dedicated Web Worker to avoid blocking the main thread.

**Worker API (message-based RPC):**

```
// Main thread → Worker
{ type: "open",       data: ArrayBuffer }
{ type: "renderPage", page: number, scale: number }
{ type: "getAnnotations", page: number }
{ type: "getWidgets",     page: number }
{ type: "setAnnotRect",   annotId: string, rect: [x1,y1,x2,y2] }
{ type: "setAnnotColor",  annotId: string, color: [r,g,b] }
{ type: "setAnnotContents", annotId: string, text: string }
{ type: "setAnnotOpacity",  annotId: string, opacity: number }
{ type: "setAnnotIcon",     annotId: string, icon: string }
{ type: "setAnnotQuadPoints", annotId: string, quadPoints: number[][] }
{ type: "setAnnotIsOpen",   annotId: string, isOpen: boolean }
{ type: "createAnnot",    page: number, type: string, rect: [x1,y1,x2,y2] }
{ type: "deleteAnnot",    annotId: string }
{ type: "save",           options: string }

// Worker → Main thread
{ type: "pageRendered",   page: number, imageData: ImageBitmap }
{ type: "annotations",    page: number, annots: AnnotationDTO[] }
{ type: "widgets",        page: number, widgets: WidgetDTO[] }
{ type: "saved",          buffer: ArrayBuffer }
{ type: "error",          message: string }
```

**AnnotationDTO shape:**

```typescript
interface AnnotationDTO {
  id: string;             // internal reference (pointer index)
  type: string;           // "Text", "FreeText", "Square", "Circle", "Line",
                          // "Highlight", "Underline", "StrikeOut", "Squiggly", etc.
  rect: [number, number, number, number];  // [x1, y1, x2, y2] in PDF coords
  color: number[];        // [r, g, b] normalized 0-1
  interiorColor?: number[];
  opacity: number;
  contents: string;       // comment/popup text for all annotation types
  borderWidth: number;
  hasRect: boolean;       // can be repositioned via setRect

  // comment/popup metadata:
  author?: string;        // annotation author (from /T field)
  modifiedDate?: string;  // last modification date
  createdDate?: string;   // creation date
  isOpen?: boolean;       // whether popup is displayed open
  icon?: string;          // for Text annotations: "Note", "Comment", "Help", etc.
  irtRef?: string;        // In Reply To — id of parent annotation (for reply chains)
  replies?: AnnotationDTO[];  // child annotations that reply to this one

  // type-specific:
  vertices?: number[][];  // for Polygon/Polyline
  line?: number[][];      // for Line: [[x1,y1],[x2,y2]]
  inkList?: number[][][]; // for Ink
  quadPoints?: number[][]; // for Highlight/Underline/StrikeOut/Squiggly
  defaultAppearance?: { font: string; size: number; color: number[] };
}
```

### 2. Coordinate System

MuPDF uses a top-left origin coordinate system (unlike raw PDF which is bottom-left). The WASM API already handles this transformation.

**Mapping PDF coords ↔ screen coords:**

```
screenX = (pdfX * scale) + pageOffsetX
screenY = (pdfY * scale) + pageOffsetY

pdfX = (screenX - pageOffsetX) / scale
pdfY = (screenY - pageOffsetY) / scale
```

The interaction layer must track `scale` and page offsets to convert mouse events back to PDF coordinates before calling `setRect()`.

### 3. Interaction Layer

**For each annotation/widget on the visible page(s):**

1. Create an absolutely-positioned `<div>` overlay with:
   - Position/size mapped from PDF rect → screen coords
   - CSS `cursor: move` on the body, `cursor: nw-resize` (etc.) on corner handles
   - `pointer-events: auto` (the page canvas behind has `pointer-events: none` for the overlay area)

2. **Selection:**
   - Click on overlay → mark as selected, show 8 resize handles (corners + edges)
   - Click on empty area → deselect
   - Shift+click → add to multi-selection (stretch goal)

3. **Move:**
   - `pointerdown` on selected overlay body → start drag
   - `pointermove` → update overlay position in screen coords
   - `pointerup` → convert final screen position to PDF coords → `worker.setAnnotRect(id, newRect)`
   - Worker updates MuPDF object, re-renders annotation area, sends back updated bitmap

4. **Resize:**
   - `pointerdown` on handle → start resize (track which handle)
   - `pointermove` → update overlay size, constrained by handle direction
   - `pointerup` → convert to PDF coords → `worker.setAnnotRect(id, newRect)`

5. **Create:**
   - User selects annotation type from toolbar
   - Click+drag on canvas to define initial rect
   - `pointerup` → `worker.createAnnot(page, type, rect)`
   - Worker creates annotation, returns updated annotation list
   - New overlay appears, auto-selected

6. **Comment-specific interactions:**

   **Text annotations (sticky notes):**
   - Rendered as a small icon overlay (24×24px default) at the annotation's rect position
   - Move = drag the icon → `setRect()` with the same width/height, new x/y
   - No resize handles (icons are fixed size in most PDF readers)
   - Double-click → focus the comment text field in the properties panel
   - Visual indicator (small dot/badge) if the annotation has replies

   **Highlight / Underline / StrikeOut / Squiggly:**
   - These use QuadPoints (sets of 4 points defining highlighted text regions), not a simple rect
   - The overlay is drawn as a semi-transparent polygon matching the QuadPoints
   - **Move**: compute the bounding box delta from drag, apply that delta to every QuadPoint coordinate, then call `annot.setQuadPoints(newPoints)`. MuPDF auto-updates the parent Rect.
   - **Resize**: not supported for text markup annotations (they follow text geometry). Move only.
   - Single-click selects and shows the comment text in the properties panel
   - Double-click → focus the comment text field for editing
   - Color change applies to the highlight/underline/strikeout color

   **Popup display:**
   - When a comment-type annotation is selected, the properties panel serves as the popup editor
   - No floating popup windows in MVP (simpler, avoids z-order and positioning complexity)
   - The properties panel shows: author (read-only), date (read-only), comment text (editable), color picker, opacity slider, and reply thread (read-only list)

7. **Re-render strategy:**
   - After any annotation mutation, re-render just the affected page
   - MuPDF renders the full page (including annotations) to a single bitmap
   - This is simpler than trying to composite annotation rendering separately
   - At 150 DPI for a letter-size page, that's ~1275×1650 pixels — fast enough in WASM

### 4. Properties Panel

A right-side panel (collapsible) that shows editable properties for the selected annotation. The panel adapts its fields based on annotation type:

- **All types**: color, opacity, delete button
- **Text (sticky note)**: icon picker, comment text, author (read-only), date (read-only), replies (read-only)
- **Highlight/Underline/StrikeOut**: comment text, author, date, replies
- **FreeText**: position (x, y, w, h), text content, font size, border width
- **Square/Circle**: position, border width, interior color
- **Line**: endpoint coordinates, line ending styles (None, OpenArrow, ClosedArrow, etc.)
- **Ink**: stroke color, border width (no position editing — too complex)

Property changes are applied immediately via the worker and trigger a page re-render.

### 5. Toolbar

```
[Open] [Save] | [Select ✓] [FreeText] [Note] [Highlight] [Rect] [Circle] [Line] [Ink] | [Undo] [Redo] | Zoom: [−] 100% [+] | Page: [◀] 1/12 [▶]
```

- **Select mode** (default): click to select, drag to move
- **Creation modes**: click+drag to create new annotation of that type
- **Note mode**: click to place a sticky note icon, properties panel opens for comment text entry
- **Highlight mode**: click+drag to define a rectangular highlight region (in MVP, rectangle-based; text-selection-based highlighting is post-MVP)
- **Ink mode**: freehand draw, strokes collected on pointerup, sent as ink annotation

### 6. Page Navigation & Viewport

- Vertical scroll through pages (continuous scroll, not single-page)
- Only render visible pages + 1 page buffer above/below (lazy rendering)
- Zoom: 50% – 400%, controlled by buttons or Ctrl+scroll
- On zoom change, re-render visible pages at new scale, reposition all overlays

### 7. File I/O

**Open:**
```javascript
const input = document.createElement('input');
input.type = 'file';
input.accept = '.pdf';
input.onchange = (e) => {
  const file = e.target.files[0];
  const buffer = await file.arrayBuffer();
  worker.postMessage({ type: 'open', data: buffer }, [buffer]);
};
```

Also support drag-and-drop on the main area.

**Save:**
```javascript
// In worker:
const buf = doc.saveToBuffer("incremental");
const bytes = buf.asUint8Array();
postMessage({ type: 'saved', buffer: bytes.buffer }, [bytes.buffer]);

// In main thread:
const blob = new Blob([buffer], { type: 'application/pdf' });
const url = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = url;
a.download = originalFilename || 'edited.pdf';
a.click();
```

### 8. Undo/Redo

Simple state-snapshot approach for MVP:

```typescript
interface UndoEntry {
  annotId: string;
  property: string;       // "rect", "color", "contents", "delete", "create"
  previousValue: any;
  newValue: any;
}

const undoStack: UndoEntry[] = [];
const redoStack: UndoEntry[] = [];
```

Before any mutation, push the current state to undoStack. Undo = pop from undoStack, apply previousValue, push to redoStack. Clear redoStack on any new action.

---

## Project Structure

```
pdf-canvas/
├── index.html
├── src/
│   ├── main.ts
│   ├── worker.ts
│   ├── worker-rpc.ts
│   ├── worker-rpc.test.ts
│   ├── viewport.ts
│   ├── interaction.ts
│   ├── interaction-comments.ts
│   ├── properties.ts
│   ├── toolbar.ts
│   ├── undo.ts
│   ├── undo.test.ts
│   ├── coords.ts
│   ├── coords.test.ts
│   └── types.ts
├── tests/
│   ├── fixtures/               # Generated test PDFs (committed to repo)
│   │   ├── blank.pdf
│   │   ├── with-annotations.pdf
│   │   ├── with-comments.pdf
│   │   ├── with-form.pdf
│   │   ├── multi-page.pdf
│   │   └── rotated.pdf
│   ├── e2e/                    # Playwright browser tests
│   │   ├── open-pdf.spec.ts
│   │   ├── annotations.spec.ts
│   │   ├── comments.spec.ts
│   │   ├── create.spec.ts
│   │   ├── save.spec.ts
│   │   └── undo.spec.ts
│   └── integration/            # Worker + MuPDF round-trip tests
│       ├── worker.test.ts
│       └── round-trip.test.ts
├── scripts/
│   └── create-fixtures.ts      # Generates deterministic test PDFs
├── styles/
│   └── main.css
├── package.json
├── vite.config.ts
├── vitest.config.ts
├── playwright.config.ts
├── tsconfig.json
├── CLAUDE.md
├── SPEC.md
├── RESEARCH.md
└── MUPDF_API_REFERENCE.md
```

**Dependencies (production):**

| Package | Purpose | Size |
|---|---|---|
| `mupdf` | PDF engine (WASM) | ~5MB gzipped |

One dependency. That's it.

**Dev dependencies:** Vite, TypeScript, Vitest, @vitest/coverage-v8, Playwright, @playwright/test.

---

## Development Phases

**CRITICAL: Each phase must include tests. Do not start the next phase until all tests for the current phase pass. See CLAUDE.md for full testing instructions, test structure, and fixture generation.**

### Phase 1: Foundation (Week 1-2)
- [ ] Set up project with Vite + TypeScript + MuPDF WASM
- [ ] Configure Vitest and Playwright
- [ ] Create test fixture generation script (`scripts/create-fixtures.ts`)
- [ ] Generate deterministic test PDFs: blank, with-annotations, with-comments, with-form, multi-page
- [ ] Web Worker loading MuPDF WASM, opening PDF, returning page count
- [ ] Worker renders pages to ImageBitmap at configurable scale
- [ ] Basic viewport: continuous scroll, zoom (50%-400%), page navigation
- [ ] File open via picker button and drag-and-drop
- **Tests required:**
  - [ ] Unit: `coords.ts` — PDF↔screen conversion at various scales/offsets
  - [ ] Unit: `worker-rpc.ts` — message serialization
  - [ ] Integration: Worker loads WASM, opens fixture PDF, returns correct page count
  - [ ] Integration: Worker renders page, returns ImageBitmap with correct dimensions
  - [ ] E2E: Drop PDF on page → pages render → scroll works → zoom re-renders at correct size

### Phase 2: Annotation Display & Selection (Week 3)
- [ ] Enumerate annotations on page load (including Text, Highlight, Underline, StrikeOut)
- [ ] Render overlay divs for each annotation (icon overlays for Text notes, polygon overlays for text markup)
- [ ] Click to select, show bounding box + handles
- [ ] Properties panel showing annotation info including comment text, author, date
- **Tests required:**
  - [ ] Integration: Worker returns correct annotation DTOs for fixture PDF (type, rect, color, contents match expected)
  - [ ] Unit: Overlay positioning — given known rect + scale, overlay div has correct CSS position/size
  - [ ] E2E: Open fixture PDF → annotation overlays visible at correct positions
  - [ ] E2E: Click annotation → selection box with handles appears → properties panel shows correct data

### Phase 3: Manipulation (Week 4-5)
- [ ] Drag to move (setRect round-trip through worker)
- [ ] Move text markup annotations by shifting all QuadPoints
- [ ] Resize via handles (for types that support it)
- [ ] Property editing (color, opacity, border, contents, icon type)
- [ ] Comment text editing for all annotation types
- [ ] Display existing reply threads (read-only)
- [ ] Delete annotation (cascade to popup + replies)
- [ ] Undo/redo
- **Tests required:**
  - [ ] Integration: setAnnotRect round-trip — set rect, re-read, verify changed
  - [ ] Integration: setAnnotColor, setAnnotContents, setAnnotOpacity — same round-trip pattern
  - [ ] Integration: Move highlight by shifting QuadPoints — verify all points shifted and Rect auto-updated
  - [ ] Integration: Delete annotation — verify gone on re-enumeration
  - [ ] Integration: **Round-trip test** — open → move annotation → save → reopen → verify new position
  - [ ] Unit: Undo stack — push/undo/redo state transitions, redo cleared on new action
  - [ ] E2E: Drag annotation → release → save → reopen → annotation at new position
  - [ ] E2E: Edit comment text → save → reopen → text persists
  - [ ] E2E: Change color → save → reopen → color persists
  - [ ] E2E: Delete annotation → save → reopen → gone
  - [ ] E2E: Ctrl+Z undoes last move, Ctrl+Shift+Z redoes

### Phase 4: Creation (Week 6)
- [ ] Toolbar with annotation type buttons
- [ ] Click to place sticky note, auto-open properties for comment entry
- [ ] Click+drag to create highlight region
- [ ] Click+drag to create FreeText, Rectangle, Circle, Line
- [ ] Ink/freehand drawing mode
- [ ] FreeText with inline text entry
- **Tests required:**
  - [ ] Integration: createAnnotation for each type → verify exists in annotation list with correct type
  - [ ] Integration: Created annotation has expected default properties (color, rect, etc.)
  - [ ] E2E: Select FreeText tool → click+drag → annotation appears → type text → shows in properties
  - [ ] E2E: Select Note tool → click → icon appears → properties opens for comment entry
  - [ ] E2E: Select Highlight tool → click+drag → highlight region created with default color
  - [ ] E2E: Create annotation → save → reopen → annotation present and correct

### Phase 5: Widgets & Save (Week 7)
- [ ] Form widget enumeration and overlay
- [ ] Widget move/resize
- [ ] Save to file (incremental save)
- [ ] Save confirmation / dirty state tracking
- **Tests required:**
  - [ ] Integration: Worker returns correct widget DTOs for form fixture PDF
  - [ ] Integration: Widget setRect round-trip
  - [ ] Integration: saveToBuffer("incremental") produces valid PDF (starts with %PDF, non-zero length)
  - [ ] Integration: **Full round-trip** — open form PDF → move widget → save → reopen → widget at new position
  - [ ] E2E: Open form PDF → widget overlays visible → drag widget → save → reopen → widget persisted
  - [ ] E2E: Save button triggers download of valid PDF file

### Phase 6: Polish (Week 8)
- [ ] Keyboard shortcuts (Delete, Ctrl+Z, Ctrl+S, arrow keys for nudge)
- [ ] Multi-select (Shift+click, drag to select)
- [ ] Copy/paste annotations
- [ ] Touch support (mobile-friendly drag/resize)
- [ ] Performance optimization for large PDFs (lazy page rendering)
- [ ] Persist open document state to IndexedDB so Ctrl+R / reload restores the session
- [ ] Toolbar color picker applies to selected annotation (not just new ones)
- [ ] Separate border/outline color and fill color selectors in toolbar (like Preview)
- [ ] Line thickness / border width control in toolbar
- [ ] Font family and size selector in toolbar for FreeText annotations
- **Tests required:**
  - [ ] E2E: Delete key removes selected annotation
  - [ ] E2E: Ctrl+S triggers save
  - [ ] E2E: Arrow keys nudge selected annotation by 1pt in correct direction
  - [ ] E2E: Shift+click selects multiple → drag moves all
  - [ ] E2E: Large PDF (100+ pages) — renders without hanging, only visible pages loaded

### Future Enhancements (Post-MVP)
- [ ] Browser-side font glyph injection: use WASM font library (HarfBuzz/fontkit) to add missing glyphs to subsetted fonts, enabling true content stream text editing on all PDFs without redaction fallback
- [ ] Text reflow engine: when replacement text is longer/shorter, adjust surrounding text positioning
- [ ] CID font text editing: handle Identity-H encoded fonts by reverse-mapping ToUnicode CMap

---

## Post-MVP Roadmap

### Near-term (high value, MuPDF supports natively)

These features close the biggest gaps vs Stirling PDF and require no additional WASM libraries:

| Feature | MuPDF API | Effort |
|---|---|---|
| **Page rotate** | `page.setPageBox()`, page rotation attributes | Low |
| **Page reorder/delete/insert** | `doc.insertPage()`, `doc.deletePage()`, `doc.graftPage()` | Medium |
| **Merge PDFs** | `doc.graftPage()` from second document | Medium |
| **Split PDF** | Create new doc, graft selected pages | Medium |
| **Encrypt/Decrypt** | MuPDF supports reading encrypted PDFs natively; write encryption via PDF object manipulation | Medium |
| **Redaction** | `annot.applyRedaction()` / `page.applyRedactions()` — MuPDF has full redaction support | Low |
| **Metadata editing** | Direct PDF object access via `doc.getTrailer()` | Low |
| **Add images to pages** | MuPDF can add images via page content stream manipulation | Medium |
| **Text extraction/search** | `page.toStructuredText()`, `stext.search()` | Medium |
| **Text-selection-based highlights** | Combine text extraction coordinates with highlight QuadPoints | Medium |
| **Reply to comment threads** | Create annotation with IRT reference to parent | Low |
| **Stamp annotations** | `page.createAnnotation("Stamp")` | Low |

### Medium-term (requires qpdf WASM)

These features require structural PDF transformations that MuPDF cannot perform. Plan to compile qpdf to WASM and lazy-load it.

| Feature | qpdf capability | Why MuPDF can't do it |
|---|---|---|
| **Flatten annotations** | `--flatten-annotations` pushes annotations into page content streams permanently | MuPDF can render annotations but can't bake them into the content stream |
| **Flatten rotation** | `--flatten-rotation` removes /Rotate key and modifies content stream | MuPDF reads rotation but doesn't flatten it |
| **Linearization** | `--linearize` creates web-optimized PDFs for progressive loading | MuPDF reads linearized files but doesn't write them |
| **PDF repair** | Robust cross-reference table reconstruction from damaged files | MuPDF's recovery is less robust than qpdf's |
| **Overlay/underlay** | Composite pages from one PDF on top of another | Useful for watermarks, letterheads |
| **Remove security restrictions** | `--decrypt --remove-restrictions` for signed PDFs | MuPDF can decrypt but not remove signature restrictions |

**qpdf architecture**: Load qpdf WASM on-demand only when a user invokes a qpdf-specific operation. Keep it out of the initial bundle. qpdf is Apache 2.0 licensed, compatible with our AGPL project.

### Long-term

| Feature | Notes |
|---|---|
| OCR | Tesseract.js WASM exists but is large (~15MB). Lazy-load. |
| Signatures (handwritten) | Canvas-based drawing → stamp annotation |
| Digital signatures | Requires crypto libraries, certificate handling |
| Compare PDFs | Side-by-side rendering + text diff |
| Compress | Re-encode streams with better compression |
| Watermark | Overlay text/image on every page |
| Pipeline/automation | Chain operations (like Stirling's pipelines) |

---

## Competitive Analysis vs Stirling PDF

| Category | Stirling PDF | PDF Canvas | Notes |
|---|---|---|---|
| **Interactive annotation editing** | ❌ Weak (overlay-based, no round-trip) | ✅ Core strength | Our differentiator |
| **Comment annotations** | ❌ Not a focus | ✅ Full CRUD + display | Our differentiator |
| **Merge/Split** | ✅ Full GUI | ❌ Post-MVP | Fast follow |
| **Page operations** | ✅ Rotate, reorder, remove, crop | ❌ Post-MVP | Fast follow |
| **Convert formats** | ✅ 50+ via LibreOffice | ❌ Never (requires server) | Architectural difference |
| **OCR** | ✅ Via Tesseract | ❌ Post-MVP (Tesseract.js) | Possible via WASM |
| **Compress** | ✅ Via OCRmyPDF | ❌ Post-MVP | Possible via qpdf WASM |
| **Encrypt/Decrypt** | ✅ | ❌ Post-MVP | MuPDF supports it |
| **Flatten annotations** | ✅ Via qpdf | ❌ Post-MVP | Requires qpdf WASM |
| **Watermark** | ✅ | ❌ Post-MVP | Possible via MuPDF |
| **Redact** | ✅ Auto-redact | ❌ Post-MVP | MuPDF has the API |
| **Signatures** | ✅ Handwritten + cert | ❌ Post-MVP | Canvas → stamp |
| **Deployment** | Docker/server required | Static files only | Our advantage |
| **Privacy** | Files processed on server | Files never leave browser | Our advantage |
| **Offline** | Limited | Full offline after first load | Our advantage |

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| MuPDF WASM bundle size (~5MB) | Slow first load | Service worker caching; lazy-load WASM after initial HTML renders |
| AGPL license | Cannot distribute as proprietary SaaS | Self-host only, or negotiate commercial license with Artifex |
| Complex PDFs with unusual annotation types | Some annotations may not render/move correctly | Start with the common types. Log unsupported types gracefully. |
| Page re-render performance | Lag on annotation move | Render at reduced DPI during drag, full DPI on drop. Use `requestAnimationFrame`. |
| Web Worker message overhead | Latency on property changes | Batch rapid changes (debounce), use `Transferable` objects for buffers |
| Widget manipulation may differ from annotations | Incomplete widget support | Widgets share API surface with annotations in MuPDF. Test early with real forms. |
| qpdf WASM compilation | May be complex to build | qpdf has Emscripten build examples; pdfcpu (Go→WASM) is an alternative for some features |

---

## Success Criteria (MVP)

An MVP is complete when a user can:

1. Open any standard PDF in the browser
2. See all existing annotations highlighted with selectable overlays — including sticky notes, highlights, underlines, and strikeouts
3. Click an annotation, see its properties in a panel — including comment text, author, and date
4. Drag a sticky note icon to a new position and see it persist
5. Drag a highlight annotation to a new position (all QuadPoints shift together)
6. Edit the comment text on any annotation (Text, Highlight, etc.) and see it persist in the saved PDF
7. Change an annotation's color, opacity, and icon type
8. Resize a FreeText, Rectangle, or Circle annotation
9. Create a new sticky note with comment text
10. Create a new highlight region
11. Create a new FreeText, Rectangle, or Line annotation
12. Delete an annotation (including its associated popup and replies)
13. Undo/redo the last 20 actions
14. Save the modified PDF and open it in Adobe Reader / Preview with all changes intact — comments visible in the comments pane, highlights rendering correctly

All of this happening with zero server round-trips, zero file uploads, and zero data leaving the browser.

---

## License

AGPL-3.0 (required by MuPDF WASM dependency). Compatible with MIT/Apache-2.0 code included in the project. Users can self-host freely; commercial distribution requires either AGPL compliance or a commercial MuPDF license from Artifex.
