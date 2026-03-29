// Properties panel: displays and edits annotation properties

import type { AnnotationDTO, WidgetDTO } from "./types";

export type PropertyChangeEvent = {
  annotId: string;
  property: string;
  value: any;
  oldValue: any;
};

export type PropertyChangeListener = (event: PropertyChangeEvent) => void;

export class PropertiesPanel {
  private panel: HTMLElement;
  private container: HTMLElement;
  private annotation: AnnotationDTO | null = null;
  private widget: WidgetDTO | null = null;
  private changeListeners: PropertyChangeListener[] = [];

  constructor(panel: HTMLElement) {
    this.panel = panel;
    this.container = panel.querySelector(".props-body") || panel;
    this.render();
  }

  onChange(listener: PropertyChangeListener): () => void {
    this.changeListeners.push(listener);
    return () => { this.changeListeners = this.changeListeners.filter((l) => l !== listener); };
  }

  private emitChange(property: string, value: any, oldValue: any) {
    const id = this.annotation?.id || this.widget?.id;
    if (!id) return;
    for (const listener of this.changeListeners) {
      listener({ annotId: id, property, value, oldValue });
    }
  }

  show(annotation: AnnotationDTO): void {
    this.annotation = annotation;
    this.widget = null;
    this.panel.classList.add("open");
    this.render();
  }

  showWidget(widget: WidgetDTO): void {
    this.widget = widget;
    this.annotation = null;
    this.panel.classList.add("open");
    this.renderWidget();
  }

  hide(): void {
    this.annotation = null;
    this.widget = null;
    this.panel.classList.remove("open");
    this.render();
  }

  update(annotation: AnnotationDTO): void {
    this.annotation = annotation;
    this.render();
  }

  updateWidget(widget: WidgetDTO): void {
    this.widget = widget;
    this.renderWidget();
  }

  private render(): void {
    const annot = this.annotation;
    if (!annot) {
      this.container.innerHTML = `<div class="props-empty"><p>Select an annotation to view its properties.</p></div>`;
      return;
    }

    const colorHex = annot.color && annot.color.length >= 3
      ? rgbToHex(annot.color[0], annot.color[1], annot.color[2]) : "#000000";

    let html = `<div class="props-content">`;
    html += `<h3 class="props-type">${escapeHtml(annot.type)}</h3>`;

    // Position
    html += `<div class="props-section">`;
    html += `<label class="props-label">Position</label>`;
    html += `<div class="props-row"><span class="props-coord">x: ${annot.rect[0].toFixed(1)}</span><span class="props-coord">y: ${annot.rect[1].toFixed(1)}</span></div>`;
    html += `<div class="props-row"><span class="props-coord">w: ${(annot.rect[2] - annot.rect[0]).toFixed(1)}</span><span class="props-coord">h: ${(annot.rect[3] - annot.rect[1]).toFixed(1)}</span></div>`;
    html += `</div>`;

    // Color
    html += `<div class="props-section"><label class="props-label">Color</label>`;
    html += `<div class="props-row"><input type="color" class="props-color" data-prop="color" value="${colorHex}" /></div></div>`;

    // Opacity
    html += `<div class="props-section"><label class="props-label">Opacity</label>`;
    html += `<input type="range" class="props-range" data-prop="opacity" min="0" max="1" step="0.05" value="${annot.opacity}" />`;
    html += `<span class="props-value" data-display="opacity">${Math.round(annot.opacity * 100)}%</span></div>`;

    // Fill color (interior color — Square, Circle, Line, FreeText)
    const fillTypes = new Set(["Square", "Circle", "Line", "FreeText"]);
    if (fillTypes.has(annot.type)) {
      const fillHex = annot.interiorColor
        ? rgbToHex(annot.interiorColor[0], annot.interiorColor[1], annot.interiorColor[2])
        : "#ffffff";
      html += `<div class="props-section"><label class="props-label">Fill</label>`;
      html += `<div class="props-row"><input type="color" class="props-color" data-prop="interiorColor" value="${fillHex}" /></div></div>`;
    }

    // Border width
    if (annot.borderWidth !== undefined && !isIconType(annot.type) && !isQuadPointType(annot.type)) {
      html += `<div class="props-section"><label class="props-label">Border</label>`;
      html += `<input type="number" class="props-input" data-prop="borderWidth" min="0" max="20" step="0.5" value="${annot.borderWidth}" /></div>`;
    }

    // Icon (Text annotations)
    if (annot.type === "Text" && annot.icon) {
      html += `<div class="props-section"><label class="props-label">Icon</label><select class="props-select" data-prop="icon">`;
      for (const icon of ["Note", "Comment", "Help", "Insert", "Key", "NewParagraph", "Paragraph"]) {
        html += `<option value="${icon}"${icon === annot.icon ? " selected" : ""}>${icon}</option>`;
      }
      html += `</select></div>`;
    }

    // Font size (FreeText)
    if (annot.type === "FreeText" && annot.defaultAppearance) {
      html += `<div class="props-section"><label class="props-label">Font Size</label>`;
      html += `<input type="number" class="props-input" data-prop="fontSize" min="4" max="144" value="${annot.defaultAppearance.size}" /></div>`;
    }

    // Comment text
    html += `<div class="props-section"><label class="props-label">Comment</label>`;
    html += `<textarea class="props-textarea" data-prop="contents" rows="4" placeholder="Add comment...">${escapeHtml(annot.contents || "")}</textarea></div>`;

    // Author (read-only)
    if (annot.author) {
      html += `<div class="props-section"><label class="props-label">Author</label><span class="props-readonly">${escapeHtml(annot.author)}</span></div>`;
    }

    // Dates
    if (annot.modifiedDate) html += `<div class="props-section"><label class="props-label">Modified</label><span class="props-readonly">${formatDate(annot.modifiedDate)}</span></div>`;
    if (annot.createdDate) html += `<div class="props-section"><label class="props-label">Created</label><span class="props-readonly">${formatDate(annot.createdDate)}</span></div>`;

    // Delete button
    html += `<div class="props-section"><button class="props-delete" data-action="delete">Delete Annotation</button></div>`;

    html += `</div>`;
    this.container.innerHTML = html;

    // Wire up event listeners
    this.bindInputEvents();
  }

