// PDF Canvas — App entry point

import { WorkerRPC } from "./worker-rpc";
import { Viewport } from "./viewport";
import { InteractionLayer } from "./interaction";
import { PropertiesPanel } from "./properties";
import { UndoManager } from "./undo";
import { Toolbar } from "./toolbar";
import { TextLayer } from "./text-layer";
import { SearchBar } from "./search";

let rpc: WorkerRPC;
let viewport: Viewport;
let interaction: InteractionLayer;
let properties: PropertiesPanel;
let undoManager: UndoManager;
let toolbar: Toolbar;
let textLayer: TextLayer;
let searchBar: SearchBar;
let currentFilename = "document.pdf";
let hasOpenDocument = false;
let isDirty = false;

function init() {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
  });
  rpc = new WorkerRPC(worker);

  const viewportEl = document.getElementById("viewport")!;
  viewport = new Viewport(viewportEl, rpc);

  // Undo manager
  undoManager = new UndoManager(50);

  // Text layer (for text editing)
  textLayer = new TextLayer(viewport);

  // Interaction layer
  interaction = new InteractionLayer(viewport);
  interaction.undoManager = undoManager;
  interaction.textLayer = textLayer;

  // Properties panel
  const propsEl = document.getElementById("properties-panel")!;
  properties = new PropertiesPanel(propsEl);

  // Wire selection → properties panel
  interaction.onSelectionChange((annotation) => {
    if (annotation) {
      if (annotation.type === "Widget" && annotation.id.startsWith("w")) {
        // Find the actual WidgetDTO from the viewport cache
        const widget = findWidget(annotation.id);
        if (widget) {
          properties.showWidget(widget);
          return;
        }
      }
      properties.show(annotation);
    } else {
      properties.hide();
    }
  });

  // Toolbar
  toolbar = new Toolbar();
  toolbar.onChange((tool) => {
    interaction.setTool(tool);
    if (tool !== "select") interaction.select(null);
  });
  interaction.onCreationDone = () => {
    toolbar.setTool("select");
    interaction.setTool("select");
  };

  // Wire text edit commits
  textLayer.onCommit(async (page, oldText, newText, selection) => {
    // Strategy 1: Try content stream replacement (preserves original font)
    console.log(`[TextEdit] Attempting content stream replacement on page ${page}...`);
    const response = await rpc.send({
      type: "replaceTextInStream",
      page,
      oldText,
      newText,
    });

    if (response.type === "textReplaced" && response.count > 0) {
      console.log(`[TextEdit] ✓ Content stream edit succeeded (${response.count} replacement(s))`);
      markDirty();
      viewport.clearTextCache(page);
      await viewport.rerenderPage(page);
      return;
    }

    // Strategy 2: Fall back to redact + FreeText overlay
    console.log(`[TextEdit] Content stream edit found no match — falling back to redact + FreeText`);
    // Compute bounding rect from selection chars
    const chars = selection.chars;
    if (chars.length === 0) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const ch of chars) {
      const q = ch.info.quad;
      for (let i = 0; i < q.length; i += 2) {
        minX = Math.min(minX, q[i]);
        minY = Math.min(minY, q[i + 1]);
        maxX = Math.max(maxX, q[i]);
        maxY = Math.max(maxY, q[i + 1]);
      }
    }
    // Add small padding
    const rect: [number, number, number, number] = [minX - 0.5, minY - 0.5, maxX + 0.5, maxY + 0.5];

    // Derive font info from first character
    const firstChar = chars[0].info;
    const fontFamily = firstChar.fontFlags.isMono ? "Cour"
      : firstChar.fontFlags.isSerif ? "TiRo" : "Helv";

    console.log(`[TextEdit] Redacting rect [${rect.map(n => n.toFixed(1)).join(", ")}], replacing with "${newText}" (font: ${fontFamily} ${firstChar.fontSize}pt)`);
    await rpc.send({
      type: "replaceTextViaRedact",
      page,
      rect,
      newText,
      fontSize: firstChar.fontSize,
      fontFamily,
      color: firstChar.color.length >= 3 ? firstChar.color : [0, 0, 0],
    });
    console.log(`[TextEdit] ✓ Redact + FreeText fallback succeeded`);

    markDirty();
    viewport.clearTextCache(page);
    await viewport.rerenderPage(page);
  });

  // Search bar (Ctrl+F)
  const searchBarEl = document.getElementById("search-bar")!;
  searchBar = new SearchBar(searchBarEl, rpc, viewport);
  searchBar.onReplace(async (page, oldText, newText) => {
    markDirty();
    const response = await rpc.send({
      type: "replaceTextInStream",
      page,
      oldText,
      newText,
      replaceAll: true,
    });
    if (response.type === "textReplaced" && response.count > 0) {
      viewport.clearTextCache(page);
      await viewport.rerenderPage(page);
    }
  });

  // Color picker
  const colorInput = document.getElementById("toolbar-color") as HTMLInputElement;
  const colorSwatch = document.getElementById("color-swatch")!;
  colorSwatch.style.backgroundColor = colorInput.value;
  colorInput.addEventListener("input", async () => {
    colorSwatch.style.backgroundColor = colorInput.value;
    const hex = colorInput.value;
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const rgb: [number, number, number] = [r, g, b];
    interaction.setColor(rgb);

    // Also apply to selected annotation immediately
    const selected = interaction.getSelectedAnnotation();
    if (selected) {
      undoManager.push({ annotId: selected.id, property: "color", previousValue: selected.color, newValue: rgb });
      await rpc.send({ type: "setAnnotColor", annotId: selected.id, color: rgb });
      await viewport.rerenderPage(selected.page);
      const updated = interaction.getSelectedAnnotation();
      if (updated) properties.update(updated);
    }
  });
  colorSwatch.parentElement?.addEventListener("click", () => colorInput.click());

  // Fill color picker
  const fillColorInput = document.getElementById("toolbar-fill-color") as HTMLInputElement;
  const fillSwatch = document.getElementById("fill-swatch")!;
  fillSwatch.style.backgroundColor = fillColorInput.value;
  fillColorInput.addEventListener("input", () => {
    fillSwatch.style.backgroundColor = fillColorInput.value;
    const hex = fillColorInput.value;
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    interaction.setFillColor([r, g, b]);
  });
  fillSwatch.parentElement?.addEventListener("click", () => fillColorInput.click());

  // Line weight
  const lineWeightSelect = document.getElementById("toolbar-line-weight") as HTMLSelectElement;
  lineWeightSelect.addEventListener("change", () => {
    interaction.setBorderWidth(parseFloat(lineWeightSelect.value));
  });

  // Wire property changes → worker mutations
  properties.onChange(async (event) => {
    const { annotId, property, value, oldValue } = event;

    if (property === "delete") {
      await interaction.deleteSelected();
      return;
    }

    // Handle widget value changes
    if (property === "widgetValue") {
      markDirty();
      await rpc.send({ type: "setWidgetValue", widgetId: annotId, value });
      const pageIndex = parseInt(annotId.replace("w", "").split("-")[0]);
      await viewport.rerenderPage(pageIndex);
      return;
    }

    // Push undo entry and mark dirty
    undoManager.push({ annotId, property, previousValue: oldValue, newValue: value });
    markDirty();

    // Dispatch to worker
    await applyPropertyChange(annotId, property, value);

    // Re-render and refresh
    const annot = interaction.getSelectedAnnotation();
    if (annot) {
      await viewport.rerenderPage(annot.page);
      // Refresh selection to get updated annotation data
      const updated = interaction.getSelectedAnnotation();
      if (updated) properties.update(updated);
    }
  });

  // Zoom display
  const zoomDisplay = document.getElementById("zoom-display")!;
  viewport.setZoomDisplay(zoomDisplay);

  // File buttons
  document.getElementById("btn-open")!.addEventListener("click", openFilePicker);
  document.getElementById("btn-save")!.addEventListener("click", saveFile);
  document.getElementById("btn-insert-image")!.addEventListener("click", insertImage);
  document.getElementById("btn-zoom-in")!.addEventListener("click", () => viewport.setZoom(viewport.getZoom() + 0.25));
  document.getElementById("btn-zoom-out")!.addEventListener("click", () => viewport.setZoom(viewport.getZoom() - 0.25));

  // Undo/redo buttons
  const btnUndo = document.getElementById("btn-undo") as HTMLButtonElement;
  const btnRedo = document.getElementById("btn-redo") as HTMLButtonElement;
  btnUndo.addEventListener("click", async () => {
    const entry = undoManager.undo();
    if (entry) await applyUndo(entry, entry.previousValue);
  });
  btnRedo.addEventListener("click", async () => {
    const entry = undoManager.redo();
    if (entry) await applyUndo(entry, entry.newValue);
  });
  undoManager.onChange(() => {
    btnUndo.disabled = !undoManager.canUndo();
    btnRedo.disabled = !undoManager.canRedo();
    markDirty();
  });

  // Page navigation
  document.getElementById("btn-prev-page")!.addEventListener("click", () => {
    const cur = viewport.getCurrentPage();
    if (cur > 0) viewport.scrollToPage(cur - 1);
    updatePageDisplay();
  });
  document.getElementById("btn-next-page")!.addEventListener("click", () => {
    const cur = viewport.getCurrentPage();
    const pages = viewport.getPages();
    if (cur < pages.length - 1) viewport.scrollToPage(cur + 1);
    updatePageDisplay();
  });

  // Scroll → page display
  document.getElementById("viewport")!.addEventListener("scroll", () => updatePageDisplay());

  // Drag and drop
  setupDragDrop(viewportEl);

  // Keyboard shortcuts
  document.addEventListener("keydown", handleKeyDown);

  // Warn before losing work
  window.addEventListener("beforeunload", (e) => {
    if (hasOpenDocument) e.preventDefault();
  });

  showWelcome(true);
}

