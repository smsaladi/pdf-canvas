// MuPDF Web Worker — all PDF operations happen here
import * as mupdf from "mupdf";
import { createWorkerResponder } from "./worker-rpc";
import type { WorkerRequest, WorkerResponse, PageInfo, AnnotationDTO } from "./types";

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
          if (props.color && props.color.length >= 3) annot.setColor(props.color as mupdf.AnnotColor);
          if (props.opacity !== undefined) annot.setOpacity(props.opacity);
          if (props.contents) annot.setContents(props.contents);
          if (props.icon && annot.hasIcon()) annot.setIcon(props.icon);
          if (props.borderWidth !== undefined && annot.hasBorder()) annot.setBorderWidth(props.borderWidth);
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

      case "save": {
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
