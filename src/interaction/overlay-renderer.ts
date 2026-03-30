// Overlay rendering: create, position, and update annotation/widget/image overlays
import type { AnnotationDTO, WidgetDTO, PageImageDTO } from "../types";
import { pdfRectToScreenRect } from "../coords";
import { HANDLE_SIZE, NOTE_ICON_SIZE, ICON_TYPES, QUADPOINT_TYPES } from "./constants";
import type { InteractionContext } from "./context";

export function rebuildAllOverlayContainers(ctx: InteractionContext): void {
  for (const [, container] of ctx.overlayContainers) container.remove();
  ctx.overlayContainers.clear();
  ctx.overlayElements.clear();

  for (const page of ctx.viewport.getPages()) ensureOverlayContainer(ctx, page.index);

  for (const page of ctx.viewport.getPages()) {
    const annots = ctx.viewport.getAnnotations(page.index);
    if (annots.length > 0) renderOverlaysForPage(ctx, page.index, annots);
  }
}

export function ensureOverlayContainer(ctx: InteractionContext, pageIndex: number): HTMLDivElement {
  let container = ctx.overlayContainers.get(pageIndex);
  if (!container) {
    container = document.createElement("div");
    container.className = "annotation-overlay-container";
    container.dataset.page = String(pageIndex);

    const containerEl = container;
    containerEl.addEventListener("pointerdown", (e) => {
      if (e.target === containerEl || (e.target as HTMLElement).classList.contains("text-highlight-container")) {
        if (ctx.currentTool === "textedit" && ctx.textLayer) {
          const rect = containerEl.getBoundingClientRect();
          const screenX = e.clientX - rect.left;
          const screenY = e.clientY - rect.top;
          const scale = ctx.viewport.getScale();
          const pdfX = screenX / scale;
          const pdfY = screenY / scale;
          ctx.textLayer.handlePointerDown(pageIndex, pdfX, pdfY, e);
          e.preventDefault();
        } else if (ctx.currentTool !== "select" && ctx.currentTool !== "textedit") {
          ctx.startCreation(pageIndex, e);
        } else {
          ctx.select(null);
        }
      }
    });

    const pageWrapper = ctx.viewport.getPageContainer(pageIndex);
    if (pageWrapper) pageWrapper.appendChild(container);
    ctx.overlayContainers.set(pageIndex, container);
  }
  return container;
}

export function renderOverlaysForPage(ctx: InteractionContext, pageIndex: number, annotations: AnnotationDTO[]): void {
  const container = ensureOverlayContainer(ctx, pageIndex);

  const oldIds = new Set<string>();
  for (const [id, el] of ctx.overlayElements) {
    if (el.parentElement === container) oldIds.add(id);
  }
  for (const id of oldIds) {
    ctx.overlayElements.get(id)?.remove();
    ctx.overlayElements.delete(id);
  }

  for (const annot of annotations) {
    if (annot.type === "Popup") continue;
    const overlay = createOverlay(ctx, annot);
    if (overlay) {
      container.appendChild(overlay);
      ctx.overlayElements.set(annot.id, overlay);
      if (ctx.selectedIds.has(annot.id)) {
        overlay.classList.add("selected");
        if (ctx.selectedIds.size === 1) addHandles(ctx, overlay);
      }
    }
  }
}

export function renderWidgetOverlaysForPage(ctx: InteractionContext, pageIndex: number, widgets: WidgetDTO[]): void {
  const container = ensureOverlayContainer(ctx, pageIndex);
  const scale = ctx.viewport.getScale();

  const oldIds = new Set<string>();
  for (const [id, el] of ctx.overlayElements) {
    if (el.parentElement === container && id.startsWith("w")) oldIds.add(id);
  }
  for (const id of oldIds) {
    ctx.overlayElements.get(id)?.remove();
    ctx.overlayElements.delete(id);
  }

  for (const widget of widgets) {
    const screen = pdfRectToScreenRect(widget.rect, { scale, pageOffsetX: 0, pageOffsetY: 0 });
    const div = document.createElement("div");
    div.className = "annot-overlay widget-overlay";
    div.dataset.annotId = widget.id;
    div.dataset.annotType = "Widget";
    div.dataset.widgetType = widget.fieldType;
    div.style.left = `${screen.x}px`;
    div.style.top = `${screen.y}px`;
    div.style.width = `${screen.width}px`;
    div.style.height = `${screen.height}px`;
    div.title = `${widget.fieldType}: ${widget.fieldName}`;

    div.addEventListener("pointerdown", (e) => {
      if (!ctx.canSelect()) return;
      e.stopPropagation();
      ctx.select(widget.id, e.shiftKey);
      if (!(e.target as HTMLElement).classList.contains("resize-handle")) {
        ctx.startDrag(widget.id, e, null);
      }
    });

    container.appendChild(div);
    ctx.overlayElements.set(widget.id, div);

    if (ctx.selectedIds.has(widget.id)) {
      div.classList.add("selected");
      addHandles(ctx, div);
    }
  }
}

