// MuPDF Web Worker — all PDF operations happen here
import * as mupdf from "mupdf";
import { createWorkerResponder } from "./worker-rpc";
import type { WorkerRequest, WorkerResponse, PageInfo, AnnotationDTO, TextBlock, TextLine, CharInfo, PageTextData, TextSearchResult } from "./types";
import { replaceTextInStream as replaceInStream, replaceTextWithFontSwitch } from "./content-stream";
import { parseFontName, matchReferenceFont, fetchFont, augmentFont } from "./font-augment";

const respond = createWorkerResponder(self);

let doc: mupdf.PDFDocument | null = null;

function getPageInfo(pageIndex: number): PageInfo {
  const page = doc!.loadPage(pageIndex);
  const bounds = page.getBounds();
  return {
    index: pageIndex,
    width: bounds[2] - bounds[0],
    height: bounds[3] - bounds[1],
  };
}

function renderPage(pageIndex: number, scale: number): { bitmap: ImageBitmap; width: number; height: number } | Promise<{ bitmap: ImageBitmap; width: number; height: number }> {
  const page = doc!.loadPage(pageIndex) as mupdf.PDFPage;
  const matrix: mupdf.Matrix = [scale, 0, 0, scale, 0, 0];
  const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false);
  const w = pixmap.getWidth();
  const h = pixmap.getHeight();
  const pixels = pixmap.getPixels();

  // MuPDF returns RGB, convert to RGBA for ImageData
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, j = 0; i < pixels.length; i += 3, j += 4) {
    rgba[j] = pixels[i];
    rgba[j + 1] = pixels[i + 1];
    rgba[j + 2] = pixels[i + 2];
    rgba[j + 3] = 255;
  }

  const imageData = new ImageData(rgba, w, h);
  return createImageBitmap(imageData).then((bitmap) => ({ bitmap, width: w, height: h }));
}

function getAnnotations(pageIndex: number): AnnotationDTO[] {
  const page = doc!.loadPage(pageIndex) as mupdf.PDFPage;
  const annots = page.getAnnotations();
  const results: AnnotationDTO[] = [];

  for (let i = 0; i < annots.length; i++) {
    try {
      const a = annots[i];
      // Some annotation types (Highlight, etc.) don't have a Rect property;
      // compute bounding rect from QuadPoints or getBounds() instead.
      let rect: [number, number, number, number];
      if (a.hasRect()) {
        rect = a.getRect();
      } else {
        // Use getBounds() which works for all annotation types
        rect = a.getBounds();
      }

      const dto: AnnotationDTO = {
        id: `${pageIndex}-${i}`,
        page: pageIndex,
        type: a.getType(),
        rect,
        color: a.getColor() as number[],
        opacity: a.getOpacity(),
        contents: a.getContents(),
        borderWidth: a.hasBorder() ? a.getBorderWidth() : 0,
        hasRect: a.hasRect(),
      };

      if (a.hasAuthor()) dto.author = a.getAuthor();
      if (a.hasOpen()) dto.isOpen = a.getIsOpen();
      if (a.hasIcon()) dto.icon = a.getIcon();
      if (a.hasInteriorColor()) dto.interiorColor = a.getInteriorColor() as number[];
      if (a.hasQuadPoints()) dto.quadPoints = a.getQuadPoints() as unknown as number[][];
      if (a.hasVertices()) dto.vertices = a.getVertices() as unknown as number[][];
      if (a.hasLine()) dto.line = a.getLine() as unknown as number[][];
      if (a.hasInkList()) dto.inkList = a.getInkList() as unknown as number[][][];

      try { dto.modifiedDate = a.getModificationDate()?.toISOString(); } catch {}
      try { dto.createdDate = a.getCreationDate()?.toISOString(); } catch {}

      if (a.getType() === "FreeText") {
        try {
          dto.defaultAppearance = a.getDefaultAppearance() as { font: string; size: number; color: number[] };
        } catch {}
      }

      results.push(dto);
    } catch (err) {
      console.warn(`Skipping annotation ${i} on page ${pageIndex}:`, err);
    }
  }

  return results;
}

