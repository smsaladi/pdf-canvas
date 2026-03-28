// Text layer: text extraction cache, hit-testing, selection, inline editing

import type { Viewport } from "./viewport";
import type { PageTextData, CharInfo, TextLine, TextBlock } from "./types";
import { pdfRectToScreenRect } from "./coords";

export interface TextSelection {
  page: number;
  // Flat list of selected chars with their block/line indices for context
  chars: Array<{ block: number; line: number; charIdx: number; info: CharInfo }>;
}

export type TextEditCommitListener = (
  page: number,
  oldText: string,
  newText: string,
  selection: TextSelection
) => void;

/** Test if a point (px, py) in PDF coords lies inside a quad */
export function pointInQuad(
  px: number, py: number,
  quad: [number, number, number, number, number, number, number, number]
): boolean {
  // Quad: [ulx, uly, urx, ury, llx, lly, lrx, lry]
  // Treat as axis-aligned bounding box for simplicity (works for horizontal text)
  const minX = Math.min(quad[0], quad[2], quad[4], quad[6]);
  const maxX = Math.max(quad[0], quad[2], quad[4], quad[6]);
  const minY = Math.min(quad[1], quad[3], quad[5], quad[7]);
  const maxY = Math.max(quad[1], quad[3], quad[5], quad[7]);
  return px >= minX && px <= maxX && py >= minY && py <= maxY;
}

/** Find the character at a PDF coordinate */
export function hitTestText(
  data: PageTextData, px: number, py: number
): { block: number; line: number; charIdx: number; info: CharInfo } | null {
  for (let b = 0; b < data.blocks.length; b++) {
    const block = data.blocks[b];
    // Quick bounding box check
    if (px < block.bbox[0] || px > block.bbox[2] || py < block.bbox[1] || py > block.bbox[3]) continue;

    for (let l = 0; l < block.lines.length; l++) {
      const line = block.lines[l];
      if (line.wmode !== 0) continue; // Skip vertical text for now
      if (py < line.bbox[1] || py > line.bbox[3]) continue;

      for (let c = 0; c < line.chars.length; c++) {
        if (pointInQuad(px, py, line.chars[c].quad)) {
          return { block: b, line: l, charIdx: c, info: line.chars[c] };
        }
      }
    }
  }
  return null;
}

/** Get all chars in a line */
function getLineChars(data: PageTextData, blockIdx: number, lineIdx: number): TextSelection["chars"] {
  const line = data.blocks[blockIdx].lines[lineIdx];
  return line.chars.map((info, charIdx) => ({ block: blockIdx, line: lineIdx, charIdx, info }));
}

/** Get chars for a word around a given character (whitespace-delimited) */
function getWordChars(data: PageTextData, blockIdx: number, lineIdx: number, charIdx: number): TextSelection["chars"] {
  const line = data.blocks[blockIdx].lines[lineIdx];
  const chars = line.chars;

  // Find word boundaries
  let start = charIdx;
  while (start > 0 && chars[start - 1].c.trim() !== "") start--;
  let end = charIdx;
  while (end < chars.length - 1 && chars[end + 1].c.trim() !== "") end++;

  const result: TextSelection["chars"] = [];
  for (let i = start; i <= end; i++) {
    result.push({ block: blockIdx, line: lineIdx, charIdx: i, info: chars[i] });
  }
  return result;
}

/** Get chars between two positions (inclusive), spanning lines if needed */
function getCharRange(
  data: PageTextData,
  startBlock: number, startLine: number, startChar: number,
  endBlock: number, endLine: number, endChar: number
): TextSelection["chars"] {
  const result: TextSelection["chars"] = [];

  for (let b = startBlock; b <= endBlock; b++) {
    const block = data.blocks[b];
    const lStart = b === startBlock ? startLine : 0;
    const lEnd = b === endBlock ? endLine : block.lines.length - 1;

    for (let l = lStart; l <= lEnd; l++) {
      const line = block.lines[l];
      const cStart = (b === startBlock && l === startLine) ? startChar : 0;
      const cEnd = (b === endBlock && l === endLine) ? endChar : line.chars.length - 1;

      for (let c = cStart; c <= cEnd; c++) {
        result.push({ block: b, line: l, charIdx: c, info: line.chars[c] });
      }
    }
  }
  return result;
}

export class TextLayer {
  private viewport: Viewport;
  private highlightElements: HTMLDivElement[] = [];
  private editOverlay: HTMLDivElement | null = null;
  private currentSelection: TextSelection | null = null;
  private commitListeners: TextEditCommitListener[] = [];
  private dragStart: { block: number; line: number; charIdx: number } | null = null;
  private clickCount = 0;
  private lastClickTime = 0;

