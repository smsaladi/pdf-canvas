// Find/Replace search bar

import type { WorkerRPC } from "./worker-rpc";
import type { Viewport } from "./viewport";
import type { TextSearchResult } from "./types";
import { pdfRectToScreenRect } from "./coords";

export type ReplaceHandler = (page: number, oldText: string, newText: string) => Promise<void>;

export class SearchBar {
  private container: HTMLElement;
  private rpc: WorkerRPC;
  private viewport: Viewport;
  private replaceHandler: ReplaceHandler | null = null;

  private searchInput!: HTMLInputElement;
  private replaceInput!: HTMLInputElement;
  private matchDisplay!: HTMLSpanElement;
  private replaceSection!: HTMLDivElement;

  private results: TextSearchResult[] = [];
  private currentIndex = -1;
  private highlightElements: HTMLDivElement[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private visible = false;

  constructor(container: HTMLElement, rpc: WorkerRPC, viewport: Viewport) {
    this.container = container;
    this.rpc = rpc;
    this.viewport = viewport;
    this.buildUI();
  }

  onReplace(handler: ReplaceHandler): void {
    this.replaceHandler = handler;
  }

  show(): void {
    this.visible = true;
    this.container.style.display = "flex";
    this.searchInput.focus();
    this.searchInput.select();
  }

  hide(): void {
    this.visible = false;
    this.container.style.display = "none";
    this.clearHighlights();
    this.results = [];
    this.currentIndex = -1;
    this.updateMatchDisplay();
  }

  isVisible(): boolean {
    return this.visible;
  }

  private buildUI(): void {
    this.container.className = "search-bar";
    this.container.style.display = "none";

    // Search row
    const searchRow = document.createElement("div");
    searchRow.className = "search-row";

    this.searchInput = document.createElement("input");
    this.searchInput.type = "text";
    this.searchInput.className = "search-input";
    this.searchInput.placeholder = "Find in document...";
    this.searchInput.addEventListener("input", () => this.onSearchInput());
    this.searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.shiftKey) { this.prev(); e.preventDefault(); }
      else if (e.key === "Enter") { this.next(); e.preventDefault(); }
      else if (e.key === "Escape") { this.hide(); e.preventDefault(); }
    });
    searchRow.appendChild(this.searchInput);

    const prevBtn = document.createElement("button");
    prevBtn.className = "search-btn";
    prevBtn.textContent = "▲";
    prevBtn.title = "Previous (Shift+Enter)";
    prevBtn.addEventListener("click", () => this.prev());
    searchRow.appendChild(prevBtn);

    const nextBtn = document.createElement("button");
    nextBtn.className = "search-btn";
    nextBtn.textContent = "▼";
    nextBtn.title = "Next (Enter)";
    nextBtn.addEventListener("click", () => this.next());
    searchRow.appendChild(nextBtn);

    this.matchDisplay = document.createElement("span");
    this.matchDisplay.className = "search-match-count";
    searchRow.appendChild(this.matchDisplay);

    const toggleReplace = document.createElement("button");
    toggleReplace.className = "search-btn";
    toggleReplace.textContent = "⇄";
    toggleReplace.title = "Toggle Replace";
    toggleReplace.addEventListener("click", () => {
      this.replaceSection.style.display =
        this.replaceSection.style.display === "none" ? "flex" : "none";
    });
    searchRow.appendChild(toggleReplace);

    const closeBtn = document.createElement("button");
    closeBtn.className = "search-btn search-close";
    closeBtn.textContent = "✕";
    closeBtn.title = "Close (Escape)";
    closeBtn.addEventListener("click", () => this.hide());
    searchRow.appendChild(closeBtn);

    this.container.appendChild(searchRow);

    // Replace row
    this.replaceSection = document.createElement("div");
    this.replaceSection.className = "search-row";
    this.replaceSection.style.display = "none";

    this.replaceInput = document.createElement("input");
    this.replaceInput.type = "text";
    this.replaceInput.className = "search-input";
    this.replaceInput.placeholder = "Replace with...";
    this.replaceSection.appendChild(this.replaceInput);

    const replaceBtn = document.createElement("button");
    replaceBtn.className = "search-btn";
    replaceBtn.textContent = "Replace";
    replaceBtn.addEventListener("click", () => this.replaceCurrent());
    this.replaceSection.appendChild(replaceBtn);

    const replaceAllBtn = document.createElement("button");
    replaceAllBtn.className = "search-btn";
    replaceAllBtn.textContent = "All";
    replaceAllBtn.title = "Replace All";
    replaceAllBtn.addEventListener("click", () => this.replaceAll());
    this.replaceSection.appendChild(replaceAllBtn);

    this.container.appendChild(this.replaceSection);
  }

  private async onSearchInput(): Promise<void> {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.performSearch(), 200);
  }

  private async performSearch(): Promise<void> {
    const needle = this.searchInput.value.trim();
    if (!needle) {
      this.results = [];
      this.currentIndex = -1;
      this.clearHighlights();
      this.updateMatchDisplay();
      return;
    }

    const response = await this.rpc.send({ type: "searchText", needle });
    if (response.type === "searchResults") {
      this.results = response.results;
      this.currentIndex = this.results.length > 0 ? 0 : -1;
      this.renderHighlights();
      this.updateMatchDisplay();
      if (this.currentIndex >= 0) this.scrollToMatch(this.currentIndex);
    }
  }

  private next(): void {
    if (this.results.length === 0) return;
    this.currentIndex = (this.currentIndex + 1) % this.results.length;
    this.updateHighlightCurrent();
    this.updateMatchDisplay();
    this.scrollToMatch(this.currentIndex);
  }

  private prev(): void {
    if (this.results.length === 0) return;
    this.currentIndex = (this.currentIndex - 1 + this.results.length) % this.results.length;
    this.updateHighlightCurrent();
    this.updateMatchDisplay();
    this.scrollToMatch(this.currentIndex);
  }

  private async replaceCurrent(): Promise<void> {
    if (this.currentIndex < 0 || !this.replaceHandler) return;
    const match = this.results[this.currentIndex];
    const newText = this.replaceInput.value;
    await this.replaceHandler(match.page, match.text, newText);
    // Re-search to update results
    await this.performSearch();
  }

  private async replaceAll(): Promise<void> {
    if (this.results.length === 0 || !this.replaceHandler) return;
    const needle = this.searchInput.value.trim();
    const newText = this.replaceInput.value;

    // Group by page and process
    const pages = new Set(this.results.map(r => r.page));
    for (const page of pages) {
      await this.replaceHandler(page, needle, newText);
    }

    // Re-search
    await this.performSearch();
  }

  private renderHighlights(): void {
    this.clearHighlights();
    const scale = this.viewport.getScale();

    for (let i = 0; i < this.results.length; i++) {
      const match = this.results[i];
      const container = this.viewport.getPageContainer(match.page);
      if (!container) continue;

      // Get or create search highlight container
      let hlContainer = container.querySelector(".search-highlight-container") as HTMLDivElement;
      if (!hlContainer) {
        hlContainer = document.createElement("div");
        hlContainer.className = "search-highlight-container";
        container.appendChild(hlContainer);
      }

      for (const quad of match.quads) {
        // Each quad is 8 numbers: [ulx, uly, urx, ury, llx, lly, lrx, lry]
        const q = quad as unknown as number[];
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let j = 0; j < q.length; j += 2) {
          minX = Math.min(minX, q[j]);
          minY = Math.min(minY, q[j + 1]);
          maxX = Math.max(maxX, q[j]);
          maxY = Math.max(maxY, q[j + 1]);
        }

        const screen = pdfRectToScreenRect(
          [minX, minY, maxX, maxY],
          { scale, pageOffsetX: 0, pageOffsetY: 0 }
        );

        const div = document.createElement("div");
        div.className = `search-highlight${i === this.currentIndex ? " current" : ""}`;
        div.dataset.matchIndex = String(i);
        div.style.left = `${screen.x}px`;
        div.style.top = `${screen.y}px`;
        div.style.width = `${screen.width}px`;
        div.style.height = `${screen.height}px`;
        hlContainer.appendChild(div);
        this.highlightElements.push(div);
      }
    }
  }

  private updateHighlightCurrent(): void {
    for (const el of this.highlightElements) {
      const idx = parseInt(el.dataset.matchIndex || "-1");
      el.classList.toggle("current", idx === this.currentIndex);
    }
  }

  private clearHighlights(): void {
    for (const el of this.highlightElements) el.remove();
    this.highlightElements = [];
    // Also remove containers
    document.querySelectorAll(".search-highlight-container").forEach(el => {
      if (el.children.length === 0) el.remove();
    });
  }

  private updateMatchDisplay(): void {
    if (this.results.length === 0) {
      this.matchDisplay.textContent = this.searchInput.value.trim() ? "No matches" : "";
    } else {
      this.matchDisplay.textContent = `${this.currentIndex + 1} of ${this.results.length}`;
    }
  }

  private scrollToMatch(index: number): void {
    const match = this.results[index];
    if (!match) return;
    this.viewport.scrollToPage(match.page);
  }
}