// Resolve annotation by "pageIndex-annotIndex" ID
function resolveAnnot(annotId: string): { page: mupdf.PDFPage; annot: mupdf.PDFAnnotation; pageIndex: number } {
  const [pageStr, indexStr] = annotId.split("-");
  const pageIndex = parseInt(pageStr);
  const annotIndex = parseInt(indexStr);
  const page = doc!.loadPage(pageIndex) as mupdf.PDFPage;
  const annots = page.getAnnotations();
  if (annotIndex < 0 || annotIndex >= annots.length) {
    throw new Error(`Annotation index ${annotIndex} out of range on page ${pageIndex}`);
  }
  return { page, annot: annots[annotIndex], pageIndex };
}

function resolveWidget(widgetId: string): { page: mupdf.PDFPage; widget: mupdf.PDFWidget; pageIndex: number } {
  // Widget IDs are "wPageIndex-WidgetIndex"
  const match = widgetId.match(/^w(\d+)-(\d+)$/);
  if (!match) throw new Error(`Invalid widget ID: ${widgetId}`);
  const pageIndex = parseInt(match[1]);
  const widgetIndex = parseInt(match[2]);
  const page = doc!.loadPage(pageIndex) as mupdf.PDFPage;
  const widgets = page.getWidgets();
  if (widgetIndex < 0 || widgetIndex >= widgets.length) {
    throw new Error(`Widget index ${widgetIndex} out of range on page ${pageIndex}`);
  }
  return { page, widget: widgets[widgetIndex], pageIndex };
}

