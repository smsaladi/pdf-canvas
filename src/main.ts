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
import { ThumbnailSidebar } from "./thumbnails";

import { app } from "./app/state";
import { markDirty, markClean, findWidget, showWelcome, updatePageDisplay, updateToolbarState, isEditingText } from "./app/utils";
import { applyPropertyChange, applyUndo } from "./app/property-mutations";
import { openFile, openFilePicker, saveFile, insertImage, setupDragDrop, createBlankCanvas, scanWithCamera } from "./app/file-ops";
import { handleKeyDown } from "./app/keyboard";
import { saveSession, loadSession, clearSession } from "./app/session-db";

function init() {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  const rpc = new WorkerRPC(worker);
  app.rpc = rpc;

  const viewportEl = document.getElementById("viewport")!;
  const viewport = new Viewport(viewportEl, rpc);
  app.viewport = viewport;

  // Thumbnail sidebar
  const thumbSidebar = new ThumbnailSidebar(
    document.getElementById("thumbnail-sidebar")!,
    viewport,
    rpc
  );

  const undoManager = new UndoManager(50);
  app.undoManager = undoManager;
  thumbSidebar.undoManager = undoManager;

  const textLayer = new TextLayer(viewport);
  app.textLayer = textLayer;

  const interaction = new InteractionLayer(viewport);
  interaction.undoManager = undoManager;
  interaction.textLayer = textLayer;
  app.interaction = interaction;

  const propsEl = document.getElementById("properties-panel")!;
  const properties = new PropertiesPanel(propsEl);
  properties.undoManager = undoManager;
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
  const borderIconRect = document.querySelector(".border-icon-rect") as SVGElement | null;
  const borderIconSlash = document.querySelector(".border-icon-slash") as SVGElement | null;
  const fillIconRect = document.querySelector(".fill-icon-rect") as SVGElement | null;

  const updateBorderIcon = (hex: string) => {
    colorSwatch.style.backgroundColor = hex;
    borderIconRect?.setAttribute("stroke", hex);
    borderIconSlash?.setAttribute("stroke", hex);
  };
  const updateFillIcon = (hex: string) => {
    fillSwatch.style.backgroundColor = hex;
    fillIconRect?.setAttribute("fill", hex);
  };

  updateBorderIcon(colorInput.value);
  colorInput.addEventListener("input", async () => {
    updateBorderIcon(colorInput.value);
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
  updateFillIcon(fillColorInput.value);
  fillColorInput.addEventListener("input", async () => {
    updateFillIcon(fillColorInput.value);
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

    if (property === "exportImage" && annotId.startsWith("img")) {
      const page = parseInt(annotId.split("-")[0].replace("img", ""));
      const imageIndex = parseInt(annotId.split("-")[1]);
      const response = await rpc.send({ type: "exportImage", page, imageIndex });
      if (response.type === "imageExported") {
        const canvas = document.createElement("canvas");
        canvas.width = response.width;
        canvas.height = response.height;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(response.bitmap, 0, 0);
        canvas.toBlob((blob) => {
          if (!blob) return;
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `image-page${page + 1}-${imageIndex + 1}.png`;
          a.click();
          URL.revokeObjectURL(url);
        }, "image/png");
      }
      return;
    }

    if (property === "reorderImage" && annotId.startsWith("img")) {
      const page = parseInt(annotId.split("-")[0].replace("img", ""));
      const imageIndex = parseInt(annotId.split("-")[1]);
      await rpc.send({ type: "reorderImage", page, imageIndex, direction: value } as any);
      markDirty();
      await viewport.rerenderPage(page);
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

  // Zoom input
  const zoomInput = document.getElementById("zoom-input") as HTMLInputElement;
  viewport.setZoomDisplay(zoomInput);
  zoomInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const val = parseInt(zoomInput.value.replace("%", ""), 10);
      if (!isNaN(val) && val > 0) viewport.setZoom(val / 100);
      zoomInput.blur();
    } else if (e.key === "Escape") {
      zoomInput.blur();
    }
  });
  zoomInput.addEventListener("focus", () => {
    zoomInput.value = zoomInput.value.replace("%", "");
    zoomInput.select();
  });
  zoomInput.addEventListener("blur", () => {
    zoomInput.value = `${Math.round(viewport.getZoom() * 100)}%`;
  });

  // File buttons
  document.getElementById("btn-open")!.addEventListener("click", openFilePicker);
  document.getElementById("btn-save")!.addEventListener("click", saveFile);
  document.getElementById("btn-insert-image")!.addEventListener("click", insertImage);

  // Properties panel toggle
  const propsPanel = document.getElementById("properties-panel")!;
  const propsToggle = document.getElementById("btn-toggle-props")!;
  document.getElementById("btn-close-props")!.addEventListener("click", () => {
    propsPanel.classList.add("hidden");
    propsToggle.classList.add("visible");
  });
  propsToggle.addEventListener("click", () => {
    propsPanel.classList.remove("hidden");
    propsToggle.classList.remove("visible");
  });

  // Thumbnail sidebar toggle
  const thumbSidebarEl = document.getElementById("thumbnail-sidebar")!;
  const thumbToggle = document.getElementById("btn-toggle-thumbs")!;
  thumbToggle.addEventListener("click", () => {
    thumbSidebarEl.classList.remove("hidden");
    thumbToggle.classList.remove("visible");
  });
  document.getElementById("btn-welcome-open")?.addEventListener("click", openFilePicker);
  document.getElementById("btn-welcome-new")?.addEventListener("click", () => createBlankCanvas());
  document.getElementById("btn-welcome-scan")?.addEventListener("click", () => scanWithCamera());
  document.getElementById("btn-scan")!.addEventListener("click", () => scanWithCamera());
  // Click anywhere on welcome area to open file picker
  document.getElementById("welcome")?.addEventListener("click", (e) => {
    // Don't trigger if clicking a button (they have their own handlers)
    if ((e.target as HTMLElement).closest("button")) return;
    openFilePicker();
  });
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
  document.getElementById("btn-history")!.addEventListener("click", () => {
    properties.showHistory();
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

  // Page input: type a number and press Enter to jump to that page
  const pageInput = document.getElementById("page-input") as HTMLInputElement;
  pageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const val = parseInt(pageInput.value, 10);
      const pages = viewport.getPages();
      if (!isNaN(val) && val >= 1 && val <= pages.length) {
        viewport.scrollToPage(val - 1);
      }
      pageInput.blur();
      updatePageDisplay();
    } else if (e.key === "Escape") {
      pageInput.blur();
      updatePageDisplay();
    }
  });
  pageInput.addEventListener("focus", () => pageInput.select());

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

  // Try to restore session from IndexedDB (persists across Ctrl+R)
  loadSession().then(async (session) => {
    if (session) {
      try {
        app.currentFilename = session.filename;
        showWelcome(false);
        await viewport.openDocument(session.pdfBuffer);
        app.hasOpenDocument = true;
        undoManager.clear();
        if (session.zoom) viewport.setZoom(session.zoom);
        if (session.currentPage) viewport.scrollToPage(session.currentPage);
        updatePageDisplay();
        updateToolbarState();
        document.title = `${session.filename} — PDF Canvas`;
        console.log(`[Session] Restored "${session.filename}" from IndexedDB`);
        return;
      } catch (err) {
        console.warn("[Session] Failed to restore, clearing bad session:", err);
        clearSession();
        showWelcome(true);
      }
    }
    showWelcome(true);
    updatePageDisplay();
  });

  // Auto-save to IndexedDB on mutations (debounced 2s)
  let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleAutoSave = () => {
    if (!app.hasOpenDocument) return;
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(async () => {
      try {
        const response = await rpc.send({ type: "save", options: "incremental" });
        if (response.type === "saved") {
          await saveSession(
            response.buffer,
            app.currentFilename,
            viewport.getCurrentPage(),
            viewport.getZoom(),
          );
        }
      } catch (err) {
        console.warn("[Session] Auto-save failed:", err);
      }
    }, 2000);
  };
  undoManager.onChange(() => {
    btnUndo.disabled = !undoManager.canUndo();
    btnRedo.disabled = !undoManager.canRedo();
    markDirty();
    scheduleAutoSave();
    properties.refreshHistory();
  });

  // --- JS-based toolbar tooltips (positioned to stay on-screen) ---
  const tooltip = document.createElement("div");
  tooltip.className = "toolbar-tooltip";
  document.body.appendChild(tooltip);
  let tooltipTimeout: ReturnType<typeof setTimeout> | null = null;

  const toolbarEl = document.getElementById("toolbar")!;
  toolbarEl.addEventListener("pointerenter", (e) => {
    const btn = (e.target as HTMLElement).closest("[title]") as HTMLElement | null;
    if (!btn || !btn.title) return;
    const text = btn.title;
    // Suppress native tooltip by moving title to data attr
    btn.dataset.tip = text;
    btn.removeAttribute("title");

    if (tooltipTimeout) clearTimeout(tooltipTimeout);
    tooltipTimeout = setTimeout(() => {
      tooltip.textContent = text;
      tooltip.classList.add("visible");
      const rect = btn.getBoundingClientRect();
      const tipW = tooltip.offsetWidth;
      let left = rect.left + rect.width / 2 - tipW / 2;
      // Clamp to viewport
      left = Math.max(4, Math.min(left, window.innerWidth - tipW - 4));
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${rect.bottom + 6}px`;
    }, 400);
  }, true);

  toolbarEl.addEventListener("pointerleave", (e) => {
    const btn = (e.target as HTMLElement).closest("[data-tip]") as HTMLElement | null;
    if (btn?.dataset.tip) {
      btn.title = btn.dataset.tip;
      delete btn.dataset.tip;
    }
    if (tooltipTimeout) { clearTimeout(tooltipTimeout); tooltipTimeout = null; }
    tooltip.classList.remove("visible");
  }, true);
}

// Expose for E2E testing
(window as any).__pdfCanvas = { openFile, saveFile, markDirty, isDirty: () => app.isDirty };

// Register service worker for PWA support
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

init();
