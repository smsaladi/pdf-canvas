// Small utility functions shared across app modules
import { app, viewport } from "./state";

export function markDirty(): void {
  if (!app.isDirty && app.hasOpenDocument) {
    app.isDirty = true;
    document.title = `* ${app.currentFilename} — PDF Canvas`;
  }
}

export function markClean(): void {
  app.isDirty = false;
  if (app.hasOpenDocument) {
    document.title = `${app.currentFilename} — PDF Canvas`;
  }
}

export function isEditingText(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLTextAreaElement
    || active instanceof HTMLInputElement
    || (active instanceof HTMLElement && active.contentEditable === "true");
}

export function findWidget(widgetId: string): import("../types").WidgetDTO | null {
  for (const page of viewport().getPages()) {
    const widgets = viewport().getWidgets(page.index);
    const found = widgets.find((w) => w.id === widgetId);
    if (found) return found;
  }
  return null;
}

export function showWelcome(show: boolean): void {
  document.getElementById("welcome")!.style.display = show ? "flex" : "none";
}

export function updatePageDisplay(): void {
  const hasDoc = app.hasOpenDocument;
  const pages = hasDoc ? viewport().getPages() : [];
  const cur = pages.length > 0 ? viewport().getCurrentPage() : -1;
  const pageInput = document.getElementById("page-input") as HTMLInputElement | null;
  const pageTotal = document.getElementById("page-total");
  if (pageInput && document.activeElement !== pageInput) {
    pageInput.value = pages.length > 0 ? String(cur + 1) : "0";
  }
  if (pageTotal) pageTotal.textContent = String(pages.length);

  // Update navigation button states
  const btnPrev = document.getElementById("btn-prev-page") as HTMLButtonElement | null;
  const btnNext = document.getElementById("btn-next-page") as HTMLButtonElement | null;
  if (btnPrev) btnPrev.disabled = !hasDoc || cur <= 0;
  if (btnNext) btnNext.disabled = !hasDoc || cur >= pages.length - 1;

  updateToolbarState();
}

export function updateToolbarState(): void {
  const hasDoc = app.hasOpenDocument;
  const pages = hasDoc ? viewport().getPages() : [];

  // Buttons that require an open document
  const docButtons = ["btn-save", "btn-zoom-in", "btn-zoom-out", "btn-fit-toggle", "btn-rotate-ccw", "btn-insert-image"];
  for (const id of docButtons) {
    const btn = document.getElementById(id) as HTMLButtonElement | null;
    if (btn) btn.disabled = !hasDoc;
  }

  // Page input and zoom input
  const pageInput = document.getElementById("page-input") as HTMLInputElement | null;
  const zoomInput = document.getElementById("zoom-input") as HTMLInputElement | null;
  if (pageInput) pageInput.disabled = !hasDoc || pages.length === 0;
  if (zoomInput) zoomInput.disabled = !hasDoc;
}
