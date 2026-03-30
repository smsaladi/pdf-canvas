// Drag and resize logic for annotation overlays
import { QUADPOINT_TYPES } from "./constants";
import type { InteractionContext, DragState } from "./context";

export function startDrag(ctx: InteractionContext, annotId: string, e: PointerEvent, handle: string | null): void {
  const el = ctx.overlayElements.get(annotId);
  const annot = ctx.getAnnotationForId(annotId);
  if (!el || !annot) return;

  ctx.dragState = {
    annotId,
    startScreenX: e.clientX,
    startScreenY: e.clientY,
    originalLeft: parseFloat(el.style.left),
    originalTop: parseFloat(el.style.top),
    originalWidth: parseFloat(el.style.width) || el.offsetWidth,
    originalHeight: parseFloat(el.style.height) || el.offsetHeight,
    originalAnnotRect: [...annot.rect] as [number, number, number, number],
    originalQuadPoints: annot.quadPoints ? annot.quadPoints.map(q => [...q]) : undefined,
    handle,
  };

  el.style.transition = "none";
  e.preventDefault();
}

export function handleDragMove(ctx: InteractionContext, e: PointerEvent): void {
  if (!ctx.dragState) return;

  const { annotId, startScreenX, startScreenY, originalLeft, originalTop, originalWidth, originalHeight, handle } = ctx.dragState;
  const el = ctx.overlayElements.get(annotId);
  if (!el) return;

  let dx = e.clientX - startScreenX;
  let dy = e.clientY - startScreenY;

  if (handle === null) {
    if (e.shiftKey) {
      if (Math.abs(dx) > Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    el.style.left = `${originalLeft + dx}px`;
    el.style.top = `${originalTop + dy}px`;
  } else {
    applyResize(el, handle, dx, dy, originalLeft, originalTop, originalWidth, originalHeight, e.shiftKey);
  }
}

export async function handleDragEnd(ctx: InteractionContext, e: PointerEvent): Promise<void> {
  if (!ctx.dragState) return;

  const { annotId, startScreenX, startScreenY, handle, originalAnnotRect, originalQuadPoints } = ctx.dragState;
  let dx = e.clientX - startScreenX;
  let dy = e.clientY - startScreenY;
  ctx.dragState = null;

  if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;

  // Shift: constrain move to axis
  if (e.shiftKey && handle === null) {
    if (Math.abs(dx) > Math.abs(dy)) dy = 0;
    else dx = 0;
  }

  const scale = ctx.viewport.getScale();
  const annot = ctx.getAnnotationForId(annotId);
  if (!annot) return;

  const pdfDx = dx / scale;
  const pdfDy = dy / scale;
  const isImage = annotId.startsWith("img");

  // For images: snapshot before the content stream change for reliable undo
  let snapshot: ArrayBuffer | null = null;
  if (isImage) {
    snapshot = await ctx.snapshotForUndo();
  }

  if (handle === null) {
    if (QUADPOINT_TYPES.has(annot.type) && originalQuadPoints && originalQuadPoints.length > 0) {
      const newQuads = originalQuadPoints.map(q => {
        const shifted = [...q];
        for (let i = 0; i < shifted.length; i += 2) {
          shifted[i] += pdfDx;
          shifted[i + 1] += pdfDy;
        }
        return shifted;
      });

      if (ctx.undoManager) {
        ctx.undoManager.push({ annotId, property: "quadPoints", previousValue: originalQuadPoints, newValue: newQuads });
      }
      await ctx.moveQuadPoints(annotId, newQuads);
    } else {
      const newRect: [number, number, number, number] = [
        originalAnnotRect[0] + pdfDx,
        originalAnnotRect[1] + pdfDy,
        originalAnnotRect[2] + pdfDx,
        originalAnnotRect[3] + pdfDy,
      ];

      if (ctx.undoManager) {
        if (isImage && snapshot) {
          ctx.undoManager.push({ annotId, property: "textEdit", previousValue: snapshot, newValue: newRect });
        } else {
          ctx.undoManager.push({ annotId, property: "rect", previousValue: originalAnnotRect, newValue: newRect });
        }
      }
      await ctx.moveAnnot(annotId, newRect);
    }
  } else {
    const newRect = computeResizedRect(handle, pdfDx, pdfDy, originalAnnotRect, e.shiftKey);

    if (ctx.undoManager) {
      if (isImage && snapshot) {
        ctx.undoManager.push({ annotId, property: "textEdit", previousValue: snapshot, newValue: newRect });
      } else {
        ctx.undoManager.push({ annotId, property: "rect", previousValue: originalAnnotRect, newValue: newRect });
      }
    }
    await ctx.moveAnnot(annotId, newRect);
  }

  await ctx.viewport.rerenderPage(annot.page);

  const updated = ctx.getAnnotationForId(annotId);
  if (updated) {
    for (const listener of ctx.selectionListeners) {
      listener(updated);
    }
  }
}

export function applyResize(
  el: HTMLDivElement, handle: string, dx: number, dy: number,
  origLeft: number, origTop: number, origWidth: number, origHeight: number,
  shiftKey = false
): void {
  let newLeft = origLeft, newTop = origTop, newWidth = origWidth, newHeight = origHeight;

  if (handle.includes("w")) { newLeft = origLeft + dx; newWidth = origWidth - dx; }
  if (handle.includes("e")) { newWidth = origWidth + dx; }
  if (handle.includes("n")) { newTop = origTop + dy; newHeight = origHeight - dy; }
  if (handle.includes("s")) { newHeight = origHeight + dy; }

  if (shiftKey && origWidth > 0 && origHeight > 0) {
    const aspect = origWidth / origHeight;
    if (handle.length === 2) {
      if (Math.abs(newWidth - origWidth) > Math.abs(newHeight - origHeight)) {
        newHeight = newWidth / aspect;
      } else {
        newWidth = newHeight * aspect;
      }
      if (handle.includes("n")) newTop = origTop + origHeight - newHeight;
      if (handle.includes("w")) newLeft = origLeft + origWidth - newWidth;
    } else {
      if (handle === "e" || handle === "w") newHeight = newWidth / aspect;
      else newWidth = newHeight * aspect;
    }
  }

  if (newWidth < 10) { newWidth = 10; if (handle.includes("w")) newLeft = origLeft + origWidth - 10; }
  if (newHeight < 10) { newHeight = 10; if (handle.includes("n")) newTop = origTop + origHeight - 10; }

  el.style.left = `${newLeft}px`;
  el.style.top = `${newTop}px`;
  el.style.width = `${newWidth}px`;
  el.style.height = `${newHeight}px`;
}

export function computeResizedRect(
  handle: string, pdfDx: number, pdfDy: number,
  orig: [number, number, number, number],
  shiftKey = false
): [number, number, number, number] {
  let [x1, y1, x2, y2] = orig;
  const origW = x2 - x1, origH = y2 - y1;

  if (handle.includes("w")) x1 += pdfDx;
  if (handle.includes("e")) x2 += pdfDx;
  if (handle.includes("n")) y1 += pdfDy;
  if (handle.includes("s")) y2 += pdfDy;

  // Shift: maintain aspect ratio
  if (shiftKey && origW > 0 && origH > 0) {
    const aspect = origW / origH;
    let newW = x2 - x1, newH = y2 - y1;
    if (handle.length === 2) {
      // Corner handle
      if (Math.abs(newW - origW) > Math.abs(newH - origH)) {
        newH = newW / aspect;
      } else {
        newW = newH * aspect;
      }
    } else {
      // Edge handle
      if (handle === "e" || handle === "w") newH = newW / aspect;
      else newW = newH * aspect;
    }
    if (handle.includes("w")) x1 = x2 - newW;
    else x2 = x1 + newW;
    if (handle.includes("n")) y1 = y2 - newH;
    else y2 = y1 + newH;
  }

  if (x2 - x1 < 5) { if (handle.includes("w")) x1 = x2 - 5; else x2 = x1 + 5; }
  if (y2 - y1 < 5) { if (handle.includes("n")) y1 = y2 - 5; else y2 = y1 + 5; }

  return [x1, y1, x2, y2];
}