async function applyPropertyChange(annotId: string, property: string, value: any): Promise<void> {
  switch (property) {
    case "color":
      await rpc.send({ type: "setAnnotColor", annotId, color: value });
      break;
    case "opacity":
      await rpc.send({ type: "setAnnotOpacity", annotId, opacity: value });
      break;
    case "contents":
      await rpc.send({ type: "setAnnotContents", annotId, text: value });
      break;
    case "icon":
      await rpc.send({ type: "setAnnotIcon", annotId, icon: value });
      break;
  }
}

async function applyUndo(entry: { annotId: string; property: string; previousValue: any; newValue: any }, value: any): Promise<void> {
  const pageIndex = parseInt(entry.annotId.split("-")[0]);

  switch (entry.property) {
    case "rect":
      await rpc.send({ type: "setAnnotRect", annotId: entry.annotId, rect: value });
      break;
    case "quadPoints":
      await rpc.send({ type: "setAnnotQuadPoints", annotId: entry.annotId, quadPoints: value });
      break;
    case "color":
      await rpc.send({ type: "setAnnotColor", annotId: entry.annotId, color: value });
      break;
    case "opacity":
      await rpc.send({ type: "setAnnotOpacity", annotId: entry.annotId, opacity: value });
      break;
    case "contents":
      await rpc.send({ type: "setAnnotContents", annotId: entry.annotId, text: value });
      break;
    case "icon":
      await rpc.send({ type: "setAnnotIcon", annotId: entry.annotId, icon: value });
      break;
    case "delete": {
      // Undo delete = recreate annotation from saved DTO
      const dto = entry.previousValue as import("./types").AnnotationDTO;
      await rpc.send({
        type: "createAnnot",
        page: dto.page,
        annotType: dto.type,
        rect: dto.rect,
        properties: dto,
      });
      break;
    }
    case "create": {
      // Undo create = delete the annotation
      // value is the DTO, which means: undo → delete the annotId, redo → recreate
      if (value === null) {
        // This is the undo direction (previousValue=null means "before creation, nothing existed")
        // The annotId is from the entry, delete it
        await rpc.send({ type: "deleteAnnot", annotId: entry.annotId });
      } else {
        // Redo direction — recreate
        const dto = value as import("./types").AnnotationDTO;
        await rpc.send({
          type: "createAnnot",
          page: dto.page,
          annotType: dto.type,
          rect: dto.rect,
          properties: dto,
        });
      }
      break;
    }
  }

  await viewport.rerenderPage(pageIndex);
  const updated = interaction.getSelectedAnnotation();
  if (updated) properties.update(updated);
}

