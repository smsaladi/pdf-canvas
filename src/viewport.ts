// Viewport: continuous scroll, zoom, lazy page rendering

import { WorkerRPC } from "./worker-rpc";
import type { PageInfo, AnnotationDTO, WidgetDTO, PageTextData, PageImageDTO } from "./types";
import { clampZoom } from "./coords";

const PAGE_GAP = 16; // px between pages
const RENDER_BUFFER = 1; // extra pages above/below viewport to pre-render

export type ViewportEvent =
  | { type: "annotationsLoaded"; page: number; annotations: AnnotationDTO[] }
  | { type: "widgetsLoaded"; page: number; widgets: WidgetDTO[] }
  | { type: "textExtracted"; page: number; data: PageTextData }
  | { type: "imagesLoaded"; page: number; images: PageImageDTO[] }
  | { type: "zoomChanged"; scale: number }
  | { type: "pageLayoutChanged" }
  | { type: "pageRerendered"; page: number };

type ViewportListener = (event: ViewportEvent) => void;

export class Viewport {
  private container: HTMLElement;
  private scrollArea: HTMLElement;
  private rpc: WorkerRPC;
  private pages: PageInfo[] = [];
  private scale = 1.5; // default ~108 DPI
  private pageCanvases: Map<number, HTMLCanvasElement> = new Map();
  private pageContainers: Map<number, HTMLDivElement> = new Map();
  private pendingRenders = new Set<number>();
  private renderedAtScale = new Map<number, number>();
  private annotationCache = new Map<number, AnnotationDTO[]>();
  private widgetCache = new Map<number, WidgetDTO[]>();
  private imageCache = new Map<number, PageImageDTO[]>();
  private textCache = new Map<number, PageTextData>();
  private pendingAnnotFetches = new Set<number>();
  private zoomDisplay: HTMLElement | null = null;
  private rafId: number | null = null;
  private listeners: ViewportListener[] = [];

