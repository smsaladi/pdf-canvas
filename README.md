# PDF Canvas

A fully client-side, browser-based PDF editor built on [MuPDF WASM](https://mupdf.com/). Open, annotate, edit text, fill forms, and save PDFs — all with zero server round-trips.

**[Try it live](https://smsaladi.github.io/pdf-canvas/)**

## Features

### Annotations
- Create and edit: sticky notes, text boxes, highlights, rectangles, circles, lines, freehand drawing
- Move, resize, and delete annotations with undo/redo
- Customize border color, fill color, opacity, and line weight
- Live preview while drawing shapes

### Text Editing
- Double-click to select and edit text inline
- Click, drag, double-click (word), and triple-click (line) selection
- Find & Replace (Ctrl+F) with match highlighting
- Font augmentation: automatically injects missing glyphs from metrically compatible reference fonts so edits work on real-world PDFs with subsetted fonts
- Bold/italic toggle (Ctrl+B / Ctrl+I) via content stream font switching

### Form Filling
- Detect and display form widgets (text fields, checkboxes, dropdowns)
- Click to fill text fields with live editing

### Text Boxes (FreeText)
- Click or drag to create, then type directly
- Configure font family (sans-serif, serif, monospace), size, and text color
- Transparent background by default

### Image Editing
- Select, move, resize, and delete embedded page content images
- Export images as PNG
- Insert images from file

### Page Management
- Thumbnail sidebar with page previews
- Drag to reorder pages
- Delete, duplicate, or insert blank pages
- Multi-page selection (Shift+click)

### View Controls
- Continuous scroll with lazy page rendering
- Zoom in/out, fit-to-width, fit-to-height, pinch-to-zoom on touch
- Rotate pages counterclockwise
- Page navigation (click, type page number, or prev/next)

### Multi-Select
- Shift+click to add/remove annotations from selection
- Batch move, delete, and copy selected annotations

### Session Persistence
- Auto-saves to IndexedDB every 2 seconds on changes
- Ctrl+R / reload restores the document, page position, and zoom
- History tab in properties panel shows undo stack and session info

### File I/O
- Open via file picker, drag & drop, or camera capture
- Incremental save (preserves signatures on unmodified content)
- PWA support — installable, works offline

## Architecture

```
Main Thread                          Web Worker
+-----------------------+            +--------------------+
| UI Shell              |  postMsg   | MuPDF WASM         |
|  +- Toolbar           |<---------->|  +- Parse PDF      |
|  +- Viewport/Canvas   |            |  +- Render pages   |
|  +- Overlay Layer     |            |  +- Annot CRUD     |
|  +- Properties Panel  |            |  +- Text editing   |
|  +- Text Layer        |            |  +- Font augment   |
|  +- Search Bar        |            |  +- Save PDF       |
|  +- Undo/Redo         |            +--------------------+
+-----------------------+
```

All MuPDF calls happen in a Web Worker. The main thread handles DOM, user interaction, and coordinate conversion. Communication is typed message-based RPC with Transferable ArrayBuffers.

## Tech Stack

- **PDF engine**: MuPDF WASM (AGPL-3.0)
- **Bundler**: Vite
- **Language**: TypeScript
- **UI**: Vanilla DOM, no framework
- **Font parsing**: opentype.js + fonteditor-core
- **Reference fonts**: Google Croscore (Arimo, Tinos, Cousine) fetched on demand
- **Testing**: Vitest (unit/integration), Playwright (E2E)

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| V | Select / Move tool |
| T | Edit Text tool |
| N | Sticky Note |
| F | Text Box |
| H | Highlight |
| R | Rectangle |
| C | Circle |
| L | Line |
| D | Freehand Draw |
| Ctrl+O | Open file |
| Ctrl+S | Save file |
| Ctrl+F | Find & Replace |
| Ctrl+Z | Undo |
| Ctrl+Shift+Z | Redo |
| Ctrl+C | Copy annotation |
| Ctrl+V | Paste annotation |
| Ctrl+D | Duplicate annotation |
| Ctrl+B | Bold toggle (in text edit) |
| Ctrl+I | Italic toggle (in text edit) |
| Delete | Delete selected annotation(s) |
| Arrow keys | Nudge selected annotation 1pt (Shift: 10pt) |
| Tab | Cycle through annotations |
| Space (hold) | Pan / drag viewport |
| P | Hand / Pan tool |

## Development

```bash
npm install
npm run dev          # Vite dev server with HMR
npm run build        # Production build
npm test             # Vitest unit + integration tests
npm run test:e2e     # Playwright E2E tests
npm run fixtures     # Regenerate test PDF fixtures
```

## License

AGPL-3.0 (required by the MuPDF WASM dependency)
