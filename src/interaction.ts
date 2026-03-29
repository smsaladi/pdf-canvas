// Interaction layer: annotation overlays, selection, drag, resize

import type { Viewport } from "./viewport";
import type { AnnotationDTO, WidgetDTO } from "./types";
import type { ToolMode } from "./toolbar";
import { pdfRectToScreenRect, screenToPdf } from "./coords";
import type { UndoManager } from "./undo";
import type { TextLayer } from "./text-layer";
import { HANDLE_SIZE, NOTE_ICON_SIZE, ICON_TYPES, QUADPOINT_TYPES, TOOL_TO_ANNOT_TYPE } from "./interaction/constants";

export type SelectionListener = (annotation: AnnotationDTO | null) => void;
export type MutationListener = (annotId: string, property: string, oldValue: any, newValue: any) => void;

interface DragState {
  annotId: string;
  startScreenX: number;
  startScreenY: number;
  originalLeft: number;
  originalTop: number;
  handle: string | null;
  originalWidth: number;
  originalHeight: number;
  originalAnnotRect: [number, number, number, number];
  originalQuadPoints?: number[][];
}

interface CreationState {
  tool: ToolMode;
  pageIndex: number;
  startScreenX: number;
  startScreenY: number;
  lastX: number;
  lastY: number;
  previewEl: HTMLDivElement;
  svgEl?: SVGSVGElement;
  pathEl?: SVGElement;
  inkPoints?: Array<[number, number]>;
}

export class InteractionLayer {
  private viewport: Viewport;
  private overlayContainers = new Map<number, HTMLDivElement>();
  private overlayElements = new Map<string, HTMLDivElement>();
  private selectedId: string | null = null;
  private selectionListeners: SelectionListener[] = [];
  private mutationListeners: MutationListener[] = [];
  private dragState: DragState | null = null;
  private creationState: CreationState | null = null;
  private currentTool: ToolMode = "select";
  private currentColor: [number, number, number] = [1, 0, 0];
  private currentFillColor: [number, number, number] | null = null;
  private currentBorderWidth = 2;
  undoManager: UndoManager | null = null;
  textLayer: TextLayer | null = null;
  onCreationDone: (() => void) | null = null;
  private activeInlineEdit: { annotId: string; el: HTMLDivElement; cleanup: () => void } | null = null;

  setColor(color: [number, number, number]): void { this.currentColor = color; }
  getColor(): [number, number, number] { return this.currentColor; }
  setFillColor(color: [number, number, number] | null): void { this.currentFillColor = color; }
  setBorderWidth(width: number): void { this.currentBorderWidth = width; }

  constructor(viewport: Viewport) {
    this.viewport = viewport;

    viewport.on((event) => {
      switch (event.type) {
        case "annotationsLoaded":
          this.renderOverlaysForPage(event.page, event.annotations);
          break;
        case "widgetsLoaded":
          this.renderWidgetOverlaysForPage(event.page, event.widgets);
          break;
        case "pageLayoutChanged":
          this.rebuildAllOverlayContainers();
          break;
        case "zoomChanged":
          this.updateAllOverlayPositions();
          break;
      }
    });

    // Global pointer move/up for drag and creation operations
    document.addEventListener("pointermove", (e) => this.onPointerMove(e));
    document.addEventListener("pointerup", (e) => this.onPointerUp(e));
  }

  setTool(tool: ToolMode): void {
    // Clear text selection when leaving textedit mode
    if (this.currentTool === "textedit" && tool !== "textedit" && this.textLayer) {
      this.textLayer.clearSelection();
    }
    this.currentTool = tool;
    for (const [, container] of this.overlayContainers) {
      container.style.cursor = tool === "hand" ? "grab" : tool === "textedit" ? "text" : tool === "select" ? "" : "crosshair";
      // In hand mode, disable pointer events on overlays so drag goes to viewport
      container.style.pointerEvents = tool === "hand" ? "none" : "";
    }
  }

  onSelectionChange(listener: SelectionListener): () => void {
    this.selectionListeners.push(listener);
    return () => { this.selectionListeners = this.selectionListeners.filter((l) => l !== listener); };
  }

  onMutation(listener: MutationListener): () => void {
    this.mutationListeners.push(listener);
    return () => { this.mutationListeners = this.mutationListeners.filter((l) => l !== listener); };
  }

  private emitMutation(annotId: string, property: string, oldValue: any, newValue: any) {
    for (const listener of this.mutationListeners) {
      listener(annotId, property, oldValue, newValue);
    }
  }

