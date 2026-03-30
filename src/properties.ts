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
  private activeTool: string | null = null;
  private toolDefaults: { color: number[]; borderWidth: number; opacity: number } | null = null;
  /** Listeners for tool default changes (color/size/opacity set before drawing) */
  private toolChangeListeners: Array<(prop: string, value: any) => void> = [];

  onToolDefaultChange(listener: (prop: string, value: any) => void): void {
    this.toolChangeListeners.push(listener);
  }

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

  private emitToolChange(prop: string, value: any) {
    if (this.toolDefaults) {
      if (prop === "color") this.toolDefaults.color = value;
      if (prop === "borderWidth") this.toolDefaults.borderWidth = value;
      if (prop === "opacity") this.toolDefaults.opacity = value;
    }
    for (const listener of this.toolChangeListeners) {
      listener(prop, value);
    }
    // Re-render to update selected state
    if (this.activeTool) this.renderToolPanel();
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
    this.activeTool = null;
    this.panel.classList.remove("open");
    this.render();
  }

  /** Show visual panel for a drawing tool (before any annotation is created) */
  showToolPanel(tool: string, color: number[], borderWidth: number, opacity: number): void {
    this.annotation = null;
    this.widget = null;
    this.activeTool = tool;
    this.toolDefaults = { color, borderWidth, opacity };
    this.panel.classList.add("open");
    this.renderToolPanel();
  }

  hideToolPanel(): void {
    if (this.activeTool && !this.annotation) {
      this.activeTool = null;
      this.toolDefaults = null;
      this.panel.classList.remove("open");
      this.render();
    }
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

    // Export button for embedded page content images
    if (annot.type === "Image" && annot.id.startsWith("img")) {
      html += `<div class="props-section"><button class="props-btn" data-action="exportImage">Export Image</button></div>`;
    }

    // Visual panel for drawing annotations
    const drawingTypes = new Set(["Ink", "Line", "Square", "Circle", "Highlight", "FreeText"]);
    if (drawingTypes.has(annot.type)) {
      html += this.renderVisualPanel(annot, colorHex);
    }

    // Position (editable)
    const w = annot.rect[2] - annot.rect[0], h = annot.rect[3] - annot.rect[1];
    html += `<div class="props-section">`;
    html += `<label class="props-label">Position</label>`;
    html += `<div class="props-row"><label class="props-coord-label">x</label><input type="number" class="props-coord-input" data-prop="posX" step="1" value="${annot.rect[0].toFixed(1)}" />`;
    html += `<label class="props-coord-label">y</label><input type="number" class="props-coord-input" data-prop="posY" step="1" value="${annot.rect[1].toFixed(1)}" /></div>`;
    html += `<div class="props-row"><label class="props-coord-label">w</label><input type="number" class="props-coord-input" data-prop="posW" step="1" min="1" value="${w.toFixed(1)}" />`;
    html += `<label class="props-coord-label">h</label><input type="number" class="props-coord-input" data-prop="posH" step="1" min="1" value="${h.toFixed(1)}" /></div>`;
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
      const fillHex = annot.interiorColor && annot.interiorColor.length >= 3
        ? rgbToHex(annot.interiorColor[0], annot.interiorColor[1], annot.interiorColor[2])
        : "#ffffff";
      html += `<div class="props-section"><label class="props-label">Fill</label>`;
      html += `<div class="props-row"><input type="color" class="props-color" data-prop="interiorColor" value="${fillHex}" /></div></div>`;
    }

    // Border width + style
    if (annot.borderWidth !== undefined && !isIconType(annot.type) && !isQuadPointType(annot.type)) {
      html += `<div class="props-section"><label class="props-label">Border</label>`;
      html += `<input type="number" class="props-input" data-prop="borderWidth" min="0" max="20" step="0.5" value="${annot.borderWidth}" />`;
      const curStyle = annot.borderStyle || "Solid";
      html += `<select class="props-select" data-prop="borderStyle" style="margin-top:4px">`;
      for (const s of ["Solid", "Dashed", "Beveled", "Inset", "Underline"]) {
        html += `<option value="${s}"${s === curStyle ? " selected" : ""}>${s}</option>`;
      }
      html += `</select></div>`;
    }

    // Icon (Text annotations)
    if (annot.type === "Text" && annot.icon) {
      html += `<div class="props-section"><label class="props-label">Icon</label><select class="props-select" data-prop="icon">`;
      for (const icon of ["Note", "Comment", "Help", "Insert", "Key", "NewParagraph", "Paragraph"]) {
        html += `<option value="${icon}"${icon === annot.icon ? " selected" : ""}>${icon}</option>`;
      }
      html += `</select></div>`;
    }

    // Font controls (FreeText)
    if (annot.type === "FreeText" && annot.defaultAppearance) {
      const currentFont = annot.defaultAppearance.font || "Helv";
      html += `<div class="props-section"><label class="props-label">Font</label>`;
      html += `<select class="props-select" data-prop="fontFamily">`;
      const fonts: [string, string][] = [["Helv", "Sans Serif"], ["TiRo", "Serif"], ["Cour", "Monospace"]];
      for (const [val, label] of fonts) {
        html += `<option value="${val}"${val === currentFont ? " selected" : ""}>${label}</option>`;
      }
      html += `</select></div>`;

      html += `<div class="props-section"><label class="props-label">Size</label>`;
      html += `<input type="number" class="props-input" data-prop="fontSize" min="4" max="144" value="${annot.defaultAppearance.size}" /></div>`;

      const textColorHex = annot.defaultAppearance.color
        ? rgbToHex(annot.defaultAppearance.color[0], annot.defaultAppearance.color[1], annot.defaultAppearance.color[2])
        : "#000000";
      html += `<div class="props-section"><label class="props-label">Text Color</label>`;
      html += `<div class="props-row"><input type="color" class="props-color" data-prop="textColor" value="${textColorHex}" /></div></div>`;
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

  private renderVisualPanel(annot: AnnotationDTO, colorHex: string): string {
    let html = "";

    // --- Size selector ---
    const sizes = [1, 2, 3, 5, 8];
    const currentSize = annot.borderWidth ?? 2;
    html += `<div class="vp-section"><div class="vp-label">Size</div><div class="vp-sizes">`;
    for (const s of sizes) {
      const sel = Math.abs(currentSize - s) < 0.5 ? " vp-selected" : "";
      html += `<button class="vp-size-btn${sel}" data-vp-size="${s}" title="${s}pt">`;
      html += `<svg width="36" height="36" viewBox="0 0 36 36"><line x1="6" y1="30" x2="30" y2="6" stroke="currentColor" stroke-width="${s}" stroke-linecap="round"/></svg>`;
      html += `</button>`;
    }
    html += `</div></div>`;

    // --- Color palette (pastels for highlights, vivids for drawing) ---
    const isHighlight = annot.type === "Highlight";
    const palette = isHighlight ? [
      "#FFFF00", "#FFE082", "#A5D6A7", "#90CAF9", "#CE93D8",
      "#FFF9C4", "#FFE0B2", "#C8E6C9", "#BBDEFB", "#E1BEE7",
      "#FF8A80", "#FFD180", "#B9F6CA", "#82B1FF", "#EA80FC",
      "#FF5252", "#FFAB40", "#69F0AE", "#448AFF", "#E040FB",
    ] : [
      "#000000", "#808080", "#BBBBBB", "#DDDDDD", "#FFFFFF",
      "#F28B82", "#FBBC04", "#34A853", "#4285F4", "#DEB887",
      "#EA4335", "#F9AB00", "#1E8E3E", "#1A73E8", "#A0522D",
      "#B71C1C", "#E65100", "#1B5E20", "#0D47A1", "#4E342E",
    ];
    const currentColor = colorHex.toUpperCase();
    html += `<div class="vp-section"><div class="vp-label">Color</div><div class="vp-colors">`;
    for (const c of palette) {
      const sel = currentColor === c.toUpperCase() ? " vp-selected" : "";
      html += `<button class="vp-color-btn${sel}" data-vp-color="${c}" title="${c}">`;
      html += `<span class="vp-swatch" style="background:${c}"></span>`;
      html += `</button>`;
    }
    // Custom color at end
    html += `<label class="vp-color-btn vp-custom" title="Custom color">`;
    html += `<span class="vp-swatch" style="background: conic-gradient(red, yellow, lime, aqua, blue, magenta, red)"></span>`;
    html += `<input type="color" class="vp-color-custom-input" value="${colorHex}" />`;
    html += `</label>`;
    html += `</div></div>`;

    // --- Opacity quick buttons ---
    const opacities = [0.25, 0.5, 0.75, 1.0];
    html += `<div class="vp-section"><div class="vp-label">Opacity</div><div class="vp-opacities">`;
    for (const o of opacities) {
      const sel = Math.abs(annot.opacity - o) < 0.05 ? " vp-selected" : "";
      html += `<button class="vp-opacity-btn${sel}" data-vp-opacity="${o}">${Math.round(o * 100)}%</button>`;
    }
    html += `</div></div>`;

    return html;
  }

  private renderToolPanel(): void {
    if (!this.toolDefaults) return;
    const { color, borderWidth, opacity } = this.toolDefaults;
    const colorHex = color.length >= 3
      ? rgbToHex(color[0], color[1], color[2]) : "#ff0000";

    // Build a fake AnnotationDTO for renderVisualPanel
    const toolToType: Record<string, string> = {
      ink: "Ink", line: "Line", rectangle: "Square", circle: "Circle", highlight: "Highlight",
    };
    const fakeAnnot: AnnotationDTO = {
      id: "", page: 0, type: toolToType[this.activeTool!] || "Ink", rect: [0, 0, 0, 0],
      color, opacity, contents: "", borderWidth, hasRect: false,
    };

    let html = `<div class="props-content">`;
    html += `<h3 class="props-type" style="text-transform:capitalize">${this.activeTool} Tool</h3>`;
    html += this.renderVisualPanel(fakeAnnot, colorHex);
    html += `</div>`;
    this.container.innerHTML = html;
    this.bindInputEvents();
  }

  private bindInputEvents(): void {
    // Visual panel: size buttons
    for (const btn of this.container.querySelectorAll<HTMLButtonElement>("[data-vp-size]")) {
      btn.addEventListener("click", () => {
        const size = parseFloat(btn.dataset.vpSize!);
        if (this.annotation) {
          this.emitChange("borderWidth", size, this.annotation.borderWidth);
        } else {
          this.emitToolChange("borderWidth", size);
        }
      });
    }

    // Visual panel: color buttons
    for (const btn of this.container.querySelectorAll<HTMLButtonElement>("[data-vp-color]")) {
      btn.addEventListener("click", () => {
        const hex = btn.dataset.vpColor!;
        const rgb = hexToRgb(hex);
        if (this.annotation) {
          this.emitChange("color", rgb, this.annotation.color);
        } else {
          this.emitToolChange("color", rgb);
        }
      });
    }

    // Visual panel: custom color input
    this.container.querySelector<HTMLInputElement>(".vp-color-custom-input")?.addEventListener("change", (e) => {
      const hex = (e.target as HTMLInputElement).value;
      const rgb = hexToRgb(hex);
      if (this.annotation) {
        this.emitChange("color", rgb, this.annotation.color);
      } else {
        this.emitToolChange("color", hexToRgb(hex));
      }
    });

    // Visual panel: opacity buttons
    for (const btn of this.container.querySelectorAll<HTMLButtonElement>("[data-vp-opacity]")) {
      btn.addEventListener("click", () => {
        const opacity = parseFloat(btn.dataset.vpOpacity!);
        if (this.annotation) {
          this.emitChange("opacity", opacity, this.annotation.opacity);
        } else {
          this.emitToolChange("opacity", opacity);
        }
      });
    }

    // Position (x, y, w, h)
    const posHandler = () => {
      if (!this.annotation) return;
      const getVal = (prop: string) => parseFloat((this.container.querySelector<HTMLInputElement>(`[data-prop="${prop}"]`) as HTMLInputElement)?.value || "0");
      const x = getVal("posX"), y = getVal("posY"), w = getVal("posW"), h = getVal("posH");
      const newRect: [number, number, number, number] = [x, y, x + w, y + h];
      this.emitChange("rect", newRect, this.annotation.rect);
    };
    for (const prop of ["posX", "posY", "posW", "posH"]) {
      this.container.querySelector<HTMLInputElement>(`[data-prop="${prop}"]`)?.addEventListener("change", posHandler);
    }

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

    // Border style
    this.container.querySelector<HTMLSelectElement>('[data-prop="borderStyle"]')?.addEventListener("change", (e) => {
      this.emitChange("borderStyle", (e.target as HTMLSelectElement).value, this.annotation?.borderStyle);
    });

    // Font family (FreeText)
    this.container.querySelector<HTMLSelectElement>('[data-prop="fontFamily"]')?.addEventListener("change", (e) => {
      const font = (e.target as HTMLSelectElement).value;
      const da = this.annotation?.defaultAppearance;
      if (da) {
        this.emitChange("defaultAppearance", { font, size: da.size, color: da.color }, da);
      }
    });

    // Font size (FreeText)
    this.container.querySelector<HTMLInputElement>('[data-prop="fontSize"]')?.addEventListener("change", (e) => {
      const size = parseFloat((e.target as HTMLInputElement).value);
      const da = this.annotation?.defaultAppearance;
      if (da) {
        this.emitChange("defaultAppearance", { font: da.font, size, color: da.color }, da);
      }
    });

    // Text color (FreeText)
    this.container.querySelector<HTMLInputElement>('[data-prop="textColor"]')?.addEventListener("change", (e) => {
      const hex = (e.target as HTMLInputElement).value;
      const rgb = hexToRgb(hex);
      const da = this.annotation?.defaultAppearance;
      if (da) {
        this.emitChange("defaultAppearance", { font: da.font, size: da.size, color: rgb }, da);
      }
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

    // Export image button
    this.container.querySelector('[data-action="exportImage"]')?.addEventListener("click", () => {
      if (this.annotation) {
        this.emitChange("exportImage", null, this.annotation);
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