  constructor(viewport: Viewport) {
    this.viewport = viewport;
  }

  onCommit(listener: TextEditCommitListener): () => void {
    this.commitListeners.push(listener);
    return () => { this.commitListeners = this.commitListeners.filter(l => l !== listener); };
  }

  getSelection(): TextSelection | null {
    return this.currentSelection;
  }

  clearSelection(): void {
    // Commit any in-progress edit before clearing
    if (this.editOverlay) {
      this.commitEdit();
    }
    this.currentSelection = null;
    this.clearHighlights();
  }

  /** Handle pointerdown in text-edit mode */
  async handlePointerDown(pageIndex: number, pdfX: number, pdfY: number, e: PointerEvent): Promise<void> {
    // Commit any active edit before starting a new interaction
    if (this.editOverlay) {
      this.commitEdit();
    }

    // Ensure text data is extracted
    let data = this.viewport.getTextData(pageIndex);
    if (!data) {
      data = await this.viewport.extractText(pageIndex);
      if (!data) return;
    }

    const hit = hitTestText(data, pdfX, pdfY);
    if (!hit) {
      this.clearSelection();
      return;
    }

    // Track click count for double/triple click
    const now = Date.now();
    if (now - this.lastClickTime < 400) {
      this.clickCount++;
    } else {
      this.clickCount = 1;
    }
    this.lastClickTime = now;

    if (this.clickCount === 3) {
      // Triple-click: select entire line
      const chars = getLineChars(data, hit.block, hit.line);
      this.setSelection(pageIndex, chars);
      this.startEditing(pageIndex);
      return;
    }

    if (this.clickCount === 2) {
      // Double-click: select word
      const chars = getWordChars(data, hit.block, hit.line, hit.charIdx);
      this.setSelection(pageIndex, chars);
      this.startEditing(pageIndex);
      return;
    }

    // Single click: start drag selection
    this.dragStart = { block: hit.block, line: hit.line, charIdx: hit.charIdx };
    this.setSelection(pageIndex, [{ block: hit.block, line: hit.line, charIdx: hit.charIdx, info: hit.info }]);
  }

  /** Handle pointermove during drag selection */
  handlePointerMove(pageIndex: number, pdfX: number, pdfY: number): void {
    if (!this.dragStart) return;
    const data = this.viewport.getTextData(pageIndex);
    if (!data) return;

    const hit = hitTestText(data, pdfX, pdfY);
    if (!hit) return;

    // Select range from dragStart to current hit
    const s = this.dragStart;
    let startB = s.block, startL = s.line, startC = s.charIdx;
    let endB = hit.block, endL = hit.line, endC = hit.charIdx;

    // Normalize order
    if (endB < startB || (endB === startB && endL < startL) || (endB === startB && endL === startL && endC < startC)) {
      [startB, endB] = [endB, startB];
      [startL, endL] = [endL, startL];
      [startC, endC] = [endC, startC];
    }

    const chars = getCharRange(data, startB, startL, startC, endB, endL, endC);
    this.setSelection(pageIndex, chars);
  }

  /** Handle pointerup after drag selection */
  handlePointerUp(): void {
    if (this.dragStart && this.currentSelection && this.currentSelection.chars.length > 1) {
      this.startEditing(this.currentSelection.page);
    }
    this.dragStart = null;
  }

  private setSelection(page: number, chars: TextSelection["chars"]): void {
    this.currentSelection = { page, chars };
    this.renderHighlights(page);
  }

  private renderHighlights(pageIndex: number): void {
    this.clearHighlights();
    if (!this.currentSelection) return;

    const scale = this.viewport.getScale();
    const container = this.viewport.getPageContainer(pageIndex);
    if (!container) return;

    // Get or create highlight container
    let hlContainer = container.querySelector(".text-highlight-container") as HTMLDivElement;
    if (!hlContainer) {
      hlContainer = document.createElement("div");
      hlContainer.className = "text-highlight-container";
      container.appendChild(hlContainer);
    }

    // Merge adjacent chars on the same line into single highlight divs
    let currentLineKey = "";
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    const flush = () => {
      if (minX === Infinity) return;
      const screen = pdfRectToScreenRect(
        [minX, minY, maxX, maxY],
        { scale, pageOffsetX: 0, pageOffsetY: 0 }
      );
      const div = document.createElement("div");
      div.className = "text-selection-highlight";
      div.style.left = `${screen.x}px`;
      div.style.top = `${screen.y}px`;
      div.style.width = `${screen.width}px`;
      div.style.height = `${screen.height}px`;
      hlContainer.appendChild(div);
      this.highlightElements.push(div);
      minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
    };

    for (const ch of this.currentSelection.chars) {
      const lineKey = `${ch.block}-${ch.line}`;
      if (lineKey !== currentLineKey) {
        flush();
        currentLineKey = lineKey;
      }
      const q = ch.info.quad;
      const cMinX = Math.min(q[0], q[2], q[4], q[6]);
      const cMaxX = Math.max(q[0], q[2], q[4], q[6]);
      const cMinY = Math.min(q[1], q[3], q[5], q[7]);
      const cMaxY = Math.max(q[1], q[3], q[5], q[7]);
      minX = Math.min(minX, cMinX);
      minY = Math.min(minY, cMinY);
      maxX = Math.max(maxX, cMaxX);
      maxY = Math.max(maxY, cMaxY);
    }
    flush();
  }