  getSelectedAnnotation(): AnnotationDTO | null {
    if (!this.selectedId) return null;
    return this.getAnnotationForId(this.selectedId);
  }

  getSelectedId(): string | null {
    return this.selectedId;
  }

  select(annotId: string | null): void {
    if (this.selectedId === annotId) return;

    // Cancel inline edit if switching away
    if (this.activeInlineEdit && this.activeInlineEdit.annotId !== annotId) {
      this.cancelInlineEdit();
    }

    if (this.selectedId) {
      const prev = this.overlayElements.get(this.selectedId);
      if (prev) {
        prev.classList.remove("selected");
        prev.style.cursor = "";
        this.removeHandles(prev);
      }
    }

    this.selectedId = annotId;

    if (annotId) {
      const el = this.overlayElements.get(annotId);
      if (el) {
        el.classList.add("selected");
        el.style.cursor = "move";
        this.addHandles(el);
      }
    }

    const annotation = this.getSelectedAnnotation();
    for (const listener of this.selectionListeners) {
      listener(annotation);
    }
  }

  async deleteSelected(): Promise<void> {
    const annot = this.getSelectedAnnotation();
    if (!annot) return;

    const rpc = this.viewport.getRpc();
    const annotId = annot.id;

    // Push undo
    if (this.undoManager) {
      this.undoManager.push({
        annotId,
        property: "delete",
        previousValue: annot,
        newValue: null,
      });
    }

    this.select(null);
    await rpc.send({ type: "deleteAnnot", annotId });
    await this.viewport.rerenderPage(annot.page);
  }

  async moveAnnot(annotId: string, newRect: [number, number, number, number]): Promise<void> {
    const rpc = this.viewport.getRpc();
    await rpc.send({ type: "setAnnotRect", annotId, rect: newRect });
  }

  async moveQuadPoints(annotId: string, newQuadPoints: number[][]): Promise<void> {
    const rpc = this.viewport.getRpc();
    await rpc.send({ type: "setAnnotQuadPoints", annotId, quadPoints: newQuadPoints });
  }

  // --- Drag and resize ---

