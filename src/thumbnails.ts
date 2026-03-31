// Thumbnail sidebar: page previews, multi-select, delete, drag reorder, resize

import type { Viewport } from "./viewport";
import type { WorkerRPC } from "./worker-rpc";
import type { UndoManager } from "./undo";
import type { PageInfo } from "./types";

const MIN_WIDTH = 80;
const MAX_WIDTH = 300;
const DEFAULT_WIDTH = 120;

export class ThumbnailSidebar {
  private container: HTMLElement;
  private list: HTMLElement;
  private viewport: Viewport;
  private rpc: WorkerRPC;
  private items: Map<number, { div: HTMLDivElement; canvas: HTMLCanvasElement }> = new Map();
  private activeIndex = -1;
  private rendered = new Set<number>();
  private selected = new Set<number>();
  private thumbWidth = 0; // computed from sidebar width
  private dragSrcIndex = -1;
  private dragOverIndex = -1;
  undoManager: UndoManager | null = null;

  constructor(container: HTMLElement, viewport: Viewport, rpc: WorkerRPC) {
    this.container = container;
    this.viewport = viewport;
    this.rpc = rpc;

    // Create inner list (drag handle sits outside)
    this.list = document.createElement("div");
    this.list.className = "thumb-list";
    container.appendChild(this.list);

    // Resize handle
    const handle = document.createElement("div");
    handle.className = "thumb-resize-handle";
    container.appendChild(handle);
    this.setupResize(handle);

    viewport.on((event) => {
      if (event.type === "pageLayoutChanged") {
        this.rebuild();
      } else if (event.type === "pageRerendered") {
        this.refreshPage(event.page);
      }
    });

    const viewportEl = document.getElementById("viewport")!;
    viewportEl.addEventListener("scroll", () => this.updateActivePage());

    // Keyboard: Delete selected pages, Ctrl+A select all
    document.addEventListener("keydown", (e) => {
      if (!this.container.classList.contains("open")) return;
      if (this.selected.size === 0) return;
      // Only handle if thumbnail area or no focused input
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;

      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        this.deleteSelectedPages();
      }
    });
  }

  private setupResize(handle: HTMLElement): void {
    let startX = 0, startWidth = 0;
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      startX = e.clientX;
      startWidth = this.container.offsetWidth;
      handle.setPointerCapture(e.pointerId);

      const onMove = (ev: PointerEvent) => {
        const newWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth + (ev.clientX - startX)));
        this.container.style.width = `${newWidth}px`;
        // Scale canvases dynamically via CSS (cheap, no re-render)
        const tw = Math.max(40, newWidth - 24);
        for (const [idx, item] of this.items) {
          const page = this.viewport.getPages()[idx];
          if (!page) continue;
          const aspect = page.width / page.height;
          const w = Math.min(tw, page.width);
          const h = Math.round(w / aspect);
          item.canvas.style.width = `${w}px`;
          item.canvas.style.height = `${h}px`;
        }
      };
      const onUp = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        const finalWidth = this.container.offsetWidth;
        if (finalWidth > startWidth) {
          // Only re-render if we grew (need higher res)
          this.rendered.clear();
          this.rebuild();
        } else {
          // Shrunk — current bitmaps are already high enough res, just update thumbWidth
          this.thumbWidth = Math.max(40, finalWidth - 24);
        }
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
    });
  }

  private rebuild(): void {
    const pages = this.viewport.getPages();
    if (pages.length === 0) {
      this.container.classList.remove("open");
      this.list.innerHTML = "";
      this.items.clear();
      this.rendered.clear();
      this.selected.clear();
      return;
    }

    this.container.classList.add("open");
    this.list.innerHTML = "";
    this.items.clear();
    this.rendered.clear();

    // Close button
    const closeBtn = document.createElement("button");
    closeBtn.className = "thumb-close-btn";
    closeBtn.innerHTML = "&times;";
    closeBtn.title = "Hide Thumbnails";
    closeBtn.addEventListener("click", () => {
      this.container.classList.add("hidden");
      document.getElementById("btn-toggle-thumbs")?.classList.add("visible");
    });
    this.list.appendChild(closeBtn);

    // Compute thumbnail width from container
    this.thumbWidth = Math.max(40, this.container.offsetWidth - 24);

    for (const page of pages) {
      const div = document.createElement("div");
      div.className = "thumb-item";
      div.dataset.page = String(page.index);
      div.draggable = true;

      const aspect = page.width / page.height;
      const w = Math.min(this.thumbWidth, page.width);
      const h = Math.round(w / aspect);

      const canvas = document.createElement("canvas");
      canvas.className = "thumb-canvas";
      canvas.width = w;
      canvas.height = h;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;

      const label = document.createElement("span");
      label.className = "thumb-label";
      label.textContent = String(page.index + 1);

      div.appendChild(canvas);
      div.appendChild(label);

      // Click: navigate + select
      div.addEventListener("click", (e) => {
        this.handleClick(page.index, e);
      });

      // Drag-reorder
      div.addEventListener("dragstart", (e) => {
        this.dragSrcIndex = page.index;
        div.classList.add("dragging");
        e.dataTransfer!.effectAllowed = "move";
      });
      div.addEventListener("dragend", () => {
        div.classList.remove("dragging");
        this.clearDropIndicators();
      });
      div.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer!.dropEffect = "move";
        this.showDropIndicator(page.index, e);
      });
      div.addEventListener("dragleave", () => {
        div.classList.remove("drag-above", "drag-below");
      });
      div.addEventListener("drop", (e) => {
        e.preventDefault();
        this.clearDropIndicators();
        if (this.dragSrcIndex >= 0 && this.dragSrcIndex !== page.index) {
          this.movePage(this.dragSrcIndex, page.index);
        }
        this.dragSrcIndex = -1;
      });

      // Context menu
      div.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (!this.selected.has(page.index)) {
          this.selected.clear();
          this.selected.add(page.index);
          this.updateSelectedStyles();
        }
        this.showContextMenu(e.clientX, e.clientY);
      });

      this.list.appendChild(div);
      this.items.set(page.index, { div, canvas });

      if (this.selected.has(page.index)) div.classList.add("selected");
    }

    this.updateActivePage();
    this.renderVisibleThumbnails();
    setTimeout(() => this.renderAllThumbnails(), 200);
  }

  private handleClick(pageIndex: number, e: MouseEvent): void {
    if (e.metaKey || e.ctrlKey) {
      // Toggle selection
      if (this.selected.has(pageIndex)) this.selected.delete(pageIndex);
      else this.selected.add(pageIndex);
    } else if (e.shiftKey && this.selected.size > 0) {
      // Range select
      const last = Math.max(...this.selected);
      const first = Math.min(...this.selected);
      const from = Math.min(first, pageIndex);
      const to = Math.max(last, pageIndex);
      for (let i = from; i <= to; i++) this.selected.add(i);
    } else {
      this.selected.clear();
      this.selected.add(pageIndex);
    }
    this.updateSelectedStyles();
    this.viewport.scrollToPage(pageIndex);
  }

  private updateSelectedStyles(): void {
    for (const [idx, item] of this.items) {
      item.div.classList.toggle("selected", this.selected.has(idx));
    }
  }

  private showDropIndicator(targetIndex: number, e: DragEvent): void {
    this.clearDropIndicators();
    const item = this.items.get(targetIndex);
    if (!item) return;
    const rect = item.div.getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    if (e.clientY < mid) {
      item.div.classList.add("drag-above");
      this.dragOverIndex = targetIndex;
    } else {
      item.div.classList.add("drag-below");
      this.dragOverIndex = targetIndex + 1;
    }
  }

  private clearDropIndicators(): void {
    for (const [, item] of this.items) {
      item.div.classList.remove("drag-above", "drag-below");
    }
  }

  private async movePage(from: number, to: number): Promise<void> {
    const pages = this.viewport.getPages();
    const prevOrder = pages.map(p => p.index);
    const order = [...prevOrder];
    const [moved] = order.splice(from, 1);
    const insertAt = to > from ? to - 1 : to;
    order.splice(insertAt, 0, moved);

    const response = await this.rpc.send({ type: "rearrangePages", order });
    if (response.type === "pagesUpdated") {
      // Push undo: previousValue = inverse order to restore, newValue = current order
      // To undo, we rearrange back to prevOrder
      this.undoManager?.push({
        annotId: "page-ops",
        property: "rearrangePages",
        previousValue: prevOrder,
        newValue: order,
      });
      this.viewport.setPages(response.pages);
    }
  }

  async deleteSelectedPages(): Promise<void> {
    if (this.selected.size === 0) return;
    const pages = this.viewport.getPages();
    if (this.selected.size >= pages.length) {
      alert("Cannot delete all pages.");
      return;
    }

    // Save document snapshot for undo (only way to restore deleted pages)
    const snapshot = await this.rpc.send({ type: "save", options: "compress" });
    const snapshotBuffer = snapshot.type === "saved" ? snapshot.buffer : null;

    const toDelete = [...this.selected].sort((a, b) => a - b);
    const response = await this.rpc.send({ type: "deletePages", pages: toDelete });
    if (response.type === "pagesUpdated") {
      if (snapshotBuffer) {
        this.undoManager?.push({
          annotId: "page-ops",
          property: "deletePages",
          previousValue: snapshotBuffer,
          newValue: null,
        });
      }
      this.selected.clear();
      this.viewport.setPages(response.pages);
    }
  }

  private async insertBlankAfter(pageIndex: number): Promise<void> {
    const response = await this.rpc.send({ type: "insertBlankPage", at: pageIndex + 1 });
    if (response.type === "pagesUpdated") {
      this.viewport.setPages(response.pages);
    }
  }

  private showContextMenu(x: number, y: number): void {
    // Remove any existing menu
    document.querySelector(".thumb-context-menu")?.remove();

    const menu = document.createElement("div");
    menu.className = "thumb-context-menu";
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    const count = this.selected.size;
    const pageLabel = count === 1 ? "page" : `${count} pages`;

    const items: [string, () => void][] = [
      [`Delete ${pageLabel}`, () => this.deleteSelectedPages()],
      ["Insert blank page after", () => {
        const last = Math.max(...this.selected);
        this.insertBlankAfter(last);
      }],
    ];

    for (const [label, action] of items) {
      const btn = document.createElement("button");
      btn.className = "thumb-ctx-btn";
      btn.textContent = label;
      btn.addEventListener("click", () => {
        menu.remove();
        action();
      });
      menu.appendChild(btn);
    }

    document.body.appendChild(menu);

    // Close on click outside
    const close = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        menu.remove();
        document.removeEventListener("pointerdown", close, true);
      }
    };
    setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
  }

  private updateActivePage(): void {
    const cur = this.viewport.getCurrentPage();
    if (cur === this.activeIndex) return;
    if (this.activeIndex >= 0) {
      this.items.get(this.activeIndex)?.div.classList.remove("active");
    }
    this.activeIndex = cur;
    const item = this.items.get(cur);
    if (item) {
      item.div.classList.add("active");
      item.div.scrollIntoView({ block: "nearest" });
    }
  }

  private renderVisibleThumbnails(): void {
    const pages = this.viewport.getPages();
    const count = Math.min(pages.length, 5);
    for (let i = 0; i < count; i++) this.renderThumbnail(i);
  }

  private async renderAllThumbnails(): Promise<void> {
    const pages = this.viewport.getPages();
    for (const page of pages) {
      if (!this.rendered.has(page.index)) await this.renderThumbnail(page.index);
    }
  }

  private async renderThumbnail(pageIndex: number): Promise<void> {
    if (this.rendered.has(pageIndex)) return;
    const item = this.items.get(pageIndex);
    if (!item) return;
    const page = this.viewport.getPages()[pageIndex];
    if (!page) return;

    const scale = this.thumbWidth / page.width;
    try {
      const response = await this.rpc.send({ type: "renderPage", page: pageIndex, scale });
      if (response.type === "pageRendered") {
        const ctx = item.canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(response.bitmap, 0, 0, item.canvas.width, item.canvas.height);
          response.bitmap.close();
        }
        this.rendered.add(pageIndex);
      }
    } catch {}
  }

  async refreshPage(pageIndex: number): Promise<void> {
    this.rendered.delete(pageIndex);
    await this.renderThumbnail(pageIndex);
  }
}
