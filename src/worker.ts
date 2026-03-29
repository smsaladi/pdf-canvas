// MuPDF Web Worker — dispatches PDF operations
// Helper functions are in ./worker/helpers.ts
// Shared document state is in ./worker/doc-state.ts
import * as mupdf from "mupdf";
import { createWorkerResponder } from "./worker-rpc";
import type { WorkerRequest, WorkerResponse, PageInfo, AnnotationDTO, TextBlock, TextLine, CharInfo, PageTextData, TextSearchResult } from "./types";
import { replaceTextInStream as replaceInStream, replaceTextWithFontSwitch, parseToUnicodeCMap, replaceHexTextInStream } from "./content-stream";
import { parseFontName, matchReferenceFont, fetchFont, augmentFont } from "./font-augment";
import { setDoc, getDoc } from "./worker/doc-state";
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

              const tryHex = (ref: any): boolean => {
                if (!ref.isStream()) return false;
                const { result, count, missingChars } = replaceHexTextInStream(ref.readStream().asString(), request.oldText, request.newText, gidToUnicode, unicodeToGid);
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
