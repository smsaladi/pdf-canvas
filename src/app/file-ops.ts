// File operations: open, save, insert image, drag-drop
import { app, rpc, viewport, interaction, undoManager } from "./state";
import { markDirty, markClean, updatePageDisplay, showWelcome } from "./utils";
import { saveSession, clearSession } from "./session-db";

export async function openFile(file: File): Promise<void> {
  app.currentFilename = file.name;
  const buffer = await file.arrayBuffer();
  showWelcome(false);
  try {
    await viewport().openDocument(buffer);
    app.hasOpenDocument = true;
    undoManager().clear();
    viewport().fitToWidth();
    updatePageDisplay();
    document.title = `${file.name} — PDF Canvas`;
    // Persist to IndexedDB for session restore on Ctrl+R
    saveSession(buffer, file.name, 0, viewport().getZoom()).catch(() => {});
  } catch (err: any) {
    alert(`Failed to open PDF: ${err.message}`);
    showWelcome(true);
  }
}

export function openFilePicker(): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".pdf,application/pdf";
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) openFile(file);
  };
  input.click();
}

export async function createBlankCanvas(): Promise<void> {
  app.currentFilename = "untitled.pdf";
  showWelcome(false);
  try {
    const response = await rpc().send({ type: "createBlankDocument" });
    if (response.type === "opened") {
      app.hasOpenDocument = true;
      viewport().handleOpenResponse(response);
      undoManager().clear();
      viewport().fitToWidth();
      updatePageDisplay();
      document.title = "Untitled — PDF Canvas";
      // Session will be saved on next auto-save trigger
    }
  } catch (err: any) {
    alert(`Failed to create blank canvas: ${err.message}`);
    showWelcome(true);
  }
}

export async function saveFile(): Promise<void> {
  if (!app.hasOpenDocument) return;
  const response = await rpc().send({ type: "save", options: "incremental" });
  if (response.type === "saved") {
    const blob = new Blob([response.buffer], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = app.currentFilename;
    a.click();
    URL.revokeObjectURL(url);
    markClean();
  }
}

export async function insertImage(): Promise<void> {
  if (!app.hasOpenDocument) return;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/png,image/jpeg,image/gif,image/webp";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;

    const buffer = await file.arrayBuffer();
    const page = viewport().getCurrentPage();
    const pageInfo = viewport().getPages()[page];

    const blob = new Blob([buffer.slice(0)], { type: file.type });
    const imgUrl = URL.createObjectURL(blob);
    const img = new Image();
    await new Promise<void>((resolve) => { img.onload = () => resolve(); img.src = imgUrl; });
    URL.revokeObjectURL(imgUrl);

    const maxW = 300;
    const maxH = 400;
    let w = img.naturalWidth * 0.75;
    let h = img.naturalHeight * 0.75;
    if (w > maxW) { h *= maxW / w; w = maxW; }
    if (h > maxH) { w *= maxH / h; h = maxH; }

    const cx = pageInfo.width / 2;
    const cy = pageInfo.height / 2;
    const rect: [number, number, number, number] = [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];

    console.log(`[Image] Inserting image "${file.name}" on page ${page}`);
    const response = await rpc().send(
      { type: "addImage", page, rect, imageData: buffer, mimeType: file.type },
      [buffer]
    );

    if (response.type === "annotCreated") {
      console.log(`[Image] ✓ Image added as Stamp annotation`);
      markDirty();
      await viewport().rerenderPage(page);
      interaction().select(response.annot.id);
    }
  };
  input.click();
}

export function setupDragDrop(container: HTMLElement): void {
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