  private startDrag(annotId: string, e: PointerEvent, handle: string | null): void {
    const el = this.overlayElements.get(annotId);
    const annot = this.getAnnotationForId(annotId);
    if (!el || !annot) return;

    this.dragState = {
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

  private onPointerMove(e: PointerEvent): void {
    // Handle text edit drag selection
    if (this.currentTool === "textedit" && this.textLayer) {
      // Find which page container the mouse is over
      for (const [pageIndex, container] of this.overlayContainers) {
        const rect = container.getBoundingClientRect();
        if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
          const screenX = e.clientX - rect.left;
          const screenY = e.clientY - rect.top;
          const scale = this.viewport.getScale();
          this.textLayer.handlePointerMove(pageIndex, screenX / scale, screenY / scale);
          break;
        }
      }
      return;
    }

    // Handle creation drag — update live SVG preview
    if (this.creationState) {
      const container = this.overlayContainers.get(this.creationState.pageIndex);
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const { startScreenX: sx, startScreenY: sy, pathEl, tool } = this.creationState;
      this.creationState.lastX = x;
      this.creationState.lastY = y;

      if (pathEl) {
        let cx = x, cy = y;

        switch (tool) {
          case "ink":
            if (this.creationState.inkPoints) {
              this.creationState.inkPoints.push([x, y]);
              const d = pathEl.getAttribute("d") || "";
              pathEl.setAttribute("d", d + `L${x},${y}`);
            }
            break;
          case "line":
            if (e.shiftKey) {
              // Snap to nearest 45-degree angle
              const dx = x - sx, dy = y - sy;
              const angle = Math.atan2(dy, dx);
              const snapped = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
              const dist = Math.sqrt(dx * dx + dy * dy);
              cx = sx + Math.cos(snapped) * dist;
              cy = sy + Math.sin(snapped) * dist;
            }
            pathEl.setAttribute("x2", String(cx));
            pathEl.setAttribute("y2", String(cy));
            this.creationState.lastX = cx;
            this.creationState.lastY = cy;
            break;
          case "circle":
            if (e.shiftKey) {
              // Perfect circle: use max dimension for both axes
              const size = Math.max(Math.abs(x - sx), Math.abs(y - sy));
              cx = sx + size * Math.sign(x - sx);
              cy = sy + size * Math.sign(y - sy);
            }
            pathEl.setAttribute("cx", String((sx + cx) / 2));
            pathEl.setAttribute("cy", String((sy + cy) / 2));
            pathEl.setAttribute("rx", String(Math.abs(cx - sx) / 2));
            pathEl.setAttribute("ry", String(Math.abs(cy - sy) / 2));
            this.creationState.lastX = cx;
            this.creationState.lastY = cy;
            break;
          default: {
            // rectangle, freetext, highlight
            let w = Math.abs(x - sx), h = Math.abs(y - sy);
            if (e.shiftKey && tool === "rectangle") {
              // Perfect square
              const size = Math.max(w, h);
              w = size; h = size;
            }
            const rx = x < sx ? sx - w : sx;
            const ry = y < sy ? sy - h : sy;
            pathEl.setAttribute("x", String(rx));
            pathEl.setAttribute("y", String(ry));
            pathEl.setAttribute("width", String(w));
            pathEl.setAttribute("height", String(h));
            this.creationState.lastX = x < sx ? sx - w : sx + w;
            this.creationState.lastY = y < sy ? sy - h : sy + h;
            break;
          }
        }
      }
      return;
    }

    if (!this.dragState) return;

    const { annotId, startScreenX, startScreenY, originalLeft, originalTop, originalWidth, originalHeight, handle } = this.dragState;
    const el = this.overlayElements.get(annotId);
    if (!el) return;

    let dx = e.clientX - startScreenX;
    let dy = e.clientY - startScreenY;

    if (handle === null) {
      // Shift: constrain to horizontal or vertical axis
      if (e.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      el.style.left = `${originalLeft + dx}px`;
      el.style.top = `${originalTop + dy}px`;
    } else {
      this.applyResize(el, handle, dx, dy, originalLeft, originalTop, originalWidth, originalHeight, e.shiftKey);
    }
  }

  private async onPointerUp(e: PointerEvent): Promise<void> {
    if (this.currentTool === "textedit" && this.textLayer) {
      this.textLayer.handlePointerUp();
      return;
    }

    if (this.creationState) {
      await this.finishCreation();
      return;
    }

    if (!this.dragState) return;

    const { annotId, startScreenX, startScreenY, handle, originalAnnotRect, originalQuadPoints } = this.dragState;
    const dx = e.clientX - startScreenX;
    const dy = e.clientY - startScreenY;
    this.dragState = null;

    // Skip if no movement
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;

    const scale = this.viewport.getScale();
    const annot = this.getAnnotationForId(annotId);
    if (!annot) return;

    const pdfDx = dx / scale;
    const pdfDy = dy / scale;

    if (handle === null) {
      // Move completed
      if (QUADPOINT_TYPES.has(annot.type) && originalQuadPoints && originalQuadPoints.length > 0) {
        // Shift all quad points
        const newQuads = originalQuadPoints.map(q => {
          const shifted = [...q];
          for (let i = 0; i < shifted.length; i += 2) {
            shifted[i] += pdfDx;
            shifted[i + 1] += pdfDy;
          }
          return shifted;
        });

        if (this.undoManager) {
          this.undoManager.push({ annotId, property: "quadPoints", previousValue: originalQuadPoints, newValue: newQuads });
        }
        await this.moveQuadPoints(annotId, newQuads);
      } else {
        const newRect: [number, number, number, number] = [
          originalAnnotRect[0] + pdfDx,
          originalAnnotRect[1] + pdfDy,
          originalAnnotRect[2] + pdfDx,
          originalAnnotRect[3] + pdfDy,
        ];

        if (this.undoManager) {
          this.undoManager.push({ annotId, property: "rect", previousValue: originalAnnotRect, newValue: newRect });
        }
        await this.moveAnnot(annotId, newRect);
      }
    } else {
      // Resize completed — compute new rect from handle direction
      const newRect = this.computeResizedRect(handle, pdfDx, pdfDy, originalAnnotRect);

      if (this.undoManager) {
        this.undoManager.push({ annotId, property: "rect", previousValue: originalAnnotRect, newValue: newRect });
      }
      await this.moveAnnot(annotId, newRect);
    }

    // Re-render page and refresh overlays
    await this.viewport.rerenderPage(annot.page);

    // Notify selection listeners so properties panel updates
    const updated = this.getSelectedAnnotation();
    if (updated) {
      for (const listener of this.selectionListeners) {
        listener(updated);
      }
    }
  }

  private applyResize(
    el: HTMLDivElement, handle: string, dx: number, dy: number,
    origLeft: number, origTop: number, origWidth: number, origHeight: number,
    shiftKey = false
  ): void {
    let newLeft = origLeft, newTop = origTop, newWidth = origWidth, newHeight = origHeight;

    if (handle.includes("w")) { newLeft = origLeft + dx; newWidth = origWidth - dx; }
    if (handle.includes("e")) { newWidth = origWidth + dx; }
    if (handle.includes("n")) { newTop = origTop + dy; newHeight = origHeight - dy; }
    if (handle.includes("s")) { newHeight = origHeight + dy; }

    // Shift: maintain aspect ratio
    if (shiftKey && origWidth > 0 && origHeight > 0) {
      const aspect = origWidth / origHeight;
      if (handle.length === 2) {
        // Corner handle: use the larger dimension change
        if (Math.abs(newWidth - origWidth) > Math.abs(newHeight - origHeight)) {
          newHeight = newWidth / aspect;
        } else {
          newWidth = newHeight * aspect;
        }
        if (handle.includes("n")) newTop = origTop + origHeight - newHeight;
        if (handle.includes("w")) newLeft = origLeft + origWidth - newWidth;
      } else {
        // Edge handle: adjust the other dimension
        if (handle === "e" || handle === "w") newHeight = newWidth / aspect;
        else newWidth = newHeight * aspect;
      }
    }

    // Enforce minimums
    if (newWidth < 10) { newWidth = 10; if (handle.includes("w")) newLeft = origLeft + origWidth - 10; }
    if (newHeight < 10) { newHeight = 10; if (handle.includes("n")) newTop = origTop + origHeight - 10; }

    el.style.left = `${newLeft}px`;
    el.style.top = `${newTop}px`;
    el.style.width = `${newWidth}px`;
    el.style.height = `${newHeight}px`;
  }

  private computeResizedRect(
    handle: string, pdfDx: number, pdfDy: number,
    orig: [number, number, number, number]
  ): [number, number, number, number] {
    let [x1, y1, x2, y2] = orig;

    if (handle.includes("w")) x1 += pdfDx;
    if (handle.includes("e")) x2 += pdfDx;
    if (handle.includes("n")) y1 += pdfDy;
    if (handle.includes("s")) y2 += pdfDy;

    // Enforce minimum size (5pt)
    if (x2 - x1 < 5) { if (handle.includes("w")) x1 = x2 - 5; else x2 = x1 + 5; }
    if (y2 - y1 < 5) { if (handle.includes("n")) y1 = y2 - 5; else y2 = y1 + 5; }

    return [x1, y1, x2, y2];
  }

  // --- Creation ---

  private colorToCSS(c: number[]): string {
    return `rgb(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)})`;
  }

  private startCreation(pageIndex: number, e: PointerEvent): void {
    const container = this.overlayContainers.get(pageIndex);
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // For "note" tool, just place immediately on pointerdown (no drag needed)
    if (this.currentTool === "note") {
      this.createAnnotationAtPoint(pageIndex, x, y);
      return;
    }

    // Create a full-page SVG overlay for live preview rendering
    const preview = document.createElement("div");
    preview.className = "creation-preview";
    preview.style.left = "0px";
    preview.style.top = "0px";
    preview.style.width = `${container.clientWidth}px`;
    preview.style.height = `${container.clientHeight}px`;
    preview.style.border = "none";
    preview.style.background = "none";

    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.style.position = "absolute";
    svg.style.left = "0";
    svg.style.top = "0";
    svg.style.overflow = "visible";

    const strokeColor = this.colorToCSS(this.currentColor);
    const fillColor = this.currentFillColor ? this.colorToCSS(this.currentFillColor) : "none";
    const bw = this.currentBorderWidth;
    let shapeEl: SVGElement;

    switch (this.currentTool) {
      case "ink": {
        const path = document.createElementNS(NS, "path");
        path.setAttribute("d", `M${x},${y}`);
        path.setAttribute("stroke", strokeColor);
        path.setAttribute("stroke-width", String(bw));
        path.setAttribute("fill", "none");
        path.setAttribute("stroke-linecap", "round");
        path.setAttribute("stroke-linejoin", "round");
        shapeEl = path;
        break;
      }
      case "line": {
        const line = document.createElementNS(NS, "line");
        line.setAttribute("x1", String(x));
        line.setAttribute("y1", String(y));
        line.setAttribute("x2", String(x));
        line.setAttribute("y2", String(y));
        line.setAttribute("stroke", strokeColor);
        line.setAttribute("stroke-width", String(bw));
        line.setAttribute("stroke-linecap", "round");
        shapeEl = line;
        break;
      }
      case "circle": {
        const ellipse = document.createElementNS(NS, "ellipse");
        ellipse.setAttribute("cx", String(x));
        ellipse.setAttribute("cy", String(y));
        ellipse.setAttribute("rx", "0");
        ellipse.setAttribute("ry", "0");
        ellipse.setAttribute("stroke", strokeColor);
        ellipse.setAttribute("stroke-width", String(bw));
        ellipse.setAttribute("fill", fillColor);
        shapeEl = ellipse;
        break;
      }
      case "highlight": {
        const r = document.createElementNS(NS, "rect");
        r.setAttribute("x", String(x));
        r.setAttribute("y", String(y));
        r.setAttribute("width", "0");
        r.setAttribute("height", "0");
        r.setAttribute("fill", strokeColor);
        r.setAttribute("opacity", "0.35");
        shapeEl = r;
        break;
      }
      default: {
        // rectangle, freetext
        const r = document.createElementNS(NS, "rect");
        r.setAttribute("x", String(x));
        r.setAttribute("y", String(y));
        r.setAttribute("width", "0");
        r.setAttribute("height", "0");
        r.setAttribute("stroke", strokeColor);
        r.setAttribute("stroke-width", String(bw));
        r.setAttribute("fill", fillColor);
        shapeEl = r;
        break;
      }
    }

    svg.appendChild(shapeEl);
    preview.appendChild(svg);
    container.appendChild(preview);

    this.creationState = {
      tool: this.currentTool,
      pageIndex,
      startScreenX: x,
      startScreenY: y,
      lastX: x,
      lastY: y,
      previewEl: preview,
      svgEl: svg,
      pathEl: shapeEl,
      inkPoints: this.currentTool === "ink" ? [[x, y]] : undefined,
    };

    e.preventDefault();
  }

  private async createAnnotationAtPoint(pageIndex: number, screenX: number, screenY: number): Promise<void> {
    const scale = this.viewport.getScale();
    const pdf = screenToPdf(screenX, screenY, { scale, pageOffsetX: 0, pageOffsetY: 0 });

    // Sticky note: fixed 24x24 icon
    const rect: [number, number, number, number] = [pdf.x, pdf.y, pdf.x + 24, pdf.y + 24];

    const response = await this.viewport.getRpc().send({
      type: "createAnnot",
      page: pageIndex,
      annotType: "Text",
      rect,
      properties: {
        color: this.currentColor,
        icon: "Note",
        contents: "",
      } as any,
    });

    if (response.type === "annotCreated" && this.undoManager) {
      this.undoManager.push({
        annotId: response.annot.id,
        property: "create",
        previousValue: null,
        newValue: response.annot,
      });
    }

    await this.viewport.rerenderPage(pageIndex);

    if (response.type === "annotCreated") {
      this.select(response.annot.id);
    }
    this.onCreationDone?.();
  }

  private async finishCreation(): Promise<void> {
    if (!this.creationState) return;
    const { tool, pageIndex, startScreenX, startScreenY, lastX, lastY, previewEl, inkPoints } = this.creationState;
    const endX = lastX;
    const endY = lastY;
    previewEl.remove();
    this.creationState = null;

    const scale = this.viewport.getScale();
    const transform = { scale, pageOffsetX: 0, pageOffsetY: 0 };

    // Compute PDF rect from screen coords
    const p1 = screenToPdf(Math.min(startScreenX, endX), Math.min(startScreenY, endY), transform);
    const p2 = screenToPdf(Math.max(startScreenX, endX), Math.max(startScreenY, endY), transform);

    // Skip if too small (except freetext — give it a default size for click-to-create)
    if (Math.abs(p2.x - p1.x) < 3 && Math.abs(p2.y - p1.y) < 3) {
      if (tool === "freetext") {
        // Default text box: 200pt wide, 24pt tall at click point
        p2.x = p1.x + 200;
        p2.y = p1.y + 24;
      } else if (tool !== "ink") {
        return;
      }
    }

    const rect: [number, number, number, number] = [p1.x, p1.y, p2.x, p2.y];
    const annotType = TOOL_TO_ANNOT_TYPE[tool];
    if (!annotType) return;

    const properties: any = {};

    // Set sensible defaults per type
    switch (tool) {
      case "freetext":
        properties.color = []; // no border/background color (transparent)
        properties.borderWidth = 0;
        properties.defaultAppearance = { font: "Helv", size: 14, color: [0, 0, 0] };
        properties.contents = "";
        break;
      case "highlight":
        properties.color = this.currentColor;
        properties.opacity = 0.5;
        properties.quadPoints = [[p1.x, p1.y, p2.x, p1.y, p1.x, p2.y, p2.x, p2.y]];
        break;
      case "rectangle":
        properties.color = this.currentColor;
        properties.borderWidth = this.currentBorderWidth;
        if (this.currentFillColor) properties.interiorColor = this.currentFillColor;
        break;
      case "circle":
        properties.color = this.currentColor;
        properties.borderWidth = this.currentBorderWidth;
        if (this.currentFillColor) properties.interiorColor = this.currentFillColor;
        break;
      case "line": {
        properties.color = this.currentColor;
        properties.borderWidth = this.currentBorderWidth;
        // Use actual start/end points (not min/max sorted) to preserve line direction
        const lineStart = screenToPdf(startScreenX, startScreenY, transform);
        const lineEnd = screenToPdf(endX, endY, transform);
        properties.line = [[lineStart.x, lineStart.y], [lineEnd.x, lineEnd.y]];
        break;
      }
      case "ink":
        properties.color = this.currentColor;
        properties.borderWidth = this.currentBorderWidth;
        if (inkPoints && inkPoints.length > 1) {
          // Convert screen ink points to PDF coords
          const pdfPoints = inkPoints.map(([sx, sy]) => {
            const p = screenToPdf(sx, sy, transform);
            return [p.x, p.y] as [number, number];
          });
          properties.inkList = [pdfPoints];
        }
        break;
    }

    const response = await this.viewport.getRpc().send({
      type: "createAnnot",
      page: pageIndex,
      annotType,
      rect,
      properties,
    });

    if (response.type === "annotCreated" && this.undoManager) {
      this.undoManager.push({
        annotId: response.annot.id,
        property: "create",
        previousValue: null,
        newValue: response.annot,
      });
    }

    await this.viewport.rerenderPage(pageIndex);

    if (response.type === "annotCreated") {
      this.select(response.annot.id);

      // For FreeText, immediately start inline editing
      if (tool === "freetext") {
        // Wait for overlays to rebuild after rerender
        requestAnimationFrame(() => {
          this.startInlineEdit(response.annot.id);
        });
        return; // Don't switch to select tool yet
      }
    }
    this.onCreationDone?.();
  }

  /** Start inline text editing on a FreeText annotation overlay */
  startInlineEdit(annotId: string): void {
    this.cancelInlineEdit();

    const overlay = this.overlayElements.get(annotId);
    const annot = this.getAnnotationForId(annotId);
    if (!overlay || !annot || annot.type !== "FreeText") return;

    const editEl = document.createElement("div");
    editEl.className = "freetext-inline-edit";
    editEl.contentEditable = "true";
    editEl.style.position = "absolute";
    editEl.style.left = "0";
    editEl.style.top = "0";
    editEl.style.width = "100%";
    editEl.style.height = "100%";
    editEl.style.outline = "none";
    editEl.style.cursor = "text";
    editEl.style.overflow = "hidden";
    editEl.style.padding = "2px 4px";
    editEl.style.boxSizing = "border-box";
    editEl.style.color = "black";
    editEl.style.zIndex = "30";

    // Apply font from defaultAppearance
    if (annot.defaultAppearance) {
      const da = annot.defaultAppearance;
      const scale = this.viewport.getScale();
      editEl.style.fontSize = `${da.size * scale}px`;
      const fontMap: Record<string, string> = { Helv: "sans-serif", TiRo: "serif", Cour: "monospace" };
      editEl.style.fontFamily = fontMap[da.font] || "sans-serif";
      if (da.color && da.color.length >= 3) {
        editEl.style.color = `rgb(${Math.round(da.color[0] * 255)}, ${Math.round(da.color[1] * 255)}, ${Math.round(da.color[2] * 255)})`;
      }
    }

    if (annot.contents) editEl.textContent = annot.contents;

    overlay.style.overflow = "visible";
    overlay.appendChild(editEl);

    const commitEdit = async () => {
      const text = editEl.textContent || "";
      cleanup();
      if (text !== (annot.contents || "")) {
        // Save contents directly via RPC
        if (this.undoManager) {
          this.undoManager.push({ annotId, property: "contents", previousValue: annot.contents, newValue: text });
        }
        await this.viewport.getRpc().send({ type: "setAnnotContents", annotId, text });
        const pageIndex = parseInt(annotId.split("-")[0]);
        await this.viewport.rerenderPage(pageIndex);
      }
      this.onCreationDone?.();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        commitEdit();
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        commitEdit();
      }
      e.stopPropagation(); // Prevent tool shortcuts while typing
    };

    const cleanup = () => {
      editEl.removeEventListener("keydown", onKeyDown);
      editEl.remove();
      this.activeInlineEdit = null;
    };

    editEl.addEventListener("keydown", onKeyDown);

    this.activeInlineEdit = { annotId, el: editEl, cleanup };

    // Focus after appending
    requestAnimationFrame(() => editEl.focus());
  }

  async cancelInlineEdit(): Promise<void> {
    if (!this.activeInlineEdit) return;
    const { annotId, el } = this.activeInlineEdit;
    const text = el.textContent || "";
    const annot = this.getAnnotationForId(annotId);
    el.remove();
    this.activeInlineEdit = null;

    if (annot && text !== (annot.contents || "")) {
      if (this.undoManager) {
        this.undoManager.push({ annotId, property: "contents", previousValue: annot.contents, newValue: text });
      }
      await this.viewport.getRpc().send({ type: "setAnnotContents", annotId, text });
      const pageIndex = parseInt(annotId.split("-")[0]);
      await this.viewport.rerenderPage(pageIndex);
    }
    this.onCreationDone?.();
  }

  // --- Overlay rendering ---

  private rebuildAllOverlayContainers(): void {
    for (const [, container] of this.overlayContainers) container.remove();
    this.overlayContainers.clear();
    this.overlayElements.clear();

    for (const page of this.viewport.getPages()) this.ensureOverlayContainer(page.index);

    for (const page of this.viewport.getPages()) {
      const annots = this.viewport.getAnnotations(page.index);
      if (annots.length > 0) this.renderOverlaysForPage(page.index, annots);
    }
  }

  private ensureOverlayContainer(pageIndex: number): HTMLDivElement {
    let container = this.overlayContainers.get(pageIndex);
    if (!container) {
      container = document.createElement("div");
      container.className = "annotation-overlay-container";
      container.dataset.page = String(pageIndex);

      const containerEl = container;
      containerEl.addEventListener("pointerdown", (e) => {
        if (e.target === containerEl || (e.target as HTMLElement).classList.contains("text-highlight-container")) {
          if (this.currentTool === "textedit" && this.textLayer) {
            const rect = containerEl.getBoundingClientRect();
            const screenX = e.clientX - rect.left;
            const screenY = e.clientY - rect.top;
            const scale = this.viewport.getScale();
            const pdfX = screenX / scale;
            const pdfY = screenY / scale;
            this.textLayer.handlePointerDown(pageIndex, pdfX, pdfY, e);
            e.preventDefault();
          } else if (this.currentTool !== "select" && this.currentTool !== "textedit") {
            this.startCreation(pageIndex, e);
          } else {
            this.select(null);
          }
        }
      });

      const pageWrapper = this.viewport.getPageContainer(pageIndex);
      if (pageWrapper) pageWrapper.appendChild(container);
      this.overlayContainers.set(pageIndex, container);
    }
    return container;
  }

  private renderOverlaysForPage(pageIndex: number, annotations: AnnotationDTO[]): void {
    const container = this.ensureOverlayContainer(pageIndex);

    const oldIds = new Set<string>();
    for (const [id, el] of this.overlayElements) {
      if (el.parentElement === container) oldIds.add(id);
    }
    for (const id of oldIds) {
      this.overlayElements.get(id)?.remove();
      this.overlayElements.delete(id);
    }

    for (const annot of annotations) {
      if (annot.type === "Popup") continue;
      const overlay = this.createOverlay(annot);
      if (overlay) {
        container.appendChild(overlay);
        this.overlayElements.set(annot.id, overlay);
        if (annot.id === this.selectedId) {
          overlay.classList.add("selected");
          this.addHandles(overlay);
        }
      }
    }
  }

  private renderWidgetOverlaysForPage(pageIndex: number, widgets: WidgetDTO[]): void {
    const container = this.ensureOverlayContainer(pageIndex);
    const scale = this.viewport.getScale();

    // Remove old widget overlays for this page
    const oldIds = new Set<string>();
    for (const [id, el] of this.overlayElements) {
      if (el.parentElement === container && id.startsWith("w")) oldIds.add(id);
    }
    for (const id of oldIds) {
      this.overlayElements.get(id)?.remove();
      this.overlayElements.delete(id);
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
        e.stopPropagation();
        this.select(widget.id);
        if (!(e.target as HTMLElement).classList.contains("resize-handle")) {
          this.startDrag(widget.id, e, null);
        }
      });

      container.appendChild(div);
      this.overlayElements.set(widget.id, div);

      if (widget.id === this.selectedId) {
        div.classList.add("selected");
        this.addHandles(div);
      }
    }
  }

  private createOverlay(annot: AnnotationDTO): HTMLDivElement | null {
    const scale = this.viewport.getScale();

    if (QUADPOINT_TYPES.has(annot.type) && annot.quadPoints && annot.quadPoints.length > 0) {
      return this.createQuadPointOverlay(annot, scale);
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
      // Store color as data attribute for selected state; don't set inline borderColor
      // (the annotation's visual appearance is rendered by MuPDF in the page bitmap)
      if (annot.color && annot.color.length >= 3 && isFinite(annot.color[0])) {
        const [r, g, b] = annot.color;
        div.dataset.borderColor = `rgba(${r * 255}, ${g * 255}, ${b * 255}, 1)`;
      }
    }

    div.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      // Don't start drag if we're inline editing this annotation
      if (this.activeInlineEdit?.annotId === annot.id && (e.target as HTMLElement).classList.contains("freetext-inline-edit")) return;
      this.select(annot.id);
      // Start drag (move)
      if (!(e.target as HTMLElement).classList.contains("resize-handle")) {
        this.startDrag(annot.id, e, null);
      }
    });

    // Double-click to inline edit FreeText
    if (annot.type === "FreeText") {
      div.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        this.startInlineEdit(annot.id);
      });
    }

    // Double-click sticky note to focus comment textarea in properties panel
    if (annot.type === "Text") {
      div.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        // Trigger selection listeners so properties panel shows, then focus textarea
        for (const listener of this.selectionListeners) listener(annot);
        requestAnimationFrame(() => {
          const textarea = document.querySelector<HTMLTextAreaElement>('[data-prop="contents"]');
          if (textarea) textarea.focus();
        });
      });
    }

    return div;
  }

  private createQuadPointOverlay(annot: AnnotationDTO, scale: number): HTMLDivElement {
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
      e.stopPropagation();
      this.select(annot.id);
      this.startDrag(annot.id, e, null);
    });

    return div;
  }

  private updateAllOverlayPositions(): void {
    const scale = this.viewport.getScale();
    for (const page of this.viewport.getPages()) {
      const annots = this.viewport.getAnnotations(page.index);
      for (const annot of annots) {
        const el = this.overlayElements.get(annot.id);
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

        if (annot.id === this.selectedId) {
          this.removeHandles(el);
          this.addHandles(el);
        }
      }
    }
  }

  private addHandles(el: HTMLDivElement): void {
    const annot = this.getAnnotationForElement(el);
    if (annot && (ICON_TYPES.has(annot.type) || QUADPOINT_TYPES.has(annot.type))) return;

    for (const pos of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
      const handle = document.createElement("div");
      handle.className = `resize-handle handle-${pos}`;
      handle.dataset.handle = pos;
      handle.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        const annotId = el.dataset.annotId;
        if (annotId) this.startDrag(annotId, e, pos);
      });
      el.appendChild(handle);
    }
  }

  private removeHandles(el: HTMLDivElement): void {
    el.querySelectorAll(".resize-handle").forEach((h) => h.remove());
  }

  private getAnnotationForElement(el: HTMLDivElement): AnnotationDTO | null {
    return el.dataset.annotId ? this.getAnnotationForId(el.dataset.annotId) : null;
  }

  private getAnnotationForId(id: string): AnnotationDTO | null {
    for (const page of this.viewport.getPages()) {
      const annots = this.viewport.getAnnotations(page.index);
      const found = annots.find((a) => a.id === id);
      if (found) return found;

      // Also check widgets
      const widgets = this.viewport.getWidgets(page.index);
      const widget = widgets.find((w) => w.id === id);
      if (widget) {
        // Return a synthetic AnnotationDTO for the widget
        return {
          id: widget.id,
          page: widget.page,
          type: "Widget",
          rect: widget.rect,
          color: [],
          opacity: 1,
          contents: "",
          borderWidth: 1,
          hasRect: true,
        };
      }
    }
    return null;
  }
}
