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
  const pages = viewport().getPages();
  if (pages.length === 0) return;
  const cur = viewport().getCurrentPage();
  const pageInput = document.getElementById("page-input") as HTMLInputElement | null;
  const pageTotal = document.getElementById("page-total");
  if (pageInput && document.activeElement !== pageInput) {
    pageInput.value = String(cur + 1);
  }
  if (pageTotal) pageTotal.textContent = String(pages.length);
}
