// Interaction layer: annotation overlays, selection, drag, resize
// Implementation is split across sub-modules in ./interaction/

import type { Viewport } from "./viewport";
import type { AnnotationDTO } from "./types";
import type { ToolMode } from "./toolbar";
import type { UndoManager } from "./undo";
import type { TextLayer } from "./text-layer";
import type { InteractionContext, DragState, CreationState, InlineEditState } from "./interaction/context";

// Sub-module imports
import { rebuildAllOverlayContainers, renderOverlaysForPage, renderWidgetOverlaysForPage, renderImageOverlaysForPage, updateAllOverlayPositions, addHandles, removeHandles } from "./interaction/overlay-renderer";
import { startDrag as startDragImpl, handleDragMove, handleDragEnd } from "./interaction/drag-resize";
import { startCreation as startCreationImpl, handleCreationMove, finishCreation as finishCreationImpl } from "./interaction/creation";
import { startInlineEdit as startInlineEditImpl, cancelInlineEdit as cancelInlineEditImpl } from "./interaction/inline-edit";

export type SelectionListener = (annotation: AnnotationDTO | null) => void;
export type MutationListener = (annotId: string, property: string, oldValue: any, newValue: any) => void;

export class InteractionLayer implements InteractionContext {
  viewport: Viewport;
  overlayContainers = new Map<number, HTMLDivElement>();
  overlayElements = new Map<string, HTMLDivElement>();
  selectedId: string | null = null;
  selectionListeners: SelectionListener[] = [];
  mutationListeners: MutationListener[] = [];
  dragState: DragState | null = null;
  creationState: CreationState | null = null;
  currentTool: ToolMode = "select";
  currentColor: [number, number, number] = [1, 0, 0];
  currentFillColor: [number, number, number] | null = null;
  currentBorderWidth = 2;
  undoManager: UndoManager | null = null;
  textLayer: TextLayer | null = null;
  onCreationDone: (() => void) | null = null;
  activeInlineEdit: InlineEditState | null = null;

  setColor(color: [number, number, number]): void { this.currentColor = color; }
  getColor(): [number, number, number] { return this.currentColor; }
  setFillColor(color: [number, number, number] | null): void { this.currentFillColor = color; }
  setBorderWidth(width: number): void { this.currentBorderWidth = width; }

  constructor(viewport: Viewport) {
    this.viewport = viewport;

    viewport.on((event) => {
      switch (event.type) {
        case "annotationsLoaded":
          renderOverlaysForPage(this, event.page, event.annotations);
          break;
        case "widgetsLoaded":
          renderWidgetOverlaysForPage(this, event.page, event.widgets);
          break;
        case "imagesLoaded":
          renderImageOverlaysForPage(this, event.page, event.images);
          break;
        case "pageLayoutChanged":
          rebuildAllOverlayContainers(this);
          break;
        case "zoomChanged":
          updateAllOverlayPositions(this);
          break;
      }
    });

    document.addEventListener("pointermove", (e) => this.onPointerMove(e));
    document.addEventListener("pointerup", (e) => this.onPointerUp(e));
  }

  setTool(tool: ToolMode): void {
    if (this.currentTool === "textedit" && tool !== "textedit" && this.textLayer) {
      this.textLayer.clearSelection();
    }
    this.currentTool = tool;
    for (const [, container] of this.overlayContainers) {
      container.style.cursor = tool === "hand" ? "grab" : tool === "textedit" ? "text" : tool === "select" ? "" : "crosshair";
      container.style.pointerEvents = tool === "hand" ? "none" : "";
    }
  }

