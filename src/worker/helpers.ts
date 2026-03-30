// Shared helper functions for worker handlers
import * as mupdf from "mupdf";
import { getDoc } from "./doc-state";
import type { PageInfo, AnnotationDTO } from "../types";

export function getPageInfo(pageIndex: number): PageInfo {
  const page = getDoc().loadPage(pageIndex);
  const bounds = page.getBounds();
  return {
    index: pageIndex,
    width: bounds[2] - bounds[0],
    height: bounds[3] - bounds[1],
  };
}

export async function renderPage(pageIndex: number, scale: number): Promise<{ bitmap: ImageBitmap; width: number; height: number }> {
  const page = getDoc().loadPage(pageIndex) as mupdf.PDFPage;
  const matrix: mupdf.Matrix = [scale, 0, 0, scale, 0, 0];
  const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false);
  const w = pixmap.getWidth();
  const h = pixmap.getHeight();
  const pixels = pixmap.getPixels();

  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, j = 0; i < pixels.length; i += 3, j += 4) {
    rgba[j] = pixels[i];
    rgba[j + 1] = pixels[i + 1];
    rgba[j + 2] = pixels[i + 2];
    rgba[j + 3] = 255;
  }

  const imageData = new ImageData(rgba, w, h);
  const bitmap = await createImageBitmap(imageData);
  return { bitmap, width: w, height: h };
}

export function getAnnotations(pageIndex: number): AnnotationDTO[] {
  const page = getDoc().loadPage(pageIndex) as mupdf.PDFPage;
  const annots = page.getAnnotations();
  const results: AnnotationDTO[] = [];

  for (let i = 0; i < annots.length; i++) {
    try {
      const a = annots[i];
      let rect: [number, number, number, number];
      if (a.hasRect()) {
        rect = a.getRect();
      } else {
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
        borderStyle: a.hasBorder() ? a.getBorderStyle() : undefined,
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

      try {
        const md = a.getModificationDate();
        if (md && md.valueOf() > 0) dto.modifiedDate = md.toISOString();
      } catch {}
      try {
        const cd = a.getCreationDate();
        if (cd && cd.valueOf() > 0) dto.createdDate = cd.toISOString();
      } catch {}

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

export function resolveAnnot(annotId: string): { page: mupdf.PDFPage; annot: mupdf.PDFAnnotation; pageIndex: number } {
  const [pageStr, indexStr] = annotId.split("-");
  const pageIndex = parseInt(pageStr);
  const annotIndex = parseInt(indexStr);
  const page = getDoc().loadPage(pageIndex) as mupdf.PDFPage;
  const annots = page.getAnnotations();
  if (annotIndex < 0 || annotIndex >= annots.length) {
    throw new Error(`Annotation index ${annotIndex} out of range on page ${pageIndex}`);
  }
  return { page, annot: annots[annotIndex], pageIndex };
}

export function resolveWidget(widgetId: string): { page: mupdf.PDFPage; widget: mupdf.PDFWidget; pageIndex: number } {
  const match = widgetId.match(/^w(\d+)-(\d+)$/);
  if (!match) throw new Error(`Invalid widget ID: ${widgetId}`);
  const pageIndex = parseInt(match[1]);
  const widgetIndex = parseInt(match[2]);
  const page = getDoc().loadPage(pageIndex) as mupdf.PDFPage;
  const widgets = page.getWidgets();
  if (widgetIndex < 0 || widgetIndex >= widgets.length) {
    throw new Error(`Widget index ${widgetIndex} out of range on page ${pageIndex}`);
  }
  return { page, widget: widgets[widgetIndex], pageIndex };
}
