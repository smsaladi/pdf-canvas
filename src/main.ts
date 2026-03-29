// PDF Canvas — App entry point
// Wiring and initialization. Logic is in ./app/ sub-modules.

import { WorkerRPC } from "./worker-rpc";
import { Viewport } from "./viewport";
import { InteractionLayer } from "./interaction";
import { PropertiesPanel } from "./properties";
import { UndoManager } from "./undo";
import { Toolbar } from "./toolbar";
import { TextLayer } from "./text-layer";
import { SearchBar } from "./search";

import { app } from "./app/state";
import { markDirty, markClean, findWidget, showWelcome, updatePageDisplay, isEditingText } from "./app/utils";
import { applyPropertyChange, applyUndo } from "./app/property-mutations";
import { openFile, openFilePicker, saveFile, insertImage, setupDragDrop } from "./app/file-ops";
import { handleKeyDown } from "./app/keyboard";

function init() {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  const rpc = new WorkerRPC(worker);
  app.rpc = rpc;

  const viewportEl = document.getElementById("viewport")!;
  const viewport = new Viewport(viewportEl, rpc);
  app.viewport = viewport;

  const undoManager = new UndoManager(50);
  app.undoManager = undoManager;

  const textLayer = new TextLayer(viewport);
  app.textLayer = textLayer;

  const interaction = new InteractionLayer(viewport);
  interaction.undoManager = undoManager;
  interaction.textLayer = textLayer;
  app.interaction = interaction;

  const propsEl = document.getElementById("properties-panel")!;
  const properties = new PropertiesPanel(propsEl);
  app.properties = properties;

  // Wire selection → properties panel
  const fillTypes = new Set(["Square", "Circle", "Line", "FreeText"]);
  const fillColorWrap = document.querySelector<HTMLElement>("#toolbar-fill-color")?.closest(".color-picker-wrap") as HTMLElement | null;

  interaction.onSelectionChange((annotation) => {
    if (annotation) {
      if (annotation.type === "Widget" && annotation.id.startsWith("w")) {
        const widget = findWidget(annotation.id);
        if (widget) {
          properties.showWidget(widget);
          if (fillColorWrap) fillColorWrap.style.opacity = "0.3";
          return;
        }
      }
      if (annotation.type === "Image" && annotation.id.startsWith("img")) {
        properties.show(annotation);
        if (fillColorWrap) fillColorWrap.style.opacity = "0.3";
        return;
      }
      properties.show(annotation);
      if (fillColorWrap) {
        fillColorWrap.style.opacity = fillTypes.has(annotation.type) ? "" : "0.3";
        (fillColorWrap.querySelector("input") as HTMLInputElement).disabled = !fillTypes.has(annotation.type);
      }
    } else {
      properties.hide();
      if (fillColorWrap) {
        fillColorWrap.style.opacity = "";
        (fillColorWrap.querySelector("input") as HTMLInputElement).disabled = false;
      }
    }
  });

  // Toolbar
  const toolbar = new Toolbar();
  app.toolbar = toolbar;
  const drawingTools = new Set(["ink", "line", "rectangle", "circle", "highlight"]);
  toolbar.onChange((tool) => {
    interaction.setTool(tool);
    if (tool !== "select") interaction.select(null);
    if (drawingTools.has(tool)) {
      properties.showToolPanel(tool, interaction.getColor(), 2, 1.0);
    } else {
      properties.hideToolPanel();
    }
  });

  properties.onToolDefaultChange((prop, value) => {
    if (prop === "color") interaction.setColor(value);
    if (prop === "borderWidth") interaction.setBorderWidth(value);
  });
  interaction.onCreationDone = () => {
    toolbar.setTool("select");
    interaction.setTool("select");
  };

  // Wire text edit commits
  textLayer.onCommit(async (page, oldText, newText, selection, styleOverride) => {
    const selFontName = selection.chars[0]?.info.fontName || undefined;
    const lineContext = (selection as any)._lineContext || "";
    const selectionY = (selection as any)._selectionY;
    console.log(`[TextEdit] Replacing "${oldText}" → "${newText}" on page ${page} (font: ${selFontName || "unknown"}, y=${selectionY?.toFixed(1)}, line: "${lineContext.substring(0, 40)}")`);
    const response = await rpc.send({
      type: "replaceTextSmart", page, oldText, newText,
      boldOverride: styleOverride?.bold, italicOverride: styleOverride?.italic,
      fontName: selFontName, lineContext, selectionY,
    } as any);

    if (response.type === "textReplacedSmart") {
      if (response.count > 0) {
        console.log(`[TextEdit] ✓ Success via ${response.method}`);
        markDirty();
        viewport.clearTextCache(page);
        await viewport.rerenderPage(page);
      } else {
        console.warn(`[TextEdit] ✗ All methods failed for "${oldText}" on page ${page}. This PDF may use font encodings (Identity-H/CID) that prevent text replacement.`);
      }
    }
  });

  // Search bar (Ctrl+F)
  const searchBarEl = document.getElementById("search-bar")!;
  const searchBar = new SearchBar(searchBarEl, rpc, viewport);
  app.searchBar = searchBar;
  searchBar.onReplace(async (page, oldText, newText) => {
    markDirty();
    const response = await rpc.send({
      type: "replaceTextInStream", page, oldText, newText, replaceAll: true,
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
  fillColorInput.addEventListener("input", async () => {
    fillSwatch.style.backgroundColor = fillColorInput.value;
    const hex = fillColorInput.value;
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const rgb: [number, number, number] = [r, g, b];
    interaction.setFillColor(rgb);

    const selected = interaction.getSelectedAnnotation();
    if (selected && selected.interiorColor !== undefined) {
      undoManager.push({ annotId: selected.id, property: "interiorColor", previousValue: selected.interiorColor, newValue: rgb });
      markDirty();
      await rpc.send({ type: "setAnnotInteriorColor", annotId: selected.id, color: rgb });
      await viewport.rerenderPage(selected.page);
      const updated = interaction.getSelectedAnnotation();
      if (updated) properties.update(updated);
    }
  });
  fillSwatch.parentElement?.addEventListener("click", () => fillColorInput.click());

  // Line weight
  const lineWeightSelect = document.getElementById("toolbar-line-weight") as HTMLSelectElement;
  lineWeightSelect.addEventListener("change", async () => {
    const width = parseFloat(lineWeightSelect.value);
    interaction.setBorderWidth(width);

    const selected = interaction.getSelectedAnnotation();
    if (selected && selected.borderWidth !== undefined) {
      undoManager.push({ annotId: selected.id, property: "borderWidth", previousValue: selected.borderWidth, newValue: width });
      markDirty();
      await rpc.send({ type: "setAnnotBorderWidth", annotId: selected.id, width });
      await viewport.rerenderPage(selected.page);
      const updated = interaction.getSelectedAnnotation();
      if (updated) properties.update(updated);
    }
  });

  // Wire property changes → worker mutations
  properties.onChange(async (event) => {
    const { annotId, property, value, oldValue } = event;

    if (property === "delete") {
      await interaction.deleteSelected();
      return;
    }

    if (property === "widgetValue") {
      markDirty();
      await rpc.send({ type: "setWidgetValue", widgetId: annotId, value });
      const pageIndex = parseInt(annotId.replace("w", "").split("-")[0]);
      await viewport.rerenderPage(pageIndex);
      return;
    }

    undoManager.push({ annotId, property, previousValue: oldValue, newValue: value });
    markDirty();
    await applyPropertyChange(annotId, property, value);

    const annot = interaction.getSelectedAnnotation();
    if (annot) {
      await viewport.rerenderPage(annot.page);
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

  const fitBtn = document.getElementById("btn-fit-toggle")!;
  const fitWidthIcon = document.getElementById("fit-width-icon")!;
  const fitHeightIcon = document.getElementById("fit-height-icon")!;
  fitBtn.addEventListener("click", () => {
    const mode = fitBtn.dataset.fit;
    if (mode === "width") {
      viewport.fitToWidth();
      fitBtn.dataset.fit = "height";
      fitBtn.title = "Fit Height";
      fitWidthIcon.style.display = "none";
      fitHeightIcon.style.display = "";
    } else {
      viewport.fitToHeight();
      fitBtn.dataset.fit = "width";
      fitBtn.title = "Fit Width";
      fitWidthIcon.style.display = "";
      fitHeightIcon.style.display = "none";
    }
  });

  // Rotate counterclockwise
  document.getElementById("btn-rotate-ccw")!.addEventListener("click", async () => {
    if (!app.hasOpenDocument) return;
    const page = viewport.getCurrentPage();
    const response = await rpc.send({ type: "rotatePage", page, angle: -90 });
    if (response.type === "pageRotated") {
      viewport.updatePageInfo(page, response.info);
      await viewport.rerenderPage(page);
    }
  });

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

  // Space bar pan
  let isPanning = false;
  let panStart = { x: 0, y: 0, scrollLeft: 0, scrollTop: 0 };
  document.addEventListener("keydown", (e) => {
    if (e.key === " " && !isEditingText() && !isPanning) {
      e.preventDefault();
      isPanning = true;
      viewportEl.style.cursor = "grab";
      interaction.setTool("select");
    }
  });
  document.addEventListener("keyup", (e) => {
    if (e.key === " " && isPanning) {
      isPanning = false;
      viewportEl.style.cursor = "";
    }
  });
  viewportEl.addEventListener("pointerdown", (e) => {
    const handActive = isPanning || toolbar.getTool() === "hand";
    if (handActive) {
      e.preventDefault();
      e.stopPropagation();
      viewportEl.style.cursor = "grabbing";
      panStart = { x: e.clientX, y: e.clientY, scrollLeft: viewportEl.scrollLeft, scrollTop: viewportEl.scrollTop };
      const onMove = (ev: PointerEvent) => {
        viewportEl.scrollLeft = panStart.scrollLeft - (ev.clientX - panStart.x);
        viewportEl.scrollTop = panStart.scrollTop - (ev.clientY - panStart.y);
      };
      const onUp = () => {
        viewportEl.style.cursor = isPanning ? "grab" : "";
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    }
  }, true);

  // Warn before losing work
  window.addEventListener("beforeunload", (e) => {
    if (app.hasOpenDocument) e.preventDefault();
  });

  showWelcome(true);
}

// Expose for E2E testing
(window as any).__pdfCanvas = { openFile, saveFile, markDirty, isDirty: () => app.isDirty };

// Register service worker for PWA support
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

init();