export function renderImageOverlaysForPage(ctx: InteractionContext, pageIndex: number, images: PageImageDTO[]): void {
  const container = ensureOverlayContainer(ctx, pageIndex);
  const scale = ctx.viewport.getScale();

  const oldIds = new Set<string>();
  for (const [id, el] of ctx.overlayElements) {
    if (el.parentElement === container && id.startsWith("img")) oldIds.add(id);
  }
  for (const id of oldIds) {
    ctx.overlayElements.get(id)?.remove();
    ctx.overlayElements.delete(id);
  }

  for (const img of images) {
    const screen = pdfRectToScreenRect(img.rect, { scale, pageOffsetX: 0, pageOffsetY: 0 });
    const div = document.createElement("div");
    div.className = "annot-overlay image-overlay";
    div.dataset.annotId = img.id;
    div.dataset.annotType = "Image";
    div.style.left = `${screen.x}px`;
    div.style.top = `${screen.y}px`;
    div.style.width = `${screen.width}px`;
    div.style.height = `${screen.height}px`;
    div.title = `Image (${img.width}×${img.height})`;

    div.addEventListener("pointerdown", (e) => {
      if (!ctx.canSelect()) return;
      e.stopPropagation();
      ctx.select(img.id, e.shiftKey);
      if (!(e.target as HTMLElement).classList.contains("resize-handle")) {
        ctx.startDrag(img.id, e, null);
      }
    });

    container.appendChild(div);
    ctx.overlayElements.set(img.id, div);

    if (ctx.selectedIds.has(img.id)) {
      div.classList.add("selected");
      addHandles(ctx, div);
    }
  }
}

export function createOverlay(ctx: InteractionContext, annot: AnnotationDTO): HTMLDivElement | null {
  const scale = ctx.viewport.getScale();

  if (QUADPOINT_TYPES.has(annot.type) && annot.quadPoints && annot.quadPoints.length > 0) {
    return createQuadPointOverlay(ctx, annot, scale);
  }

  const rect = annot.rect;
  if (!rect) return null;

  const screen = pdfRectToScreenRect(rect, { scale, pageOffsetX: 0, pageOffsetY: 0 });

  const div = document.createElement("div");
  div.className = `annot-overlay annot-type-${annot.type.toLowerCase()}`;
  div.dataset.annotId = annot.id;
  div.dataset.annotType = annot.type;

  if (ICON_TYPES.has(annot.type)) {
    div.style.left = `${screen.x}px`;
    div.style.top = `${screen.y}px`;
    div.style.width = `${NOTE_ICON_SIZE}px`;
    div.style.height = `${NOTE_ICON_SIZE}px`;
    div.classList.add("annot-icon");
    if (annot.color && annot.color.length >= 3) {
      const [r, g, b] = annot.color;
      div.style.backgroundColor = `rgba(${r * 255}, ${g * 255}, ${b * 255}, 0.85)`;
    }
    div.title = annot.contents || annot.type;
  } else {
    div.style.left = `${screen.x}px`;
    div.style.top = `${screen.y}px`;
    div.style.width = `${screen.width}px`;
    div.style.height = `${screen.height}px`;
    if (annot.color && annot.color.length >= 3 && isFinite(annot.color[0])) {
      const [r, g, b] = annot.color;
      div.dataset.borderColor = `rgba(${r * 255}, ${g * 255}, ${b * 255}, 1)`;
    }
  }

  div.addEventListener("pointerdown", (e) => {
    if (!ctx.canSelect()) return;
    e.stopPropagation();
    if (ctx.activeInlineEdit?.annotId === annot.id && (e.target as HTMLElement).classList.contains("freetext-inline-edit")) return;
    ctx.select(annot.id, e.shiftKey);
    if (!(e.target as HTMLElement).classList.contains("resize-handle")) {
      ctx.startDrag(annot.id, e, null);
    }
  });

  if (annot.type === "FreeText") {
    div.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      ctx.startInlineEdit(annot.id);
    });
  }

  if (annot.type === "Text") {
    div.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      for (const listener of ctx.selectionListeners) listener(annot);
      requestAnimationFrame(() => {
        const textarea = document.querySelector<HTMLTextAreaElement>('[data-prop="contents"]');
        if (textarea) textarea.focus();
      });
    });
  }

  return div;
}

