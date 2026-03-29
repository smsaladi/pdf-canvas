// MuPDF Web Worker — dispatches PDF operations
// Helper functions are in ./worker/helpers.ts
// Shared document state is in ./worker/doc-state.ts
import * as mupdf from "mupdf";
import { createWorkerResponder } from "./worker-rpc";
import type { WorkerRequest, WorkerResponse, PageInfo, AnnotationDTO, TextBlock, TextLine, CharInfo, PageTextData, TextSearchResult } from "./types";
import { replaceTextInStream as replaceInStream, replaceTextWithFontSwitch, parseToUnicodeCMap, replaceHexTextInStream } from "./content-stream";
import { parseFontName, matchReferenceFont, fetchFont, augmentFont } from "./font-augment";
import { setDoc, getDoc } from "./worker/doc-state";
import { buildGlyphMap, findMappingsForSelection, editMappedGlyphs } from "./content-map";
import { getPageInfo, renderPage, getAnnotations, resolveAnnot, resolveWidget } from "./worker/helpers";

const respond = createWorkerResponder(self);

self.onmessage = async function (e: MessageEvent) {
  const { _rpcId, ...request } = e.data as WorkerRequest & { _rpcId?: number };

  try {
    switch (request.type) {
      case "open": {
        const newDoc = new mupdf.PDFDocument(request.data);
        setDoc(newDoc);
        const pageCount = newDoc.countPages();
        const pages: PageInfo[] = [];
        for (let i = 0; i < pageCount; i++) {
          pages.push(getPageInfo(i));
        }
        respond(_rpcId, { type: "opened", pageCount, pages });
        break;
      }

      case "getPageCount": {
        respond(_rpcId, { type: "pageCount", count: getDoc().countPages() });
        break;
      }

      case "getPageInfo": {
        respond(_rpcId, { type: "pageInfo", page: request.page, info: getPageInfo(request.page) });
        break;
      }

      case "renderPage": {
        const result = await renderPage(request.page, request.scale);
        respond(_rpcId, { type: "pageRendered", page: request.page, bitmap: result.bitmap, width: result.width, height: result.height }, [result.bitmap]);
        break;
      }

      case "getAnnotations": {
        respond(_rpcId, { type: "annotations", page: request.page, annots: getAnnotations(request.page) });
        break;
      }

      case "getWidgets": {
        const page = getDoc().loadPage(request.page) as mupdf.PDFPage;
        const widgets = page.getWidgets();
        const dtos: import("./types").WidgetDTO[] = widgets.map((w, i) => ({
          id: `w${request.page}-${i}`, page: request.page,
          fieldType: w.getFieldType(), fieldName: w.getName() || `field_${i}`,
          value: w.getValue() || "", rect: w.getRect(),
        }));
        respond(_rpcId, { type: "widgets", page: request.page, widgets: dtos });
        break;
      }

      // --- Annotation property mutations ---

      case "setAnnotRect": {
        if (request.annotId.startsWith("w")) {
          const { widget } = resolveWidget(request.annotId);
          widget.setRect(request.rect); widget.update();
          respond(_rpcId, { type: "annotUpdated", annotId: request.annotId }); break;
        }
        const { annot } = resolveAnnot(request.annotId);
        const type = annot.getType();
        if (type === "Line" && annot.hasLine()) {
          const oldLine = annot.getLine();
          const dx = request.rect[0] - annot.getBounds()[0];
          const dy = request.rect[1] - annot.getBounds()[1];
          annot.setLine([oldLine[0][0] + dx, oldLine[0][1] + dy] as any, [oldLine[1][0] + dx, oldLine[1][1] + dy] as any);
        } else if (type === "Ink" && annot.hasInkList()) {
          const oldInk = annot.getInkList();
          const dx = request.rect[0] - annot.getBounds()[0];
          const dy = request.rect[1] - annot.getBounds()[1];
          annot.setInkList(oldInk.map(stroke => stroke.map(pt => [pt[0] + dx, pt[1] + dy] as mupdf.Point)));
        } else { annot.setRect(request.rect); }
        annot.update();
        respond(_rpcId, { type: "annotUpdated", annotId: request.annotId }); break;
      }

      case "setAnnotColor": { const { annot } = resolveAnnot(request.annotId); annot.setColor(request.color as mupdf.AnnotColor); annot.update(); respond(_rpcId, { type: "annotUpdated", annotId: request.annotId }); break; }
      case "setAnnotContents": { const { annot } = resolveAnnot(request.annotId); annot.setContents(request.text); annot.update(); respond(_rpcId, { type: "annotUpdated", annotId: request.annotId }); break; }
      case "setAnnotOpacity": { const { annot } = resolveAnnot(request.annotId); annot.setOpacity(request.opacity); annot.update(); respond(_rpcId, { type: "annotUpdated", annotId: request.annotId }); break; }
      case "setAnnotBorderWidth": { const { annot } = resolveAnnot(request.annotId); annot.setBorderWidth(request.width); annot.update(); respond(_rpcId, { type: "annotUpdated", annotId: request.annotId }); break; }
      case "setAnnotBorderStyle": { const { annot } = resolveAnnot(request.annotId); annot.setBorderStyle(request.style as mupdf.PDFAnnotationBorderStyle); annot.update(); respond(_rpcId, { type: "annotUpdated", annotId: request.annotId }); break; }
      case "setAnnotInteriorColor": { const { annot } = resolveAnnot(request.annotId); annot.setInteriorColor(request.color as mupdf.AnnotColor); annot.update(); respond(_rpcId, { type: "annotUpdated", annotId: request.annotId }); break; }
      case "setAnnotDefaultAppearance": { const { annot } = resolveAnnot(request.annotId); annot.setDefaultAppearance((request as any).font, (request as any).size, (request as any).color as mupdf.AnnotColor); annot.update(); respond(_rpcId, { type: "annotUpdated", annotId: request.annotId }); break; }
      case "setAnnotIcon": { const { annot } = resolveAnnot(request.annotId); annot.setIcon(request.icon); annot.update(); respond(_rpcId, { type: "annotUpdated", annotId: request.annotId }); break; }
      case "setAnnotQuadPoints": { const { annot } = resolveAnnot(request.annotId); annot.setQuadPoints(request.quadPoints as mupdf.Quad[]); annot.update(); respond(_rpcId, { type: "annotUpdated", annotId: request.annotId }); break; }

      case "deleteAnnot": {
        const { page, annot } = resolveAnnot(request.annotId);
        page.deleteAnnotation(annot);
        respond(_rpcId, { type: "annotDeleted", annotId: request.annotId }); break;
      }

      case "setWidgetValue": {
        const { widget } = resolveWidget(request.widgetId);
        if (widget.isText()) widget.setTextValue(request.value);
        else if (widget.isChoice()) widget.setChoiceValue(request.value);
        widget.update();
        respond(_rpcId, { type: "annotUpdated", annotId: request.widgetId }); break;
      }

      // --- Annotation creation ---

      case "createAnnot": {
        const page = getDoc().loadPage(request.page) as mupdf.PDFPage;
        const annot = page.createAnnotation(request.annotType as mupdf.PDFAnnotationType);
        const noRectTypes = new Set(["Highlight", "Underline", "StrikeOut", "Squiggly", "Line", "Ink", "Polygon", "PolyLine"]);
        if (!noRectTypes.has(request.annotType)) annot.setRect(request.rect);

        const props = request.properties;
        if (props) {
          if (props.color !== undefined) annot.setColor(props.color as mupdf.AnnotColor);
          if (props.opacity !== undefined) annot.setOpacity(props.opacity);
          if (props.contents) annot.setContents(props.contents);
          if (props.icon && annot.hasIcon()) annot.setIcon(props.icon);
          if (props.borderWidth !== undefined && annot.hasBorder()) annot.setBorderWidth(props.borderWidth);
          if (props.borderStyle && annot.hasBorder()) annot.setBorderStyle(props.borderStyle as mupdf.PDFAnnotationBorderStyle);
          if (props.interiorColor && annot.hasInteriorColor()) annot.setInteriorColor(props.interiorColor as mupdf.AnnotColor);
          if (props.quadPoints) { try { annot.setQuadPoints(props.quadPoints as mupdf.Quad[]); } catch {} }
          if (props.defaultAppearance && request.annotType === "FreeText") {
            annot.setDefaultAppearance(props.defaultAppearance.font, props.defaultAppearance.size, props.defaultAppearance.color as mupdf.AnnotColor);
          }
          if (props.inkList) { try { annot.setInkList(props.inkList as mupdf.Point[][]); } catch {} }
          if (props.line) { try { annot.setLine(props.line[0] as mupdf.Point, props.line[1] as mupdf.Point); } catch {} }
          if (props.author) annot.setAuthor(props.author);

        }
        annot.update();
        const created = getAnnotations(request.page).at(-1)!;
        respond(_rpcId, { type: "annotCreated", annot: created }); break;
      }

      // --- Image insertion ---

      case "addImage": {
        const page = getDoc().loadPage(request.page) as mupdf.PDFPage;
        const image = new mupdf.Image(request.imageData);
        const stamp = page.createAnnotation("Stamp");
        stamp.setRect(request.rect);
        const imgRef = getDoc().addImage(image);
        const resources = getDoc().newDictionary();
        const xobjects = getDoc().newDictionary();
        xobjects.put("Img", imgRef); resources.put("XObject", xobjects);
        const w = request.rect[2] - request.rect[0], h = request.rect[3] - request.rect[1];
        stamp.setAppearance(null, null, mupdf.Matrix.identity, [0, 0, w, h], resources, `q ${w} 0 0 ${h} 0 0 cm /Img Do Q`);
        try { stamp.setBorderWidth(0); } catch {}
        try { stamp.setColor([] as mupdf.AnnotColor); } catch {}
        stamp.update();
        respond(_rpcId, { type: "annotCreated", annot: getAnnotations(request.page).at(-1)! }); break;
      }

      // --- Page image extraction ---

      case "getPageImages": {
        const page = getDoc().loadPage(request.page);
        const stext = page.toStructuredText();
        const images: import("./types").PageImageDTO[] = [];
        let imgIdx = 0;

        stext.walk({
          onImageBlock(bbox: any, _transform: any, image: any) {
            images.push({
              id: `img${request.page}-${imgIdx++}`,
              page: request.page,
              rect: bbox as [number, number, number, number],
              width: image.getWidth(),
              height: image.getHeight(),
            });
          },
        } as any);

        respond(_rpcId, { type: "pageImages", page: request.page, images } as any);
        break;
      }

      case "exportImage": {
        const page = getDoc().loadPage(request.page);
        const stext = page.toStructuredText();
        let targetImage: any = null;
        let imgIdx = 0;

        stext.walk({
          onImageBlock(_bbox: any, _transform: any, image: any) {
            if (imgIdx === request.imageIndex) {
              targetImage = image;
            }
            imgIdx++;
          },
        } as any);

        if (targetImage) {
          const pixmap = targetImage.toPixmap();
          const w = pixmap.getWidth();
          const h = pixmap.getHeight();
          const pixels = pixmap.getPixels();
          // Convert to RGBA for browser
          const numComponents = targetImage.getNumberOfComponents();
          let rgba: Uint8ClampedArray;
          if (numComponents === 4) {
            rgba = new Uint8ClampedArray(pixels);
          } else if (numComponents === 3) {
            rgba = new Uint8ClampedArray(w * h * 4);
            for (let i = 0, j = 0; i < pixels.length; i += 3, j += 4) {
              rgba[j] = pixels[i]; rgba[j+1] = pixels[i+1]; rgba[j+2] = pixels[i+2]; rgba[j+3] = 255;
            }
          } else {
            rgba = new Uint8ClampedArray(w * h * 4);
            for (let i = 0, j = 0; i < pixels.length; i++, j += 4) {
              rgba[j] = rgba[j+1] = rgba[j+2] = pixels[i]; rgba[j+3] = 255;
            }
          }
          const imageData = new ImageData(new Uint8ClampedArray(rgba.buffer as ArrayBuffer), w, h);
          const bitmap = await createImageBitmap(imageData);
          respond(_rpcId, { type: "imageExported", bitmap, width: w, height: h } as any, [bitmap]);
        } else {
          respond(_rpcId, { type: "error", message: "Image not found" });
        }
        break;
      }

      // --- Text extraction ---

      case "extractText": {
        const page = getDoc().loadPage(request.page);
        const stext = page.toStructuredText();
        const blocks: TextBlock[] = [];
        let currentBlock: TextBlock | null = null;
        let currentLine: TextLine | null = null;
        stext.walk({
          beginTextBlock(bbox: any) { currentBlock = { bbox: bbox as any, lines: [] }; },
          beginLine(bbox: any, wmode: number) { currentLine = { bbox: bbox as any, wmode, chars: [] }; },
          onChar(c: string, origin: any, font: any, size: number, quad: any, color: any) {
            if (currentLine) currentLine.chars.push({
              c, origin: origin as any, quad: quad as any, fontSize: size, fontName: font.getName(),
              fontFlags: { isMono: font.isMono(), isSerif: font.isSerif(), isBold: font.isBold(), isItalic: font.isItalic() },
              color: color ? (Array.isArray(color) ? color : [0, 0, 0]) : [0, 0, 0],
            });
          },
          endLine() { if (currentBlock && currentLine) { currentBlock.lines.push(currentLine); currentLine = null; } },
          endTextBlock() { if (currentBlock) { blocks.push(currentBlock); currentBlock = null; } },
        });
        respond(_rpcId, { type: "textExtracted", page: request.page, data: { page: request.page, blocks } }); break;
      }

      // --- Text replacement (simple) ---

      case "replaceTextInStream": {
        const pageObj = (getDoc().loadPage(request.page) as mupdf.PDFPage).getObject();
        const contentsRef = pageObj.get("Contents");
        let totalCount = 0;
        const tryReplace = (ref: any) => {
          if (!ref.isStream()) return false;
          const { result, count } = replaceInStream(ref.readStream().asString(), request.oldText, request.newText, request.replaceAll ?? false);
          if (count > 0) { ref.writeStream(result); totalCount += count; return true; }
          return false;
        };
        if (contentsRef.isArray()) { for (let i = 0; i < contentsRef.length; i++) { if (tryReplace(contentsRef.get(i)) && !request.replaceAll) break; } }
        else if (contentsRef.isStream()) tryReplace(contentsRef);
        respond(_rpcId, { type: "textReplaced", page: request.page, count: totalCount }); break;
      }

      // --- Text replacement (redact fallback) ---

      case "replaceTextViaRedact": {
        const page = getDoc().loadPage(request.page) as mupdf.PDFPage;
        const redact = page.createAnnotation("Redact");
        redact.setRect(request.rect);
        page.applyRedactions(false, 0, 0, 0);
        if (request.newText.trim()) {
          const ft = page.createAnnotation("FreeText");
          ft.setRect(request.rect); ft.setContents(request.newText);
          ft.setDefaultAppearance(request.fontFamily as string, request.fontSize, request.color as mupdf.AnnotColor);
          ft.setBorderWidth(0); ft.setColor([]); ft.update();
        }
        respond(_rpcId, { type: "textReplaced", page: request.page, count: 1 }); break;
      }

      // --- Smart text replacement (with font augmentation) ---

      case "replaceTextSmart": {
        const page = getDoc().loadPage(request.page) as mupdf.PDFPage;
        const pageObj = page.getObject();
        const contentsRef = pageObj.get("Contents");

        // === NEW: Deterministic mapping-based approach ===
        const selY = (request as any).selectionY;
        const selX = 0; // X not critical for disambiguation

        if (selY !== undefined) {
          try {
            console.log(`[ContentMap] Building glyph map for page ${request.page}...`);
            const glyphMap = buildGlyphMap(page);
            console.log(`[ContentMap] Mapped ${glyphMap.length} glyphs`);

            if (glyphMap.length > 0) {
              const selection = findMappingsForSelection(glyphMap, request.oldText, selX, selY);
              if (selection && selection.length > 0) {
                console.log(`[ContentMap] Found "${request.oldText}" at y=${selection[0].y.toFixed(1)} (isHex=${selection[0].isHex})`);

                // Read all streams
                const streams: string[] = [];
                if (contentsRef.isArray()) {
                  for (let i = 0; i < contentsRef.length; i++) {
                    const ref = contentsRef.get(i);
                    streams.push(ref.isStream() ? ref.readStream().asString() : "");
                  }
                } else if (contentsRef.isStream()) {
                  streams.push(contentsRef.readStream().asString());
                }

                // Build Unicode→GID map for hex fonts
                let unicodeToGid: Map<string, number> | undefined;
                if (selection[0].isHex) {
                  const fontDict = pageObj.get("Resources")?.get("Font");
                  if (fontDict && !fontDict.isNull()) {
                    const fontKeys: string[] = [];
                    fontDict.forEach((_: any, k: string | number) => fontKeys.push(String(k)));
                    for (const fk of fontKeys) {
                      const fo = fontDict.get(fk);
                      const toUnicode = fo.get("ToUnicode");
                      if (toUnicode.isStream()) {
                        const { unicodeToGid: u2g } = parseToUnicodeCMap(toUnicode.readStream().asString());
                        unicodeToGid = u2g;
                        break;
                      }
                    }
                  }
                }

                // For same-length replacement: edit in place
                if (request.newText.length <= request.oldText.length) {
                  const newChars = [...request.newText];
                  // Pad with spaces if shorter
                  while (newChars.length < selection.length) newChars.push(" ");
                  const edited = editMappedGlyphs(streams, selection, newChars, unicodeToGid);

                  // Write back
                  if (contentsRef.isArray()) {
                    for (let i = 0; i < Math.min(contentsRef.length, edited.length); i++) {
                      const ref = contentsRef.get(i);
                      if (ref.isStream()) ref.writeStream(edited[i]);
                    }
                  } else if (contentsRef.isStream()) {
                    contentsRef.writeStream(edited[0]);
                  }

                  console.log(`[ContentMap] ✓ Edited ${selection.length} glyphs via mapping`);
                  respond(_rpcId, { type: "textReplacedSmart", page: request.page, count: 1, method: "content-stream" });
                  break;
                }

                // For longer text: edit existing chars + append extras (hex only)
                if (request.newText.length > request.oldText.length && selection[0].isHex && unicodeToGid) {
                  const existingChars = [...request.newText.slice(0, request.oldText.length)];
                  const edited = editMappedGlyphs(streams, selection, existingChars, unicodeToGid);

                  const lastMapping = selection[selection.length - 1];
                  const extraChars = request.newText.slice(request.oldText.length);
                  let extra = "";

                  // === CALIBRATED ADVANCE WIDTHS ===
                  // Use the Device trace (glyphMap) to compute a calibration factor.
                  // The trace gives us actual x-positions. The Td values in the content
                  // stream should produce those same positions. By comparing known advances
                  // from the trace with font.advanceGlyph() values, we get a scale factor
                  // that accounts for fontSize, CTM, and any other transforms.

                  let advanceScale = 5; // fallback: raw Td value per em-unit of advance
                  try {
                    // Find the selection in the glyph map and compute actual inter-character advances
                    const selStart = glyphMap.findIndex(g =>
                      Math.abs(g.y - selection[0].y) < 1 && g.char === selection[0].char
                    );
                    if (selStart >= 0 && selStart + 1 < glyphMap.length) {
                      // Compute actual advances from consecutive glyphs in the trace
                      const advances: Array<{ actual: number; fontAdvance: number }> = [];
                      for (let gi = selStart; gi < Math.min(selStart + selection.length - 1, glyphMap.length - 1); gi++) {
                        const curr = glyphMap[gi];
                        const next = glyphMap[gi + 1];
                        if (Math.abs(curr.y - next.y) < 1) { // same line
                          const actualAdv = next.x - curr.x;
                          if (actualAdv > 0 && actualAdv < 50) { // reasonable range
                            advances.push({ actual: actualAdv, fontAdvance: 1 }); // we'll compute ratio per-glyph
                          }
                        }
                      }

                      // Compute the ratio: Td value = actual advance from trace
                      // For appended chars: Td = font.advanceGlyph(gid) * advanceScale
                      // advanceScale = average(actual advance / advanceGlyph) for known chars
                      if (advances.length > 0) {
                        // Load font for advanceGlyph
                        let fontForMetrics: mupdf.Font | null = null;
                        const fDict = pageObj.get("Resources")?.get("Font");
                        if (fDict && !fDict.isNull()) {
                          const fKeys: string[] = [];
                          fDict.forEach((_: any, k: string | number) => fKeys.push(String(k)));
                          for (const fk of fKeys) {
                            const fo = fDict.get(fk);
                            if (fo.get("Subtype").asName() === "Type0") {
                              const desc = fo.get("DescendantFonts");
                              if (desc.isArray() && desc.length > 0) {
                                const ff2 = desc.get(0).get("FontDescriptor")?.get("FontFile2");
                                if (ff2?.isStream()) {
                                  const fd = ff2.readStream().asUint8Array();
                                  const buf = new ArrayBuffer(fd.byteLength);
                                  new Uint8Array(buf).set(fd);
                                  fontForMetrics = new mupdf.Font("metrics", buf);
                                }
                              }
                              break;
                            }
                          }
                        }

                        if (fontForMetrics) {
                          const ratios: number[] = [];
                          for (let gi = selStart; gi < Math.min(selStart + selection.length - 1, glyphMap.length - 1); gi++) {
                            const curr = glyphMap[gi];
                            const next = glyphMap[gi + 1];
                            if (Math.abs(curr.y - next.y) < 1) {
                              const actualAdv = next.x - curr.x;
                              const fontAdv = fontForMetrics.advanceGlyph(curr.glyphId);
                              if (fontAdv > 0.01 && actualAdv > 0) {
                                ratios.push(actualAdv / fontAdv);
                              }
                            }
                          }
                          if (ratios.length > 0) {
                            advanceScale = ratios.reduce((a, b) => a + b, 0) / ratios.length;
                            console.log(`[ContentMap] Calibrated advanceScale=${advanceScale.toFixed(2)} from ${ratios.length} samples`);
                          }

                          // Generate appended operators with calibrated advances.
                          // KEY: Td moves the cursor BEFORE drawing. So:
                          //   Td_N = advance width of the CHARACTER BEFORE character N
                          // The first Td = advance of the last original char (the one before our appended text)
                          const lastOrigGid = selection[selection.length - 1].glyphId;
                          let prevCharAdvance = Math.round(fontForMetrics.advanceGlyph(lastOrigGid) * advanceScale * 10) / 10;
                          let skippedAdvance = 0; // accumulate advances of skipped chars

                          // Check for chars missing from CMap and augment if needed
                          const missingFromCmap = [...new Set(extraChars)].filter(ch => !unicodeToGid!.get(ch));
                          if (missingFromCmap.length > 0 && unicodeToGid) {
                            console.log(`[ContentMap] Characters missing from CMap: ${missingFromCmap.join("")} — augmenting font + CMap`);
                            try {
                              // Find the Type0 font and its CMap
                              const fDict2 = pageObj.get("Resources")?.get("Font");
                              if (fDict2) {
                                const fKeys2: string[] = [];
                                fDict2.forEach((_: any, k: string | number) => fKeys2.push(String(k)));
                                for (const fk of fKeys2) {
                                  const fo = fDict2.get(fk);
                                  if (fo.get("Subtype").asName() !== "Type0") continue;

                                  // Get the font data for glyph injection
                                  const descFonts = fo.get("DescendantFonts");
                                  if (!descFonts.isArray() || descFonts.length === 0) continue;
                                  const cidFont = descFonts.get(0);
                                  const fontDesc = cidFont.get("FontDescriptor");
                                  if (fontDesc.isNull()) continue;
                                  const ff2 = fontDesc.get("FontFile2");
                                  if (!ff2.isStream()) continue;

                                  const fontBytes = ff2.readStream().asUint8Array();
                                  const fontBuf = new ArrayBuffer(fontBytes.byteLength);
                                  new Uint8Array(fontBuf).set(fontBytes);

                                  // Match reference font and augment
                                  const baseName = fo.get("BaseFont").asName();
                                  const parsed = parseFontName(baseName);
                                  const match = matchReferenceFont(parsed);
                                  const refBuf = fetchFont(match);
                                  if (!refBuf) continue;

                                  const augmented = augmentFont(fontBuf, refBuf, missingFromCmap);
                                  if (augmented) {
                                    // Write augmented font and replace resource
                                    const newFont = new mupdf.Font(baseName, augmented);
                                    const newFontRes = getDoc().addFont(newFont);
                                    fDict2.put(fk, newFontRes);
                                    mupdf.emptyStore();
                                    console.log(`[ContentMap] ✓ Augmented font "${baseName}" with ${missingFromCmap.length} glyph(s)`);

                                    // Update ToUnicode CMap with new entries
                                    // Use opentype.js to find the GIDs assigned to the new chars
                                    const opentype2 = await import("opentype.js");
                                    const augParsed = opentype2.parse(augmented);
                                    if (augParsed) {
                                      const toUnicode = fo.get("ToUnicode");
                                      if (toUnicode.isStream()) {
                                        let cmapText = toUnicode.readStream().asString();
                                        const newEntries: string[] = [];
                                        for (const ch of missingFromCmap) {
                                          const glyph = augParsed.charToGlyph(ch);
                                          if (glyph && glyph.index > 0) {
                                            const gidHex = glyph.index.toString(16).padStart(4, "0");
                                            const uniHex = ch.charCodeAt(0).toString(16).padStart(4, "0");
                                            newEntries.push(`<${gidHex}> <${uniHex}>`);
                                            unicodeToGid.set(ch, glyph.index);
                                            console.log(`[ContentMap] Added CMap: GID 0x${gidHex} → "${ch}" (U+${uniHex})`);
                                          }
                                        }
                                        if (newEntries.length > 0) {
                                          // Add entries to the bfchar section
                                          cmapText = cmapText.replace(
                                            /(\d+)\s+beginbfchar\n/,
                                            (_, count) => `${parseInt(count) + newEntries.length} beginbfchar\n${newEntries.join("\n")}\n`
                                          );
                                          toUnicode.writeStream(cmapText);
                                        }
                                      }
                                    }
                                  }
                                  break;
                                }
                              }
                            } catch (augErr) {
                              console.warn("[ContentMap] Type0 font augmentation failed:", augErr);
                            }
                          }

                          for (const ch of extraChars) {
                            const gid = unicodeToGid.get(ch);
                            if (gid !== undefined) {
                              const td = Math.round((prevCharAdvance + skippedAdvance) * 10) / 10;
                              extra += `\n${td} 0 Td <${gid.toString(16).padStart(4, "0")}> Tj`;
                              prevCharAdvance = Math.round(fontForMetrics.advanceGlyph(gid) * advanceScale * 10) / 10;
                              skippedAdvance = 0;
                            } else {
                              skippedAdvance += Math.round(advanceScale * 0.5 * 10) / 10;
                              console.log(`[ContentMap] Still can't encode "${ch}" (U+${ch.charCodeAt(0).toString(16)})`);
                            }
                          }
                        }
                      }
                    }
                  } catch (advErr) {
                    console.warn("[ContentMap] Advance calibration failed:", advErr);
                  }

                  // Fallback: if calibration didn't produce results, use fixed advance
                  if (!extra && extraChars.length > 0) {
                    for (const ch of extraChars) {
                      const gid = unicodeToGid.get(ch);
                      if (gid !== undefined) {
                        extra += `\n5 0 Td <${gid.toString(16).padStart(4, "0")}> Tj`;
                      }
                    }
                  }

                  if (extra) {
                    // Find insertion point (after the last Tj in the stream near our edit)
                    const afterLastEdit = edited[lastMapping.streamIndex].slice(lastMapping.hexEnd);
                    const tjEndMatch = afterLastEdit.match(/>\s*Tj/);
                    const insertAt = lastMapping.hexEnd + (tjEndMatch ? tjEndMatch.index! + tjEndMatch[0].length : 5);
                    edited[lastMapping.streamIndex] = edited[lastMapping.streamIndex].slice(0, insertAt) + extra + edited[lastMapping.streamIndex].slice(insertAt);
                  }

                  if (contentsRef.isArray()) {
                    for (let i = 0; i < Math.min(contentsRef.length, edited.length); i++) {
                      const ref = contentsRef.get(i);
                      if (ref.isStream()) ref.writeStream(edited[i]);
                    }
                  } else if (contentsRef.isStream()) {
                    contentsRef.writeStream(edited[0]);
                  }

                  console.log(`[ContentMap] ✓ Edited ${selection.length} + appended ${extraChars.length} glyphs via mapping`);
                  respond(_rpcId, { type: "textReplacedSmart", page: request.page, count: 1, method: "content-stream" });
                  break;
                }
              } else {
                console.log(`[ContentMap] Selection not found in mapping, falling back`);
              }
            }
          } catch (mapErr) {
            console.warn(`[ContentMap] Mapping failed, falling back:`, mapErr);
          }
        }

        // === FALLBACK: Old approach (for cases without selectionY or when mapping fails) ===

        const tryStreamReplace = (streamRef: any): boolean => {
          if (!streamRef.isStream()) return false;
          const { result, count } = replaceInStream(streamRef.readStream().asString(), request.oldText, request.newText);
          if (count > 0) { streamRef.writeStream(result); return true; }
          return false;
        };
        const doStreamReplace = (): boolean => {
          if (contentsRef.isArray()) { for (let i = 0; i < contentsRef.length; i++) if (tryStreamReplace(contentsRef.get(i))) return true; }
          else if (contentsRef.isStream() && tryStreamReplace(contentsRef)) return true;
          return false;
        };

        const allNewTextChars = [...new Set(request.newText)].filter(c => c.trim());
        let augmentedAnyFont = false;
        const hasStyleOverride = request.boldOverride !== undefined || request.italicOverride !== undefined;
        console.log(`[FontAugment] Checking ${allNewTextChars.length} unique chars: "${allNewTextChars.join("")}"${hasStyleOverride ? " [style override]" : ""}`);

        try {
          const resources = pageObj.get("Resources");
          const fontDict = (!resources.isNull()) ? resources.get("Font") : null;
          if (fontDict && !fontDict.isNull()) {
            const fontKeys: string[] = [];
            fontDict.forEach((_: any, key: string | number) => { fontKeys.push(String(key)); });
            console.log(`[FontAugment] Page has ${fontKeys.length} font(s): ${fontKeys.join(", ")}`);

            for (const fontKey of fontKeys) {
              try {
                const fontObj = fontDict.get(fontKey);
                const subtype = fontObj.get("Subtype").asName();
                const baseFontName = fontObj.get("BaseFont").asName();
                if (subtype !== "TrueType") { console.log(`[FontAugment] Skip /${fontKey} (${subtype})`); continue; }
                if (request.fontName && baseFontName !== request.fontName) { console.log(`[FontAugment] Skip /${fontKey} (not ${request.fontName})`); continue; }
                const encoding = fontObj.get("Encoding");
                const encodingName = encoding.isName() ? encoding.asName() : "";
                if (encodingName !== "WinAnsiEncoding" && encodingName !== "MacRomanEncoding") { console.log(`[FontAugment] Skip /${fontKey} (${encodingName})`); continue; }
                const descriptor = fontObj.get("FontDescriptor");
                if (descriptor.isNull()) continue;
                const fontFile2 = descriptor.get("FontFile2");
                if (!fontFile2.isStream()) continue;

                const subsetArray = fontFile2.readStream().asUint8Array();
                const subsetBuffer = new ArrayBuffer(subsetArray.byteLength);
                new Uint8Array(subsetBuffer).set(subsetArray);
                console.log(`[FontAugment] Extracted /${fontKey} "${baseFontName}" (${subsetArray.byteLength} bytes)`);

                // Check glyphs
                const missingInThisFont: string[] = [];
                try {
                  const opentype = await import("opentype.js");
                  const parsedFont = opentype.parse(subsetBuffer);
                  if (parsedFont) {
                    for (const ch of allNewTextChars) {
                      const glyph = parsedFont.charToGlyph(ch);
                      if (!glyph || glyph.index === 0 || !glyph.path?.commands?.length) {
                        missingInThisFont.push(ch);
                        console.log(`[FontAugment]   "${ch}" → MISSING`);
                      }
                    }
                  }
                } catch { missingInThisFont.push(...allNewTextChars); }

                console.log(`[FontAugment] /${fontKey}: missing=[${missingInThisFont.join("")}]`);
                if (missingInThisFont.length === 0 && !hasStyleOverride) continue;

                const parsed = parseFontName(baseFontName);
                const flags = descriptor.get("Flags")?.asNumber?.() || 0;
                const match = matchReferenceFont(parsed, flags);
                if (request.boldOverride !== undefined) match.bold = request.boldOverride;
                if (request.italicOverride !== undefined) match.italic = request.italicOverride;

                // Style-only: add new font + font-switch operators
                if (hasStyleOverride && missingInThisFont.length === 0) {
                  const refBuffer = fetchFont(match);
                  if (!refBuffer) continue;
                  const newFont = new mupdf.Font(baseFontName + "_edit", refBuffer);
                  const editFontKey = "F_edit_" + Date.now();
                  fontDict.put(editFontKey, getDoc().addSimpleFont(newFont, "Latin"));
                  console.log(`[FontAugment] Added /${editFontKey} for style switch`);
                  const doSwitch = (): boolean => {
                    const cr = pageObj.get("Contents");
                    if (cr.isArray()) { for (let i = 0; i < cr.length; i++) { const s = cr.get(i); if (!s.isStream()) continue; const { result, count } = replaceTextWithFontSwitch(s.readStream().asString(), request.oldText, request.newText, editFontKey); if (count > 0) { s.writeStream(result); return true; } } }
                    else if (cr.isStream()) { const { result, count } = replaceTextWithFontSwitch(cr.readStream().asString(), request.oldText, request.newText, editFontKey); if (count > 0) { cr.writeStream(result); return true; } }
                    return false;
                  };
                  if (doSwitch()) { respond(_rpcId, { type: "textReplacedSmart", page: request.page, count: 1, method: "font-augment" }); return; }
                  continue;
                }

                // Glyph augmentation: inject missing glyphs + replace font
                const refBuffer = fetchFont(match);
                if (!refBuffer) continue;
                let fontBufferToUse: ArrayBuffer;
                if (missingInThisFont.length > 0) {
                  const augmented = augmentFont(subsetBuffer, refBuffer, missingInThisFont);
                  if (!augmented) continue;
                  fontBufferToUse = augmented;
                  console.log(`[FontAugment] Augmented ${missingInThisFont.length} glyph(s)`);
                } else {
                  fontBufferToUse = refBuffer;
                }
                const newFont = new mupdf.Font(baseFontName, fontBufferToUse);
                fontDict.put(fontKey, getDoc().addSimpleFont(newFont, "Latin"));
                console.log(`[FontAugment] ✓ Replaced /${fontKey} (${fontBufferToUse.byteLength} bytes)`);
                augmentedAnyFont = true;
              } catch (fontErr) { console.warn(`[FontAugment] Error on /${fontKey}:`, fontErr); }
            }
          }
        } catch (err) { console.warn("[FontAugment] Failed:", err); }

        if (augmentedAnyFont) { mupdf.emptyStore(); console.log(`[FontAugment] Cleared cache`); }
        if (doStreamReplace()) {
          respond(_rpcId, { type: "textReplacedSmart", page: request.page, count: 1, method: augmentedAnyFont ? "font-augment" : "content-stream" }); break;
        }
        // --- Tier 2: Type0/Identity-H hex glyph replacement ---
        console.log(`[Type0] Trying hex glyph replacement...`);
        try {
          const resources2 = pageObj.get("Resources");
          const fontDict2 = (!resources2.isNull()) ? resources2.get("Font") : null;
          if (fontDict2 && !fontDict2.isNull()) {
            const fontKeys2: string[] = [];
            fontDict2.forEach((_: any, key: string | number) => { fontKeys2.push(String(key)); });

            for (const fk of fontKeys2) {
              const fo = fontDict2.get(fk);
              if (fo.get("Subtype").asName() !== "Type0") continue;
              const bfn = fo.get("BaseFont").asName();
              if (request.fontName && bfn !== request.fontName) continue;

              const toUnicode = fo.get("ToUnicode");
              if (!toUnicode.isStream()) { console.log(`[Type0] No ToUnicode for ${bfn}`); continue; }

              const { gidToUnicode, unicodeToGid } = parseToUnicodeCMap(toUnicode.readStream().asString());
              console.log(`[Type0] Parsed CMap for "${bfn}": ${gidToUnicode.size} mappings`);

              const lineCtx = (request as any).lineContext || "";
              const selY = (request as any).selectionY;
              const tryHex = (ref: any): boolean => {
                if (!ref.isStream()) return false;
                const { result, count, missingChars } = replaceHexTextInStream(ref.readStream().asString(), request.oldText, request.newText, gidToUnicode, unicodeToGid, lineCtx, selY);
                if (missingChars.length > 0) console.log(`[Type0] Missing chars: ${missingChars.join(", ")}`);
                if (count > 0) { ref.writeStream(result); return true; }
                return false;
              };

              let ok = false;
              if (contentsRef.isArray()) { for (let i = 0; i < contentsRef.length; i++) if (tryHex(contentsRef.get(i))) { ok = true; break; } }
              else if (contentsRef.isStream()) ok = tryHex(contentsRef);

              if (ok) {
                console.log(`[Type0] ✓ Hex replacement succeeded`);
                respond(_rpcId, { type: "textReplacedSmart", page: request.page, count: 1, method: "content-stream" });
                return;
              }
            }
          }
        } catch (err) { console.warn("[Type0] Failed:", err); }

        console.warn(`[TextEdit] All methods failed for "${request.oldText}"`);
        respond(_rpcId, { type: "textReplacedSmart", page: request.page, count: 0, method: "failed" }); break;
      }

      // --- Search ---

      case "searchText": {
        const results: TextSearchResult[] = [];
        const pageCount = getDoc().countPages();
        const startPage = request.page !== undefined ? request.page : 0;
        const endPage = request.page !== undefined ? request.page + 1 : pageCount;
        for (let i = startPage; i < endPage; i++) {
          const hits = getDoc().loadPage(i).toStructuredText().search(request.needle);
          for (const quadGroup of hits) results.push({ page: i, quads: quadGroup as unknown as number[][], text: request.needle });
        }
        respond(_rpcId, { type: "searchResults", results }); break;
      }

      // --- Page operations ---

      case "rotatePage": {
        const pageObj = (getDoc().loadPage(request.page) as mupdf.PDFPage).getObject();
        let rot = 0; try { rot = pageObj.get("Rotate")?.asNumber?.() || 0; } catch {}
        pageObj.put("Rotate", ((rot + request.angle) % 360 + 360) % 360);
        respond(_rpcId, { type: "pageRotated", page: request.page, info: getPageInfo(request.page) }); break;
      }

      case "save": {
        try { getDoc().subsetFonts(); } catch {}
        const buf = getDoc().saveToBuffer(request.options || "incremental");
        const bytes = buf.asUint8Array();
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        respond(_rpcId, { type: "saved", buffer } as WorkerResponse, [buffer]); break;
      }

      default:
        respond(_rpcId, { type: "error", message: `Unknown request type: ${(request as any).type}` });
    }
  } catch (err: any) {
    respond(_rpcId, { type: "error", message: err?.message || String(err), requestType: request.type });
  }
};