  private bindInputEvents(): void {
    // Color
    this.container.querySelector<HTMLInputElement>('[data-prop="color"]')?.addEventListener("change", (e) => {
      const hex = (e.target as HTMLInputElement).value;
      const rgb = hexToRgb(hex);
      this.emitChange("color", rgb, this.annotation?.color);
    });

    // Opacity
    const opacityInput = this.container.querySelector<HTMLInputElement>('[data-prop="opacity"]');
    opacityInput?.addEventListener("input", (e) => {
      const val = parseFloat((e.target as HTMLInputElement).value);
      const display = this.container.querySelector('[data-display="opacity"]');
      if (display) display.textContent = `${Math.round(val * 100)}%`;
    });
    opacityInput?.addEventListener("change", (e) => {
      const val = parseFloat((e.target as HTMLInputElement).value);
      this.emitChange("opacity", val, this.annotation?.opacity);
    });

    // Contents
    const textarea = this.container.querySelector<HTMLTextAreaElement>('[data-prop="contents"]');
    let contentsDebounce: ReturnType<typeof setTimeout> | null = null;
    textarea?.addEventListener("input", () => {
      if (contentsDebounce) clearTimeout(contentsDebounce);
      contentsDebounce = setTimeout(() => {
        this.emitChange("contents", textarea.value, this.annotation?.contents);
      }, 300);
    });

    // Fill / interior color
    this.container.querySelector<HTMLInputElement>('[data-prop="interiorColor"]')?.addEventListener("change", (e) => {
      const hex = (e.target as HTMLInputElement).value;
      const rgb = hexToRgb(hex);
      this.emitChange("interiorColor", rgb, this.annotation?.interiorColor);
    });

    // Border width
    this.container.querySelector<HTMLInputElement>('[data-prop="borderWidth"]')?.addEventListener("change", (e) => {
      const val = parseFloat((e.target as HTMLInputElement).value);
      this.emitChange("borderWidth", val, this.annotation?.borderWidth);
    });

    // Icon
    this.container.querySelector<HTMLSelectElement>('[data-prop="icon"]')?.addEventListener("change", (e) => {
      this.emitChange("icon", (e.target as HTMLSelectElement).value, this.annotation?.icon);
    });

    // Delete button
    this.container.querySelector('[data-action="delete"]')?.addEventListener("click", () => {
      if (this.annotation) {
        this.emitChange("delete", null, this.annotation);
      }
    });
  }

  private renderWidget(): void {
    const w = this.widget;
    if (!w) { this.render(); return; }

    let html = `<div class="props-content">`;
    html += `<h3 class="props-type">Form Field</h3>`;

    // Field name
    html += `<div class="props-section"><label class="props-label">Field Name</label>`;
    html += `<span class="props-readonly">${escapeHtml(w.fieldName)}</span></div>`;

    // Field type
    html += `<div class="props-section"><label class="props-label">Type</label>`;
    html += `<span class="props-readonly">${escapeHtml(w.fieldType)}</span></div>`;

    // Position
    html += `<div class="props-section"><label class="props-label">Position</label>`;
    html += `<div class="props-row"><span class="props-coord">x: ${w.rect[0].toFixed(1)}</span><span class="props-coord">y: ${w.rect[1].toFixed(1)}</span></div>`;
    html += `<div class="props-row"><span class="props-coord">w: ${(w.rect[2] - w.rect[0]).toFixed(1)}</span><span class="props-coord">h: ${(w.rect[3] - w.rect[1]).toFixed(1)}</span></div></div>`;

    // Editable value (for text fields)
    if (w.fieldType === "text") {
      html += `<div class="props-section"><label class="props-label">Value</label>`;
      html += `<input type="text" class="props-input" data-prop="widgetValue" value="${escapeHtml(w.value)}" placeholder="Enter value..." /></div>`;
    } else if (w.fieldType === "button") {
      html += `<div class="props-section"><label class="props-label">Value</label>`;
      html += `<span class="props-readonly">${w.value || "(none)"}</span></div>`;
    } else if (w.fieldType === "choice") {
      html += `<div class="props-section"><label class="props-label">Value</label>`;
      html += `<span class="props-readonly">${w.value || "(none)"}</span></div>`;
    }

    html += `</div>`;
    this.container.innerHTML = html;

    // Wire widget-specific events
    const valueInput = this.container.querySelector<HTMLInputElement>('[data-prop="widgetValue"]');
    let debounce: ReturnType<typeof setTimeout> | null = null;
    valueInput?.addEventListener("input", () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        this.emitChange("widgetValue", valueInput.value, w.value);
      }, 300);
    });
  }
}

function isIconType(type: string): boolean { return type === "Text"; }
function isQuadPointType(type: string): boolean { return ["Highlight", "Underline", "StrikeOut", "Squiggly"].includes(type); }

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function hexToRgb(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return [r, g, b];
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function formatDate(isoString: string): string {
  try {
    return new Date(isoString).toLocaleDateString(undefined, {
      year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch { return isoString; }
}