export function createQuadPointOverlay(ctx: InteractionContext, annot: AnnotationDTO, scale: number): HTMLDivElement {
  const quads = annot.quadPoints!;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const quad of quads) {
    for (let i = 0; i < quad.length; i += 2) {
      const x = (quad[i] as number) * scale;
      const y = (quad[i + 1] as number) * scale;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  const div = document.createElement("div");
  div.className = `annot-overlay annot-type-${annot.type.toLowerCase()} annot-quadpoint`;
  div.dataset.annotId = annot.id;
  div.dataset.annotType = annot.type;
  div.style.left = `${minX}px`;
  div.style.top = `${minY}px`;
  div.style.width = `${maxX - minX}px`;
  div.style.height = `${maxY - minY}px`;

  if (annot.color && annot.color.length >= 3) {
    const [r, g, b] = annot.color;
    const opacity = annot.opacity ?? 0.3;
    div.style.backgroundColor = `rgba(${r * 255}, ${g * 255}, ${b * 255}, ${opacity})`;
  }
  div.title = annot.contents || annot.type;

  div.addEventListener("pointerdown", (e) => {
    if (!ctx.canSelect()) return;
    e.stopPropagation();
    ctx.select(annot.id, e.shiftKey);
    ctx.startDrag(annot.id, e, null);
  });

  return div;
}

export function updateAllOverlayPositions(ctx: InteractionContext): void {
  const scale = ctx.viewport.getScale();
  for (const page of ctx.viewport.getPages()) {
    const annots = ctx.viewport.getAnnotations(page.index);
    for (const annot of annots) {
      const el = ctx.overlayElements.get(annot.id);
      if (!el) continue;

      if (QUADPOINT_TYPES.has(annot.type) && annot.quadPoints) {
        const quads = annot.quadPoints;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const quad of quads) {
          for (let i = 0; i < quad.length; i += 2) {
            minX = Math.min(minX, (quad[i] as number) * scale);
            minY = Math.min(minY, (quad[i + 1] as number) * scale);
            maxX = Math.max(maxX, (quad[i] as number) * scale);
            maxY = Math.max(maxY, (quad[i + 1] as number) * scale);
          }
        }
        el.style.left = `${minX}px`; el.style.top = `${minY}px`;
        el.style.width = `${maxX - minX}px`; el.style.height = `${maxY - minY}px`;
      } else if (ICON_TYPES.has(annot.type)) {
        const s = pdfRectToScreenRect(annot.rect, { scale, pageOffsetX: 0, pageOffsetY: 0 });
        el.style.left = `${s.x}px`; el.style.top = `${s.y}px`;
      } else {
        const s = pdfRectToScreenRect(annot.rect, { scale, pageOffsetX: 0, pageOffsetY: 0 });
        el.style.left = `${s.x}px`; el.style.top = `${s.y}px`;
        el.style.width = `${s.width}px`; el.style.height = `${s.height}px`;
      }

      if (ctx.selectedIds.has(annot.id) && ctx.selectedIds.size === 1) {
        removeHandles(el);
        addHandles(ctx, el);
      }
    }
  }
}

export function addHandles(ctx: InteractionContext, el: HTMLDivElement): void {
  const annot = ctx.getAnnotationForElement(el);
  if (annot && (ICON_TYPES.has(annot.type) || QUADPOINT_TYPES.has(annot.type))) return;

  for (const pos of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
    const handle = document.createElement("div");
    handle.className = `resize-handle handle-${pos}`;
    handle.dataset.handle = pos;
    handle.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      const annotId = el.dataset.annotId;
      if (annotId) ctx.startDrag(annotId, e, pos);
    });
    el.appendChild(handle);
  }
}

export function removeHandles(el: HTMLDivElement): void {
  el.querySelectorAll(".resize-handle").forEach((h) => h.remove());
}
