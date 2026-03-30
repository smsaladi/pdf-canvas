// Keyboard shortcut handler
import { app, rpc, viewport, interaction, undoManager, toolbar } from "./state";
import { isEditingText, markDirty } from "./utils";
import { applyUndo } from "./property-mutations";
import { openFilePicker, saveFile } from "./file-ops";

let clipboardAnnot: import("../types").AnnotationDTO | null = null;
let clipboardAnnots: import("../types").AnnotationDTO[] = [];

export async function handleKeyDown(e: KeyboardEvent): Promise<void> {
  // Escape: deselect
  if (e.key === "Escape" && interaction().getSelectedId()) {
    if (isEditingText()) return;
    e.preventDefault();
    interaction().select(null);
    return;
  }

  // Delete selected annotation
  if ((e.key === "Delete" || e.key === "Backspace") && interaction().getSelectedId()) {
    if (isEditingText()) return;
    e.preventDefault();
    await interaction().deleteSelected();
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
    if (app.hasOpenDocument) app.searchBar!.show();
    return;
  }

  // Undo: Ctrl+Z
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === "z") {
    e.preventDefault();
    const entry = undoManager().undo();
    if (entry) await applyUndo(entry, entry.previousValue);
    return;
  }

  // Redo: Ctrl+Shift+Z or Ctrl+Y
  if ((e.ctrlKey || e.metaKey) && (e.shiftKey && e.key === "z" || e.key === "y")) {
    e.preventDefault();
    const entry = undoManager().redo();
    if (entry) await applyUndo(entry, entry.newValue);
    return;
  }

  // Save: Ctrl+S
  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    e.preventDefault();
    await saveFile();
    return;
  }

  // History: Ctrl+H
  if ((e.ctrlKey || e.metaKey) && e.key === "h") {
    e.preventDefault();
    app.properties?.showHistory();
    return;
  }

  // Tool shortcuts (single key, no modifier, not while editing text)
  if (!e.ctrlKey && !e.metaKey && !e.altKey && !isEditingText()) {
    const toolKeys: Record<string, import("../toolbar").ToolMode> = {
      v: "select", p: "hand", t: "textedit", n: "note", f: "freetext",
      h: "highlight", r: "rectangle", c: "circle", l: "line", d: "ink",
    };
    const tool = toolKeys[e.key.toLowerCase()];
    if (tool) {
      e.preventDefault();
      toolbar().setTool(tool);
      return;
    }
  }

  // Duplicate: Ctrl+D
  if ((e.ctrlKey || e.metaKey) && e.key === "d") {
    e.preventDefault();
    if (interaction().getSelectedId()) {
      await duplicateSelected();
    }
    return;
  }

  // Copy: Ctrl+C (annotation, not text)
  if ((e.ctrlKey || e.metaKey) && e.key === "c" && !isEditingText()) {
    const allSelected = interaction().getSelectedAnnotations();
    if (allSelected.length > 0) {
      e.preventDefault();
      clipboardAnnot = allSelected.length === 1 ? { ...allSelected[0] } : { ...allSelected[0] };
      clipboardAnnots = allSelected.map(a => ({ ...a }));
    }
    return;
  }

  // Paste: Ctrl+V (annotation)
  if ((e.ctrlKey || e.metaKey) && e.key === "v" && !isEditingText() && clipboardAnnot) {
    e.preventDefault();
    await pasteAnnotation();
    return;
  }

  // Tab: cycle through annotations
  if (e.key === "Tab" && !isEditingText() && app.hasOpenDocument) {
    e.preventDefault();
    const page = viewport().getCurrentPage();
    const annots = viewport().getAnnotations(page);
    if (annots.length === 0) return;
    const currentId = interaction().getSelectedId();
    const currentIdx = currentId ? annots.findIndex(a => a.id === currentId) : -1;
    const nextIdx = e.shiftKey
      ? (currentIdx <= 0 ? annots.length - 1 : currentIdx - 1)
      : (currentIdx + 1) % annots.length;
    interaction().select(annots[nextIdx].id);
    return;
  }

  // Arrow keys: nudge selected annotation (1pt, or 10pt with Shift)
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key) && interaction().getSelectedId()) {
    if (isEditingText()) return;
    e.preventDefault();
    const annot = interaction().getSelectedAnnotation();
    if (!annot) return;

    const step = e.shiftKey ? 10 : 1;
    let dx = 0, dy = 0;
    if (e.key === "ArrowLeft") dx = -step;
    if (e.key === "ArrowRight") dx = step;
    if (e.key === "ArrowUp") dy = -step;
    if (e.key === "ArrowDown") dy = step;

    const newRect: [number, number, number, number] = [
      annot.rect[0] + dx, annot.rect[1] + dy,
      annot.rect[2] + dx, annot.rect[3] + dy,
    ];

    undoManager().push({ annotId: annot.id, property: "rect", previousValue: annot.rect, newValue: newRect });
    await rpc().send({ type: "setAnnotRect", annotId: annot.id, rect: newRect });
    await viewport().rerenderPage(annot.page);
    return;
  }
}

async function duplicateSelected(): Promise<void> {
  const annot = interaction().getSelectedAnnotation();
  if (!annot) return;
  const offset = 10;
  const newRect: [number, number, number, number] = [
    annot.rect[0] + offset, annot.rect[1] + offset,
    annot.rect[2] + offset, annot.rect[3] + offset,
  ];
  const response = await rpc().send({
    type: "createAnnot", page: annot.page, annotType: annot.type, rect: newRect,
    properties: { ...annot, rect: newRect },
  });
  if (response.type === "annotCreated") {
    undoManager().push({ annotId: response.annot.id, property: "create", previousValue: null, newValue: response.annot });
    markDirty();
    await viewport().rerenderPage(annot.page);
    interaction().select(response.annot.id);
  }
}

async function pasteAnnotation(): Promise<void> {
  if (!clipboardAnnot) return;
  const page = viewport().getCurrentPage();
  const offset = 10;
  const newRect: [number, number, number, number] = [
    clipboardAnnot.rect[0] + offset, clipboardAnnot.rect[1] + offset,
    clipboardAnnot.rect[2] + offset, clipboardAnnot.rect[3] + offset,
  ];
  const response = await rpc().send({
    type: "createAnnot", page, annotType: clipboardAnnot.type, rect: newRect,
    properties: { ...clipboardAnnot, rect: newRect, page },
  });
  if (response.type === "annotCreated") {
    undoManager().push({ annotId: response.annot.id, property: "create", previousValue: null, newValue: response.annot });
    markDirty();
    await viewport().rerenderPage(page);
    interaction().select(response.annot.id);
  }
}