self.onmessage = async function (e: MessageEvent) {
  const { _rpcId, ...request } = e.data as WorkerRequest & { _rpcId?: number };

  try {
    switch (request.type) {
      case "open": {
        doc = new mupdf.PDFDocument(request.data);
        const pageCount = doc.countPages();
        const pages: PageInfo[] = [];
        for (let i = 0; i < pageCount; i++) {
          pages.push(getPageInfo(i));
        }
        respond(_rpcId, { type: "opened", pageCount, pages });
        break;
      }

      case "getPageCount": {
        respond(_rpcId, { type: "pageCount", count: doc!.countPages() });
        break;
      }

      case "getPageInfo": {
        respond(_rpcId, { type: "pageInfo", page: request.page, info: getPageInfo(request.page) });
        break;
      }

      case "renderPage": {
        const result = await renderPage(request.page, request.scale);
        respond(
          _rpcId,
          {
            type: "pageRendered",
            page: request.page,
            bitmap: result.bitmap,
            width: result.width,
            height: result.height,
          },
          [result.bitmap]
        );
        break;
      }

      case "getAnnotations": {
        const annots = getAnnotations(request.page);
        respond(_rpcId, { type: "annotations", page: request.page, annots });
        break;
      }

      case "getWidgets": {
        const page = doc!.loadPage(request.page) as mupdf.PDFPage;
        const widgets = page.getWidgets();
        const dtos: import("./types").WidgetDTO[] = widgets.map((w, i) => ({
          id: `w${request.page}-${i}`,
          page: request.page,
          fieldType: w.getFieldType(),
          fieldName: w.getName() || `field_${i}`,
          value: w.getValue() || "",
          rect: w.getRect(),
        }));
        respond(_rpcId, { type: "widgets", page: request.page, widgets: dtos });
        break;
      }

      case "setAnnotRect": {
        // Handle both annotation and widget IDs
        if (request.annotId.startsWith("w")) {
          const { widget } = resolveWidget(request.annotId);
          widget.setRect(request.rect);
          widget.update();
          respond(_rpcId, { type: "annotUpdated", annotId: request.annotId });
          break;
        }
        const { annot, pageIndex } = resolveAnnot(request.annotId);
        const type = annot.getType();
        // Line/Ink types compute Rect from content — shift content instead
        if (type === "Line" && annot.hasLine()) {
          const oldLine = annot.getLine();
          const dx = request.rect[0] - annot.getBounds()[0];
          const dy = request.rect[1] - annot.getBounds()[1];
          annot.setLine(
            [oldLine[0][0] + dx, oldLine[0][1] + dy] as any,
            [oldLine[1][0] + dx, oldLine[1][1] + dy] as any
          );
        } else if (type === "Ink" && annot.hasInkList()) {
          const oldInk = annot.getInkList();
          const dx = request.rect[0] - annot.getBounds()[0];
          const dy = request.rect[1] - annot.getBounds()[1];
          const newInk = oldInk.map(stroke =>
            stroke.map(pt => [pt[0] + dx, pt[1] + dy] as mupdf.Point)
          );
          annot.setInkList(newInk);
        } else {
          annot.setRect(request.rect);
        }
        annot.update();
        respond(_rpcId, { type: "annotUpdated", annotId: request.annotId });
        break;
      }

      case "setAnnotColor": {
        const { annot } = resolveAnnot(request.annotId);
        annot.setColor(request.color as mupdf.AnnotColor);
        annot.update();
        respond(_rpcId, { type: "annotUpdated", annotId: request.annotId });
        break;
      }

      case "setAnnotContents": {
        const { annot } = resolveAnnot(request.annotId);
        annot.setContents(request.text);
        annot.update();
        respond(_rpcId, { type: "annotUpdated", annotId: request.annotId });
        break;
      }

      case "setAnnotOpacity": {
        const { annot } = resolveAnnot(request.annotId);
        annot.setOpacity(request.opacity);
        annot.update();
        respond(_rpcId, { type: "annotUpdated", annotId: request.annotId });
        break;
      }

      case "setAnnotBorderWidth": {
        const { annot } = resolveAnnot(request.annotId);
        annot.setBorderWidth(request.width);
        annot.update();
        respond(_rpcId, { type: "annotUpdated", annotId: request.annotId });
        break;
      }

      case "setAnnotInteriorColor": {
        const { annot } = resolveAnnot(request.annotId);
        annot.setInteriorColor(request.color as mupdf.AnnotColor);
        annot.update();
        respond(_rpcId, { type: "annotUpdated", annotId: request.annotId });
        break;
      }

      case "setAnnotDefaultAppearance": {
        const { annot } = resolveAnnot(request.annotId);
        annot.setDefaultAppearance(request.font, request.size, request.color as mupdf.AnnotColor);
        annot.update();
        respond(_rpcId, { type: "annotUpdated", annotId: request.annotId });
        break;
      }

      case "setAnnotIcon": {
        const { annot } = resolveAnnot(request.annotId);
        annot.setIcon(request.icon);
        annot.update();
        respond(_rpcId, { type: "annotUpdated", annotId: request.annotId });
        break;
      }

      case "setAnnotQuadPoints": {
        const { annot } = resolveAnnot(request.annotId);
        annot.setQuadPoints(request.quadPoints as mupdf.Quad[]);
        annot.update();
        respond(_rpcId, { type: "annotUpdated", annotId: request.annotId });
        break;
      }

      case "deleteAnnot": {
        const { page, annot } = resolveAnnot(request.annotId);
        page.deleteAnnotation(annot);
        respond(_rpcId, { type: "annotDeleted", annotId: request.annotId });
        break;
      }

      case "setWidgetValue": {
        const { widget } = resolveWidget(request.widgetId);
        if (widget.isText()) {
          widget.setTextValue(request.value);
        } else if (widget.isChoice()) {
          widget.setChoiceValue(request.value);
        }
        widget.update();
        respond(_rpcId, { type: "annotUpdated", annotId: request.widgetId });
        break;
      }

      case "createAnnot": {
        const page = doc!.loadPage(request.page) as mupdf.PDFPage;
        const annot = page.createAnnotation(request.annotType as mupdf.PDFAnnotationType);

        // Types whose Rect is auto-computed from content — don't call setRect
        const noRectTypes = new Set(["Highlight", "Underline", "StrikeOut", "Squiggly", "Line", "Ink", "Polygon", "PolyLine"]);
        if (!noRectTypes.has(request.annotType)) {
          annot.setRect(request.rect);
        }

        // Apply optional properties (used for undo-delete restoration and creation with defaults)
        const props = request.properties;
        if (props) {
          if (props.color !== undefined) annot.setColor(props.color as mupdf.AnnotColor);
          if (props.opacity !== undefined) annot.setOpacity(props.opacity);
          if (props.contents) annot.setContents(props.contents);
          if (props.icon && annot.hasIcon()) annot.setIcon(props.icon);
          if (props.borderWidth !== undefined && annot.hasBorder()) annot.setBorderWidth(props.borderWidth);
          if (props.interiorColor && annot.hasInteriorColor()) annot.setInteriorColor(props.interiorColor as mupdf.AnnotColor);
          if (props.quadPoints) {
            try { annot.setQuadPoints(props.quadPoints as mupdf.Quad[]); } catch {}
          }
          if (props.defaultAppearance && request.annotType === "FreeText") {
            annot.setDefaultAppearance(props.defaultAppearance.font, props.defaultAppearance.size, props.defaultAppearance.color as mupdf.AnnotColor);
          }
          if (props.inkList) {
            try { annot.setInkList(props.inkList as mupdf.Point[][]); } catch {}
          }
          if (props.line) {
            try { annot.setLine(props.line[0] as mupdf.Point, props.line[1] as mupdf.Point); } catch {}
          }
          if (props.author) annot.setAuthor(props.author);
        }

        annot.update();
        const annots = getAnnotations(request.page);
        const created = annots[annots.length - 1];
        respond(_rpcId, { type: "annotCreated", annot: created });
        break;
      }

      case "extractText": {
        const page = doc!.loadPage(request.page);
        const stext = page.toStructuredText();
        const blocks: TextBlock[] = [];
        let currentBlock: TextBlock | null = null;
        let currentLine: TextLine | null = null;

        stext.walk({
          beginTextBlock(bbox: any) {
            currentBlock = { bbox: bbox as [number, number, number, number], lines: [] };
          },
          beginLine(bbox: any, wmode: number, _direction: any) {
            currentLine = { bbox: bbox as [number, number, number, number], wmode, chars: [] };
          },
          onChar(c: string, origin: any, font: any, size: number, quad: any, color: any) {
            if (currentLine) {
              currentLine.chars.push({
                c,
                origin: origin as [number, number],
                quad: quad as [number, number, number, number, number, number, number, number],
                fontSize: size,
                fontName: font.getName(),
                fontFlags: {
                  isMono: font.isMono(),
                  isSerif: font.isSerif(),
                  isBold: font.isBold(),
                  isItalic: font.isItalic(),
                },
                color: color ? (Array.isArray(color) ? color : [0, 0, 0]) : [0, 0, 0],
              });
            }
          },
          endLine() {
            if (currentBlock && currentLine) {
              currentBlock.lines.push(currentLine);
              currentLine = null;
            }
          },
          endTextBlock() {
            if (currentBlock) {
              blocks.push(currentBlock);
              currentBlock = null;
            }
          },
        });

        respond(_rpcId, { type: "textExtracted", page: request.page, data: { page: request.page, blocks } });
        break;
      }

      case "replaceTextInStream": {
        const page = doc!.loadPage(request.page) as mupdf.PDFPage;
        const pageObj = page.getObject();
        const contentsRef = pageObj.get("Contents");

        let totalCount = 0;

        if (contentsRef.isArray()) {
          // Multiple content streams — process each
          const len = contentsRef.length;
          for (let i = 0; i < len; i++) {
            const streamRef = contentsRef.get(i);
            if (streamRef.isStream()) {
              const streamData = streamRef.readStream().asString();
              const { result, count } = replaceInStream(streamData, request.oldText, request.newText, request.replaceAll ?? false);
              if (count > 0) {
                streamRef.writeStream(result);
                totalCount += count;
                if (!request.replaceAll) break;
              }
            }
          }
        } else if (contentsRef.isStream()) {
          // Single content stream
          const streamData = contentsRef.readStream().asString();
          const { result, count } = replaceInStream(streamData, request.oldText, request.newText, request.replaceAll ?? false);
          if (count > 0) {
            contentsRef.writeStream(result);
            totalCount = count;
          }
        }

        respond(_rpcId, { type: "textReplaced", page: request.page, count: totalCount });
        break;
      }

      case "addImage": {
        const page = doc!.loadPage(request.page) as mupdf.PDFPage;

        // Load image from buffer
        const image = new mupdf.Image(request.imageData);
        const imgW = image.getWidth();
        const imgH = image.getHeight();

        // Create a Stamp annotation at the specified rect
        const stamp = page.createAnnotation("Stamp");
        stamp.setRect(request.rect);

        // Build appearance stream with the image
        const imgRef = doc!.addImage(image);
        const resources = doc!.newDictionary();
        const xobjects = doc!.newDictionary();
        xobjects.put("Img", imgRef);
        resources.put("XObject", xobjects);

        // PDF content stream that draws the image scaled to the rect
        const w = request.rect[2] - request.rect[0];
        const h = request.rect[3] - request.rect[1];
        const content = `q ${w} 0 0 ${h} 0 0 cm /Img Do Q`;

        stamp.setAppearance(
          null, null,
          mupdf.Matrix.identity,
          [0, 0, w, h],
          resources,
          content
        );

        // No border on images by default
        try { stamp.setBorderWidth(0); } catch {}
        try { stamp.setColor([] as mupdf.AnnotColor); } catch {}
        stamp.update();

        const annots = getAnnotations(request.page);
        const created = annots[annots.length - 1];
        respond(_rpcId, { type: "annotCreated", annot: created });
        break;
      }

      case "replaceTextViaRedact": {
        const page = doc!.loadPage(request.page) as mupdf.PDFPage;

        // Step 1: Create Redact annotation over the old text area
        const redact = page.createAnnotation("Redact");
        redact.setRect(request.rect);

        // Step 2: Apply redaction — removes content under the rect
        // black_boxes=false, image_method=0 (none), line_art_method=0 (none), text_method=0 (remove)
        page.applyRedactions(false, 0, 0, 0);

        // Step 3: Create borderless FreeText annotation with new text
        if (request.newText.trim()) {
          const ft = page.createAnnotation("FreeText");
          // Slightly inset the rect to avoid clipping
          ft.setRect([request.rect[0], request.rect[1], request.rect[2], request.rect[3]]);
          ft.setContents(request.newText);
          ft.setDefaultAppearance(
            request.fontFamily as string,
            request.fontSize,
            request.color as mupdf.AnnotColor
          );
          ft.setBorderWidth(0);
          ft.setColor([]); // transparent border
          ft.update();
        }

        respond(_rpcId, { type: "textReplaced", page: request.page, count: 1 });
        break;
      }

      case "replaceTextSmart": {
        const page = doc!.loadPage(request.page) as mupdf.PDFPage;
        const pageObj = page.getObject();
        const contentsRef = pageObj.get("Contents");

        // Helper: replace text in a content stream
        const tryStreamReplace = (streamRef: any): boolean => {
          if (!streamRef.isStream()) return false;
          const streamData = streamRef.readStream().asString();
          const { result, count } = replaceInStream(streamData, request.oldText, request.newText);
          if (count > 0) {
            streamRef.writeStream(result);
            return true;
          }
          return false;
        };

        const doStreamReplace = (): boolean => {
          if (contentsRef.isArray()) {
            for (let i = 0; i < contentsRef.length; i++) {
              if (tryStreamReplace(contentsRef.get(i))) return true;
            }
          } else if (contentsRef.isStream()) {
            if (tryStreamReplace(contentsRef)) return true;
          }
          return false;
        };

        // --- Step 1: Check characters and style overrides ---
        const allNewTextChars = [...new Set(request.newText)].filter(c => c.trim());
        let augmentedAnyFont = false;
        const hasStyleOverride = request.boldOverride !== undefined || request.italicOverride !== undefined;

        console.log(`[FontAugment] Checking ${allNewTextChars.length} unique chars in new text: "${allNewTextChars.join("")}"${hasStyleOverride ? " [style override]" : ""}`);

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

                if (subtype !== "TrueType") {
                  console.log(`[FontAugment] Skipping /${fontKey} "${baseFontName}" (${subtype}, not TrueType)`);
                  continue;
                }

                // If we know which font the selected text uses, only process that one
                if (request.fontName && baseFontName !== request.fontName) {
                  console.log(`[FontAugment] Skipping /${fontKey} "${baseFontName}" (not the selected text's font "${request.fontName}")`);
                  continue;
                }

                const encoding = fontObj.get("Encoding");
                const encodingName = encoding.isName() ? encoding.asName() : (encoding.isDictionary() ? "custom" : "none");

                if (encodingName !== "WinAnsiEncoding" && encodingName !== "MacRomanEncoding") {
                  console.log(`[FontAugment] Skipping /${fontKey} "${baseFontName}" (encoding: ${encodingName})`);
                  continue;
                }

                const descriptor = fontObj.get("FontDescriptor");
                if (descriptor.isNull()) {
                  console.log(`[FontAugment] Skipping /${fontKey} "${baseFontName}" (no FontDescriptor)`);
                  continue;
                }

                const fontFile2 = descriptor.get("FontFile2");
                if (!fontFile2.isStream()) {
                  console.log(`[FontAugment] Skipping /${fontKey} "${baseFontName}" (no FontFile2 stream)`);
                  continue;
                }

                // Extract font binary
                const subsetBuf = fontFile2.readStream();
                const subsetArray = subsetBuf.asUint8Array();
                const subsetBuffer = new ArrayBuffer(subsetArray.byteLength);
                new Uint8Array(subsetBuffer).set(subsetArray);
                console.log(`[FontAugment] Extracted /${fontKey} "${baseFontName}" (${subsetArray.byteLength} bytes, ${encodingName})`);

                // Check EVERY character in the new text against this font
                const missingInThisFont: string[] = [];
                const presentInThisFont: string[] = [];

                try {
                  const opentype = await import("opentype.js");
                  const parsedFont = opentype.parse(subsetBuffer);
                  if (parsedFont) {
                    console.log(`[FontAugment] Parsed font: ${parsedFont.glyphs.length} glyphs, unitsPerEm=${parsedFont.unitsPerEm}`);
                    for (const ch of allNewTextChars) {
                      const glyph = parsedFont.charToGlyph(ch);
                      const hasOutline = glyph && glyph.path && glyph.path.commands && glyph.path.commands.length > 0;
                      const advW = glyph ? glyph.advanceWidth : 0;
                      if (!glyph || glyph.index === 0 || !hasOutline) {
                        missingInThisFont.push(ch);
                        console.log(`[FontAugment]   "${ch}" (U+${ch.charCodeAt(0).toString(16).padStart(4,"0")}): index=${glyph?.index ?? "null"}, pathCmds=${glyph?.path?.commands?.length ?? 0}, advW=${advW} → MISSING`);
                      } else {
                        presentInThisFont.push(ch);
                      }
                    }
                  }
                } catch (parseErr) {
                  console.warn(`[FontAugment] opentype.js parse failed for "${baseFontName}":`, parseErr);
                  missingInThisFont.push(...allNewTextChars);
                }

                console.log(`[FontAugment] /${fontKey} "${baseFontName}": present=[${presentInThisFont.join("")}] missing=[${missingInThisFont.join("")}]`);

                if (missingInThisFont.length === 0 && !hasStyleOverride) continue;

                // For style overrides with no missing glyphs, use font-switching approach
                if (hasStyleOverride && missingInThisFont.length === 0) {
                  // Add new font with the overridden style as a separate resource
                  const parsed = parseFontName(baseFontName);
                  const flags = descriptor.get("Flags")?.asNumber?.() || 0;
                  const match = matchReferenceFont(parsed, flags);
                  if (request.boldOverride !== undefined) match.bold = request.boldOverride;
                  if (request.italicOverride !== undefined) match.italic = request.italicOverride;
                  const refBuffer = fetchFont(match);
                  if (!refBuffer) continue;

                  const newFont = new mupdf.Font(baseFontName + "_edit", refBuffer);
                  const newFontResource = doc!.addSimpleFont(newFont, "Latin");
                  const editFontKey = "F_edit_" + Date.now();
                  fontDict.put(editFontKey, newFontResource);
                  const styleDesc = `${match.bold ? "Bold" : "Regular"}${match.italic ? " Italic" : ""}`;
                  console.log(`[FontAugment] Added /${editFontKey} (${styleDesc}) for style switch`);

                  // Do content stream replacement with font switching
                  const doFontSwitchReplace = (): boolean => {
                    const contentsRef2 = pageObj.get("Contents");
                    if (contentsRef2.isArray()) {
                      for (let ci = 0; ci < contentsRef2.length; ci++) {
                        const sr = contentsRef2.get(ci);
                        if (!sr.isStream()) continue;
                        const data = sr.readStream().asString();
                        const { result, count } = replaceTextWithFontSwitch(data, request.oldText, request.newText, editFontKey);
                        if (count > 0) { sr.writeStream(result); return true; }
                      }
                    } else if (contentsRef2.isStream()) {
                      const data = contentsRef2.readStream().asString();
                      const { result, count } = replaceTextWithFontSwitch(data, request.oldText, request.newText, editFontKey);
                      if (count > 0) { contentsRef2.writeStream(result); return true; }
                    }
                    return false;
                  };

                  if (doFontSwitchReplace()) {
                    respond(_rpcId, { type: "textReplacedSmart", page: request.page, count: 1, method: "font-augment" });
                    return;
                  }
                  continue;
                }

                // Match and fetch reference font, applying style overrides
                const parsed = parseFontName(baseFontName);
                const flags = descriptor.get("Flags")?.asNumber?.() || 0;
                const match = matchReferenceFont(parsed, flags);
                // Apply user style overrides (Ctrl+B/I)
                if (request.boldOverride !== undefined) match.bold = request.boldOverride;
                if (request.italicOverride !== undefined) match.italic = request.italicOverride;
                console.log(`[FontAugment] Matched "${baseFontName}" → ${match.googleFamily} (${match.confidence})`);

                const refBuffer = fetchFont(match);
                if (!refBuffer) {
                  console.warn(`[FontAugment] ✗ Failed to fetch reference font`);
                  continue;
                }

                let fontBufferToUse: ArrayBuffer;
                if (missingInThisFont.length > 0) {
                  const augmented = augmentFont(subsetBuffer, refBuffer, missingInThisFont);
                  if (augmented) {
                    fontBufferToUse = augmented;
                    console.log(`[FontAugment] Augmented with ${missingInThisFont.length} glyph(s): ${missingInThisFont.join(", ")}`);
                  } else {
                    console.warn(`[FontAugment] ✗ augmentFont() returned null`);
                    continue;
                  }
                } else {
                  // Style override only — use the reference font directly
                  fontBufferToUse = refBuffer;
                  console.log(`[FontAugment] Using reference font directly for style change`);
                }

                // Create a NEW mupdf.Font and replace the dictionary entry
                const newFont = new mupdf.Font(baseFontName, fontBufferToUse);
                const newFontResource = doc!.addSimpleFont(newFont, "Latin");
                fontDict.put(fontKey, newFontResource);
                console.log(`[FontAugment] ✓ Replaced /${fontKey} with ${match.bold ? "Bold" : "Regular"} variant (${fontBufferToUse.byteLength} bytes)`);
                augmentedAnyFont = true;
              } catch (fontErr) {
                console.warn(`[FontAugment] Error processing font /${fontKey}:`, fontErr);
              }
            }
          } else {
            console.log(`[FontAugment] No font dictionary found on page`);
          }
        } catch (err) {
          console.warn("[FontAugment] Glyph check failed:", err);
        }

        // --- Step 2: If we augmented fonts, clear MuPDF's cache ---
        if (augmentedAnyFont) {
          mupdf.emptyStore(); // Clear all cached font/image data
          console.log(`[FontAugment] Cleared MuPDF store cache`);
        }

        // --- Step 3: Content stream replacement ---
        if (doStreamReplace()) {
          const method = augmentedAnyFont ? "font-augment" : "content-stream";
          respond(_rpcId, { type: "textReplacedSmart", page: request.page, count: 1, method });
          break;
        }

        // --- Step 3: Failed ---
        console.warn(`[TextEdit] All methods failed for "${request.oldText}" on page ${request.page}`);
        respond(_rpcId, { type: "textReplacedSmart", page: request.page, count: 0, method: "failed" });
        break;
      }

      case "searchText": {
        const results: TextSearchResult[] = [];
        const pageCount = doc!.countPages();
        const startPage = request.page !== undefined ? request.page : 0;
        const endPage = request.page !== undefined ? request.page + 1 : pageCount;

        for (let i = startPage; i < endPage; i++) {
          const page = doc!.loadPage(i);
          const stext = page.toStructuredText();
          const hits = stext.search(request.needle);
          for (const quadGroup of hits) {
            results.push({
              page: i,
              quads: quadGroup as unknown as number[][],
              text: request.needle,
            });
          }
        }

        respond(_rpcId, { type: "searchResults", results });
        break;
      }

      case "rotatePage": {
        const rPage = doc!.loadPage(request.page) as mupdf.PDFPage;
        const pageObj = rPage.getObject();
        let currentRotation = 0;
        try { currentRotation = pageObj.get("Rotate")?.asNumber?.() || 0; } catch {}
        const newRotation = ((currentRotation + request.angle) % 360 + 360) % 360;
        pageObj.put("Rotate", newRotation);
        respond(_rpcId, { type: "pageRotated", page: request.page, info: getPageInfo(request.page) });
        break;
      }

      case "save": {
        // Strip unused glyphs from any augmented/embedded fonts
        try { doc!.subsetFonts(); } catch {}
        const buf = doc!.saveToBuffer(request.options || "incremental");
        const bytes = buf.asUint8Array();
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        respond(_rpcId, { type: "saved", buffer } as WorkerResponse, [buffer]);
        break;
      }

      default: {
        respond(_rpcId, {
          type: "error",
          message: `Unknown request type: ${(request as any).type}`,
        });
      }
    }
  } catch (err: any) {
    respond(_rpcId, {
      type: "error",
      message: err?.message || String(err),
      requestType: request.type,
    });
  }
};