async function handleKeyDown(e: KeyboardEvent): Promise<void> {
  // Delete selected annotation
  if ((e.key === "Delete" || e.key === "Backspace") && interaction.getSelectedId()) {
    // Don't delete if we're focused on an input
    if (isEditingText()) return;
    e.preventDefault();
    await interaction.deleteSelected();
    return;
  }

  // Open: Ctrl+O
  if ((e.ctrlKey || e.metaKey) && e.key === "o") {
    e.preventDefault();
    openFilePicker();
    return;
  }

  // Find: Ctrl+F
  if ((e.ctrlKey || e.metaKey) && e.key === "f") {
    e.preventDefault();
    if (hasOpenDocument) searchBar.show();
    return;
  }

  // Undo: Ctrl+Z
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === "z") {
    e.preventDefault();
    const entry = undoManager.undo();
    if (entry) await applyUndo(entry, entry.previousValue);
    return;
  }

  // Redo: Ctrl+Shift+Z or Ctrl+Y
  if ((e.ctrlKey || e.metaKey) && (e.shiftKey && e.key === "z" || e.key === "y")) {
    e.preventDefault();
    const entry = undoManager.redo();
    if (entry) await applyUndo(entry, entry.newValue);
    return;
  }

  // Save: Ctrl+S
  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    e.preventDefault();
    await saveFile();
    return;
  }

  // Arrow keys: nudge selected annotation by 1pt
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key) && interaction.getSelectedId()) {
    if (isEditingText()) return;
    e.preventDefault();
    const annot = interaction.getSelectedAnnotation();
    if (!annot) return;

    let dx = 0, dy = 0;
    if (e.key === "ArrowLeft") dx = -1;
    if (e.key === "ArrowRight") dx = 1;
    if (e.key === "ArrowUp") dy = -1;
    if (e.key === "ArrowDown") dy = 1;

    const newRect: [number, number, number, number] = [
      annot.rect[0] + dx, annot.rect[1] + dy,
      annot.rect[2] + dx, annot.rect[3] + dy,
    ];

    undoManager.push({ annotId: annot.id, property: "rect", previousValue: annot.rect, newValue: newRect });
    await rpc.send({ type: "setAnnotRect", annotId: annot.id, rect: newRect });
    await viewport.rerenderPage(annot.page);
    return;
  }
}