  canSelect(): boolean {
    return this.currentTool === "select" || this.currentTool === "textedit";
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

    if (this.activeInlineEdit && this.activeInlineEdit.annotId !== annotId) {
      this.cancelInlineEdit();
    }

    if (this.selectedId) {
      const prev = this.overlayElements.get(this.selectedId);
      if (prev) {
        prev.classList.remove("selected");
        prev.style.cursor = "";
        removeHandles(prev);
      }
    }

    this.selectedId = annotId;

    if (annotId) {
      const el = this.overlayElements.get(annotId);
      if (el) {
        el.classList.add("selected");
        el.style.cursor = "move";
        addHandles(this, el);
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

    if (this.undoManager) {
      this.undoManager.push({
        annotId,
        property: "delete",
        previousValue: annot,
        newValue: null,
      });
    }

    this.select(null);

    if (annotId.startsWith("img")) {
      // Embedded page content image — delete via content stream manipulation
      const imageIndex = parseInt(annotId.split("-")[1]);
      await rpc.send({ type: "deleteImage", page: annot.page, imageIndex } as any);
    } else {
      await rpc.send({ type: "deleteAnnot", annotId });
    }
    await this.viewport.rerenderPage(annot.page);
  }

  async moveAnnot(annotId: string, newRect: [number, number, number, number]): Promise<void> {
    const rpc = this.viewport.getRpc();
    if (annotId.startsWith("img")) {
      // Embedded page content image — move/resize via content stream CTM
      const page = parseInt(annotId.split("-")[0].replace("img", ""));
      const imageIndex = parseInt(annotId.split("-")[1]);
      await rpc.send({ type: "moveResizeImage", page, imageIndex, newRect } as any);
    } else {
      await rpc.send({ type: "setAnnotRect", annotId, rect: newRect });
    }
  }

  async moveQuadPoints(annotId: string, newQuadPoints: number[][]): Promise<void> {
    const rpc = this.viewport.getRpc();
    await rpc.send({ type: "setAnnotQuadPoints", annotId, quadPoints: newQuadPoints });
  }

  // --- Delegated to sub-modules ---

  startDrag(annotId: string, e: PointerEvent, handle: string | null): void {
    startDragImpl(this, annotId, e, handle);
  }

  startCreation(pageIndex: number, e: PointerEvent): void {
    startCreationImpl(this, pageIndex, e);
  }

  async finishCreation(): Promise<void> {
    await finishCreationImpl(this);
  }

  startInlineEdit(annotId: string): void {
    startInlineEditImpl(this, annotId);
  }

  async cancelInlineEdit(): Promise<void> {
    await cancelInlineEditImpl(this);
  }

  private onPointerMove(e: PointerEvent): void {
    // Handle text hover/drag for textedit mode
    if (this.currentTool === "textedit" && this.textLayer) {
      for (const [pageIndex, container] of this.overlayContainers) {
        const rect = container.getBoundingClientRect();
        if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
          const screenX = e.clientX - rect.left;
          const screenY = e.clientY - rect.top;
          const scale = this.viewport.getScale();
          const pdfX = screenX / scale;
          const pdfY = screenY / scale;
          this.textLayer.handleHover(pageIndex, pdfX, pdfY);
          this.textLayer.handlePointerMove(pageIndex, pdfX, pdfY);
          break;
        }
      }
      return;
    }

    // Clear text hover when not in textedit mode
    if (this.textLayer) this.textLayer.clearHover();

    // Handle creation drag
    if (this.creationState) {
      handleCreationMove(this, e);
      return;
    }

    // Handle drag/resize
    handleDragMove(this, e);
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

    await handleDragEnd(this, e);
  }

  getAnnotationForElement(el: HTMLDivElement): AnnotationDTO | null {
    return el.dataset.annotId ? this.getAnnotationForId(el.dataset.annotId) : null;
  }

  getAnnotationForId(id: string): AnnotationDTO | null {
    for (const page of this.viewport.getPages()) {
      const annots = this.viewport.getAnnotations(page.index);
      const found = annots.find((a) => a.id === id);
      if (found) return found;

      const widgets = this.viewport.getWidgets(page.index);
      const widget = widgets.find((w) => w.id === id);
      if (widget) {
        return {
          id: widget.id, page: widget.page, type: "Widget",
          rect: widget.rect, color: [], opacity: 1, contents: "",
          borderWidth: 1, hasRect: true,
        };
      }

      const images = this.viewport.getPageImages(page.index);
      const image = images.find((img) => img.id === id);
      if (image) {
        return {
          id: image.id, page: image.page, type: "Image",
          rect: image.rect, color: [], opacity: 1,
          contents: `Image (${image.width}×${image.height})`,
          borderWidth: 0, hasRect: true,
        };
      }
    }
    return null;
  }
}