  constructor(container: HTMLElement, rpc: WorkerRPC) {
    this.container = container;
    this.rpc = rpc;

    this.scrollArea = document.createElement("div");
    this.scrollArea.className = "viewport-scroll-area";
    this.container.appendChild(this.scrollArea);

    this.container.addEventListener("scroll", () => this.onScroll());

    // Ctrl+wheel zoom
    this.container.addEventListener(
      "wheel",
      (e) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          const delta = e.deltaY > 0 ? -0.1 : 0.1;
          this.setZoom(this.scale + delta);
        }
      },
      { passive: false }
    );

    // Pinch-zoom for touch devices
    this.setupPinchZoom();
  }

  private setupPinchZoom(): void {
    let initialDistance = 0;
    let initialZoom = 1;

    this.container.addEventListener("touchstart", (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const t1 = e.touches[0], t2 = e.touches[1];
        initialDistance = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
        initialZoom = this.scale;
      }
    }, { passive: false });

    this.container.addEventListener("touchmove", (e) => {
      if (e.touches.length === 2 && initialDistance > 0) {
        e.preventDefault();
        const t1 = e.touches[0], t2 = e.touches[1];
        const currentDistance = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
        const factor = currentDistance / initialDistance;
        this.setZoom(initialZoom * factor);
      }
    }, { passive: false });

    this.container.addEventListener("touchend", () => {
      initialDistance = 0;
    });
  }

  on(listener: ViewportListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(event: ViewportEvent) {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  setZoomDisplay(el: HTMLElement) {
    this.zoomDisplay = el;
    this.updateZoomDisplay();
  }

  getScale(): number {
    return this.scale;
  }

  getPages(): PageInfo[] {
    return this.pages;
  }

  /** Update pages array (after page delete/insert/reorder) and rebuild layout */
  setPages(pages: PageInfo[]): void {
    this.pages = pages;
    this.renderedAtScale.clear();
    this.annotationCache.clear();
    this.buildPageLayout();
    this.scheduleRender();
  }

  getRpc(): WorkerRPC {
    return this.rpc;
  }

  getPageContainer(pageIndex: number): HTMLDivElement | undefined {
    return this.pageContainers.get(pageIndex);
  }

  getAnnotations(pageIndex: number): AnnotationDTO[] {
    return this.annotationCache.get(pageIndex) || [];
  }

  getWidgets(pageIndex: number): WidgetDTO[] {
    return this.widgetCache.get(pageIndex) || [];
  }

  getPageImages(pageIndex: number): PageImageDTO[] {
    return this.imageCache.get(pageIndex) || [];
  }

  getTextData(pageIndex: number): PageTextData | null {
    return this.textCache.get(pageIndex) || null;
  }

  async extractText(pageIndex: number): Promise<PageTextData | null> {
    const response = await this.rpc.send({ type: "extractText", page: pageIndex });
    if (response.type === "textExtracted") {
      this.textCache.set(pageIndex, response.data);
      this.emit({ type: "textExtracted", page: pageIndex, data: response.data });
      return response.data;
    }
    return null;
  }

  clearTextCache(pageIndex?: number): void {
    if (pageIndex !== undefined) {
      this.textCache.delete(pageIndex);
    } else {
      this.textCache.clear();
    }
  }

  async openDocument(buffer: ArrayBuffer): Promise<void> {
    const response = await this.rpc.send(
      { type: "open", data: buffer },
      [buffer]
    );
    if (response.type === "opened") {
      this.handleOpenResponse(response);
    }
  }

  handleOpenResponse(response: { pages: PageInfo[] }): void {
    this.pages = response.pages;
    this.annotationCache.clear();
    this.buildPageLayout();
    this.scheduleRender();
  }

  setZoom(newScale: number): void {
    const clamped = clampZoom(newScale);
    if (clamped === this.scale) return;

    const scrollFraction =
      this.scrollArea.scrollHeight > 0
        ? this.container.scrollTop / this.scrollArea.scrollHeight
        : 0;

    this.scale = clamped;
    this.renderedAtScale.clear();
    this.buildPageLayout();
    this.updateZoomDisplay();

    this.container.scrollTop = scrollFraction * this.scrollArea.scrollHeight;
    this.emit({ type: "zoomChanged", scale: this.scale });
    this.scheduleRender();
  }

  getZoom(): number {
    return this.scale;
  }

  fitToWidth(): void {
    if (this.pages.length === 0) return;
    // Use the current page's width, or first page
    const curPage = this.pages[this.getCurrentPage()] || this.pages[0];
    const availWidth = this.container.clientWidth - 32; // 16px padding each side
    const newScale = availWidth / curPage.width;
    this.setZoom(newScale);
  }

  fitToHeight(): void {
    if (this.pages.length === 0) return;
    const curPage = this.pages[this.getCurrentPage()] || this.pages[0];
    const availHeight = this.container.clientHeight - 32;
    const newScale = availHeight / curPage.height;
    this.setZoom(newScale);
  }

  /** Update a page's info (e.g. after rotation changes dimensions) */
  updatePageInfo(pageIndex: number, info: PageInfo): void {
    const idx = this.pages.findIndex(p => p.index === pageIndex);
    if (idx >= 0) this.pages[idx] = info;
    this.renderedAtScale.delete(pageIndex);
    this.buildPageLayout();
    this.scheduleRender();
  }

  scrollToPage(pageIndex: number): void {
    const container = this.pageContainers.get(pageIndex);
    if (container) {
      container.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  getCurrentPage(): number {
    const scrollTop = this.container.scrollTop;
    const containerMid = scrollTop + this.container.clientHeight / 2;
    let bestPage = 0;
    let bestDist = Infinity;

    for (const [i, div] of this.pageContainers) {
      const divMid = div.offsetTop + div.offsetHeight / 2;
      const dist = Math.abs(divMid - containerMid);
      if (dist < bestDist) {
        bestDist = dist;
        bestPage = i;
      }
    }
    return bestPage;
  }

  /** Re-fetch annotations for a specific page (after mutation) */
  async refreshAnnotations(pageIndex: number): Promise<AnnotationDTO[]> {
    const response = await this.rpc.send({ type: "getAnnotations", page: pageIndex });
    if (response.type === "annotations") {
      this.annotationCache.set(pageIndex, response.annots);
      this.emit({ type: "annotationsLoaded", page: pageIndex, annotations: response.annots });
    }

    // Also refresh widgets
    const wResponse = await this.rpc.send({ type: "getWidgets", page: pageIndex });
    if (wResponse.type === "widgets") {
      this.widgetCache.set(pageIndex, wResponse.widgets);
      this.emit({ type: "widgetsLoaded", page: pageIndex, widgets: wResponse.widgets });
    }

    // Also refresh page content images
    try {
      const iResponse = await this.rpc.send({ type: "getPageImages", page: pageIndex });
      if ((iResponse as any).type === "pageImages") {
        this.imageCache.set(pageIndex, (iResponse as any).images);
        this.emit({ type: "imagesLoaded", page: pageIndex, images: (iResponse as any).images });
      }
    } catch {}

    return this.annotationCache.get(pageIndex) || [];
  }

  /** Re-render a specific page (after annotation mutation) */
  async rerenderPage(pageIndex: number): Promise<void> {
    this.renderedAtScale.delete(pageIndex);
    this.pendingAnnotFetches.delete(pageIndex);
    await this.renderPage(pageIndex);
    // Also ensure annotations are refreshed and overlays rebuilt
    await this.refreshAnnotations(pageIndex);
    this.emit({ type: "pageRerendered", page: pageIndex });
  }

  private buildPageLayout(): void {
    this.scrollArea.innerHTML = "";
    this.pageCanvases.clear();
    this.pageContainers.clear();

    const dpr = window.devicePixelRatio || 1;
    for (const page of this.pages) {
      const w = Math.round(page.width * this.scale);
      const h = Math.round(page.height * this.scale);

      const wrapper = document.createElement("div");
      wrapper.className = "page-wrapper";
      wrapper.style.width = `${w}px`;
      wrapper.style.height = `${h}px`;
      wrapper.style.marginBottom = `${PAGE_GAP}px`;
      wrapper.dataset.page = String(page.index);

      const canvas = document.createElement("canvas");
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      canvas.className = "page-canvas";
      wrapper.appendChild(canvas);

      this.scrollArea.appendChild(wrapper);
      this.pageCanvases.set(page.index, canvas);
      this.pageContainers.set(page.index, wrapper);
    }

    this.emit({ type: "pageLayoutChanged" });
  }

  private updateZoomDisplay(): void {
    if (this.zoomDisplay) {
      if (this.zoomDisplay instanceof HTMLInputElement) {
        if (document.activeElement !== this.zoomDisplay) {
          this.zoomDisplay.value = `${Math.round(this.scale * 100)}%`;
        }
      } else {
        this.zoomDisplay.textContent = `${Math.round(this.scale * 100)}%`;
      }
    }
  }

  private onScroll(): void {
    this.scheduleRender();
  }

  private scheduleRender(): void {
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.renderVisiblePages();
    });
  }

  private getVisiblePageRange(): [number, number] {
    const scrollTop = this.container.scrollTop;
    const viewportHeight = this.container.clientHeight;
    const viewBottom = scrollTop + viewportHeight;

    let first = -1;
    let last = -1;

    for (const [i, div] of this.pageContainers) {
      const top = div.offsetTop;
      const bottom = top + div.offsetHeight;
      if (bottom >= scrollTop && top <= viewBottom) {
        if (first === -1) first = i;
        last = i;
      }
    }

    if (first === -1) return [0, 0];

    first = Math.max(0, first - RENDER_BUFFER);
    last = Math.min(this.pages.length - 1, last + RENDER_BUFFER);
    return [first, last];
  }

  private async renderPage(pageIndex: number): Promise<void> {
    if (this.pendingRenders.has(pageIndex)) return;
    if (this.renderedAtScale.get(pageIndex) === this.scale) return;

    this.pendingRenders.add(pageIndex);
    const dpr = window.devicePixelRatio || 1;
    try {
      const response = await this.rpc.send({
        type: "renderPage",
        page: pageIndex,
        scale: this.scale * dpr,
      });

      if (response.type === "pageRendered") {
        const canvas = this.pageCanvases.get(pageIndex);
        if (canvas) {
          const ctx = canvas.getContext("2d")!;
          canvas.width = response.width;
          canvas.height = response.height;
          // CSS size stays at logical pixels
          const page = this.pages[pageIndex];
          if (page) {
            canvas.style.width = `${Math.round(page.width * this.scale)}px`;
            canvas.style.height = `${Math.round(page.height * this.scale)}px`;
          }
          ctx.drawImage(response.bitmap, 0, 0);
          response.bitmap.close();
        }
        this.renderedAtScale.set(pageIndex, this.scale);
      }
    } catch (err) {
      console.error(`Failed to render page ${pageIndex}:`, err);
    } finally {
      this.pendingRenders.delete(pageIndex);
    }

    // Fetch annotations after rendering
    if (!this.pendingAnnotFetches.has(pageIndex)) {
      this.pendingAnnotFetches.add(pageIndex);
      this.refreshAnnotations(pageIndex).catch((err) => {
        console.error(`Failed to fetch annotations for page ${pageIndex}:`, err);
      });
    }
  }

  private async renderVisiblePages(): Promise<void> {
    const [first, last] = this.getVisiblePageRange();
    for (let i = first; i <= last; i++) {
      await this.renderPage(i);
    }
  }
}