function isEditingText(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLTextAreaElement
    || active instanceof HTMLInputElement
    || (active instanceof HTMLElement && active.contentEditable === "true");
}

async function insertImage(): Promise<void> {
  if (!hasOpenDocument) return;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/png,image/jpeg,image/gif,image/webp";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;

    const buffer = await file.arrayBuffer();
    const page = viewport.getCurrentPage();
    const pageInfo = viewport.getPages()[page];

    // Get natural image dimensions to preserve aspect ratio
    const blob = new Blob([buffer.slice(0)], { type: file.type });
    const imgUrl = URL.createObjectURL(blob);
    const img = new Image();
    await new Promise<void>((resolve) => { img.onload = () => resolve(); img.src = imgUrl; });
    URL.revokeObjectURL(imgUrl);

    // Fit image within max 300pt wide, preserving aspect ratio
    const maxW = 300;
    const maxH = 400;
    let w = img.naturalWidth * 0.75; // pixels → approximate PDF points (96dpi → 72dpi)
    let h = img.naturalHeight * 0.75;
    if (w > maxW) { h *= maxW / w; w = maxW; }
    if (h > maxH) { w *= maxH / h; h = maxH; }

    const cx = pageInfo.width / 2;
    const cy = pageInfo.height / 2;
    const rect: [number, number, number, number] = [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];

    console.log(`[Image] Inserting image "${file.name}" on page ${page}`);
    const response = await rpc.send(
      { type: "addImage", page, rect, imageData: buffer, mimeType: file.type },
      [buffer]
    );

    if (response.type === "annotCreated") {
      console.log(`[Image] ✓ Image added as Stamp annotation`);
      markDirty();
      await viewport.rerenderPage(page);
      interaction.select(response.annot.id);
    }
  };
  input.click();
}