  private clearHighlights(): void {
    for (const el of this.highlightElements) el.remove();
    this.highlightElements = [];
  }

  private startEditing(pageIndex: number): void {
    if (!this.currentSelection || this.currentSelection.chars.length === 0) return;
    this.cancelEdit();

    const sel = this.currentSelection;
    const scale = this.viewport.getScale();
    const container = this.viewport.getPageContainer(pageIndex);
    if (!container) return;

    // Compute bounding rect of selection in PDF coords
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const ch of sel.chars) {
      const q = ch.info.quad;
      minX = Math.min(minX, q[0], q[2], q[4], q[6]);
      minY = Math.min(minY, q[1], q[3], q[5], q[7]);
      maxX = Math.max(maxX, q[0], q[2], q[4], q[6]);
      maxY = Math.max(maxY, q[1], q[3], q[5], q[7]);
    }

    const screen = pdfRectToScreenRect([minX, minY, maxX, maxY], { scale, pageOffsetX: 0, pageOffsetY: 0 });

    // Get the selected text
    const selectedText = sel.chars.map(ch => ch.info.c).join("");

    // Determine font properties from first char
    const firstChar = sel.chars[0].info;
    const fontFamily = firstChar.fontFlags.isMono ? "monospace"
      : firstChar.fontFlags.isSerif ? "serif" : "sans-serif";
    const fontSize = firstChar.fontSize * scale;

    // Create editable overlay
    const overlay = document.createElement("div");
    overlay.className = "text-edit-overlay";
    overlay.contentEditable = "true";
    overlay.spellcheck = false;
    overlay.style.left = `${screen.x}px`;
    overlay.style.top = `${screen.y}px`;
    overlay.style.minWidth = `${screen.width}px`;
    overlay.style.minHeight = `${screen.height}px`;
    overlay.style.fontFamily = fontFamily;
    overlay.style.fontSize = `${fontSize}px`;
    overlay.style.lineHeight = `${screen.height}px`;
    overlay.style.color = firstChar.color.length >= 3
      ? `rgb(${firstChar.color[0] * 255}, ${firstChar.color[1] * 255}, ${firstChar.color[2] * 255})`
      : "black";
    overlay.textContent = selectedText;

    // Handle commit on Enter or blur
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.commitEdit();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        this.cancelEdit();
      }
    });
    overlay.addEventListener("blur", () => {
      // Short delay — if pointerdown fires first it will commitEdit() directly,
      // so we only commit here if the overlay is still active
      requestAnimationFrame(() => {
        if (this.editOverlay === overlay) {
          this.commitEdit();
        }
      });
    });

    container.appendChild(overlay);
    this.editOverlay = overlay;

    // Focus and select all text
    overlay.focus();
    const range = document.createRange();
    range.selectNodeContents(overlay);
    const sel2 = window.getSelection();
    sel2?.removeAllRanges();
    sel2?.addRange(range);
  }

  private commitEdit(): void {
    if (!this.editOverlay || !this.currentSelection) return;

    const newText = this.editOverlay.textContent || "";
    const oldText = this.currentSelection.chars.map(ch => ch.info.c).join("");
    const page = this.currentSelection.page;
    const selection = this.currentSelection;

    this.editOverlay.remove();
    this.editOverlay = null;
    this.clearHighlights();

    if (newText !== oldText && newText.trim() !== "") {
      for (const listener of this.commitListeners) {
        listener(page, oldText, newText, selection);
      }
    }

    this.currentSelection = null;
  }

  cancelEdit(): void {
    if (this.editOverlay) {
      this.editOverlay.remove();
      this.editOverlay = null;
    }
  }
}
