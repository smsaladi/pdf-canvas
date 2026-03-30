# PDF Canvas — TODO

## Bugs / Known Issues

- Ê character display for spaces after editing Type0/CID fonts (MuPDF internal font cache not invalidated after FontFile2 writeStream)
- Text reflow: replacement text that is longer/shorter doesn't adjust surrounding text positions
- Some special characters fail to encode on first attempt after font augmentation (need page reload for MuPDF to pick up new glyphs)
- Arrow key nudge E2E test is flaky
- Type0 test fixtures are minimal (no real embedded font data) — Device trace produces replacement characters, limiting test coverage

## Text Editing

- Text reflow engine: when replacement text is longer/shorter, adjust surrounding text positioning, handle line breaks and paragraph reflow
- Font selector dropdown for page content text editing (not just FreeText annotations)
- Local Font Access API integration (Chromium) — enumerate system fonts for selection
- Pre-warm IndexedDB font cache on app startup (loadAllCachedFonts in font-augment.ts)
- Handle ligatures during editing (fi, fl, ffi decomposition)
- Right-to-left / bidirectional text editing
- Vertical writing mode support (Identity-V CMaps)
- ActualText marked content awareness (PDF accessibility layer)
- Better Type0 test fixtures with real embedded TrueType font data

## Annotations & Interaction

- Marquee selection: drag empty area in select mode to draw selection rectangle, select all annotations within
- Alignment tools: align left/right/center/top/bottom, distribute evenly, snap to grid / snap to other objects
- Live preview during drag/resize: show actual content moving, not just overlay box. Options:
  - Render annotation separately as overlay image during drag
  - Clipping mask to hide old position in bitmap
  - Re-render page at low resolution during drag
- Annotation grouping: group multiple annotations as a unit
- Annotation locking: prevent accidental modification
- Reply chains: threaded comments on annotations via IRT references
- Stamp library: custom stamp creation and reuse

## Image Editing

- Replace embedded image (swap image content, preserve position/size)
- Crop embedded image within PDF
- Image filters (brightness, contrast, grayscale) — apply via content stream color operators
- Layer order z-index controls for overlapping images (Back/Forward buttons exist in properties, need worker implementation)

## Scanner / Camera

- Multiple page scanning: capture multiple photos → multi-page PDF
- Auto-crop / perspective correction on captured images
- Contrast/brightness adjustment for scanned documents
- OCR integration for searchable text layer on scanned pages

## Page Management

- Page duplication (copy page with all content)
- Import pages from another PDF (merge documents)
- Page size / MediaBox editing
- Crop pages (adjust CropBox)

## Performance

- Virtual scrolling for 100+ page documents
- Thumbnail rendering throttling and lazy generation
- Worker-side page caching (avoid re-parsing)
- Incremental content stream parsing (don't parse entire stream for single edit)
- Web Worker pool for parallel page rendering

## UI / UX

- Dark mode / theme switching
- Customizable toolbar layout
- Keyboard shortcut customization
- Context menu (right-click) on annotations
- Zoom to selection / zoom to annotation
- Minimap for large documents
- Recent files list (from IndexedDB session history)
- Export individual pages as PNG/SVG
- Print support (browser print dialog)

## Testing

- E2E test for Shift+click multi-select batch operations
- E2E test for large PDF (100+ pages) rendering performance
- E2E test for IndexedDB session restore on reload
- E2E test for pinch-zoom on touch devices (requires touch emulation)
- Integration test with real-world Type0 PDF fixture (embedded font data)
- Coverage target: 80%+ for src/ files

## Infrastructure

- CI/CD pipeline (GitHub Actions: lint, type-check, vitest, playwright)
- Automated lighthouse audits for PWA compliance
- Bundle size monitoring
- Error reporting / telemetry (opt-in)
- Versioned releases with changelog