async function saveFile(): Promise<void> {
  if (!hasOpenDocument) return;
  const response = await rpc.send({ type: "save", options: "incremental" });
  if (response.type === "saved") {
    const blob = new Blob([response.buffer], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = currentFilename;
    a.click();
    URL.revokeObjectURL(url);
    markClean();
  }
}

function markDirty() {
  if (!isDirty && hasOpenDocument) {
    isDirty = true;
    document.title = `* ${currentFilename} — PDF Canvas`;
  }
}

// Also mark dirty on any interaction-layer mutations (drag, etc.)
// The undo manager onChange covers pushes from properties and main.ts,
// but the interaction layer also pushes directly during drag/delete.
// Those are covered since they use the same undoManager instance.

function markClean() {
  isDirty = false;
  if (hasOpenDocument) {
    document.title = `${currentFilename} — PDF Canvas`;
  }
}

function findWidget(widgetId: string): import("./types").WidgetDTO | null {
  for (const page of viewport.getPages()) {
    const widgets = viewport.getWidgets(page.index);
    const found = widgets.find((w) => w.id === widgetId);
    if (found) return found;
  }
  return null;
}

function showWelcome(show: boolean) {
  document.getElementById("welcome")!.style.display = show ? "flex" : "none";
}

function updatePageDisplay() {
  const pages = viewport.getPages();
  if (pages.length === 0) return;
  const cur = viewport.getCurrentPage();
  document.getElementById("page-display")!.textContent = `${cur + 1} / ${pages.length}`;
}

async function openFile(file: File) {
  currentFilename = file.name;
  const buffer = await file.arrayBuffer();
  showWelcome(false);
  try {
    await viewport.openDocument(buffer);
    hasOpenDocument = true;
    undoManager.clear();
    updatePageDisplay();
    document.title = `${file.name} — PDF Canvas`;
  } catch (err: any) {
    alert(`Failed to open PDF: ${err.message}`);
    showWelcome(true);
  }
}

function openFilePicker() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".pdf,application/pdf";
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) openFile(file);
  };
  input.click();
}

function setupDragDrop(container: HTMLElement) {
  const root = document.documentElement;
  root.addEventListener("dragover", (e) => { e.preventDefault(); container.classList.add("drag-over"); });
  root.addEventListener("dragleave", (e) => { if (e.relatedTarget === null) container.classList.remove("drag-over"); });
  root.addEventListener("drop", (e) => {
    e.preventDefault();
    container.classList.remove("drag-over");
    const file = e.dataTransfer?.files[0];
    if (file && (file.type === "application/pdf" || file.name.endsWith(".pdf"))) {
      openFile(file);
    }
  });
}

// Expose for E2E testing
(window as any).__pdfCanvas = { openFile, saveFile, markDirty, isDirty: () => isDirty };

init();
