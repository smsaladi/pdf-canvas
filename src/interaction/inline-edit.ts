// Inline text editing for FreeText annotations
import type { InteractionContext } from "./context";

export function startInlineEdit(ctx: InteractionContext, annotId: string): void {
  ctx.cancelInlineEdit();

  const overlay = ctx.overlayElements.get(annotId);
  const annot = ctx.getAnnotationForId(annotId);
  if (!overlay || !annot || annot.type !== "FreeText") return;

  const editEl = document.createElement("div");
  editEl.className = "freetext-inline-edit";
  editEl.contentEditable = "true";
  editEl.style.position = "absolute";
  editEl.style.left = "0";
  editEl.style.top = "0";
  editEl.style.width = "100%";
  editEl.style.height = "100%";
  editEl.style.outline = "none";
  editEl.style.cursor = "text";
  editEl.style.overflow = "hidden";
  editEl.style.padding = "2px 4px";
  editEl.style.boxSizing = "border-box";
  editEl.style.color = "black";
  editEl.style.zIndex = "30";

  if (annot.defaultAppearance) {
    const da = annot.defaultAppearance;
    const scale = ctx.viewport.getScale();
    editEl.style.fontSize = `${da.size * scale}px`;
    const fontMap: Record<string, string> = { Helv: "sans-serif", TiRo: "serif", Cour: "monospace" };
    editEl.style.fontFamily = fontMap[da.font] || "sans-serif";
    if (da.color && da.color.length >= 3) {
      editEl.style.color = `rgb(${Math.round(da.color[0] * 255)}, ${Math.round(da.color[1] * 255)}, ${Math.round(da.color[2] * 255)})`;
    }
  }

  if (annot.contents) editEl.textContent = annot.contents;

  overlay.style.overflow = "visible";
  overlay.appendChild(editEl);

  const commitEdit = async () => {
    const text = editEl.textContent || "";
    cleanup();
    if (text !== (annot.contents || "")) {
      if (ctx.undoManager) {
        ctx.undoManager.push({ annotId, property: "contents", previousValue: annot.contents, newValue: text });
      }
      await ctx.viewport.getRpc().send({ type: "setAnnotContents", annotId, text });
      const pageIndex = parseInt(annotId.split("-")[0]);
      await ctx.viewport.rerenderPage(pageIndex);
    }
    ctx.onCreationDone?.();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      commitEdit();
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      commitEdit();
    }
    e.stopPropagation();
  };

  const cleanup = () => {
    editEl.removeEventListener("keydown", onKeyDown);
    editEl.remove();
    ctx.activeInlineEdit = null;
  };

  editEl.addEventListener("keydown", onKeyDown);

  ctx.activeInlineEdit = { annotId, el: editEl, cleanup };

  requestAnimationFrame(() => editEl.focus());
}

export async function cancelInlineEdit(ctx: InteractionContext): Promise<void> {
  if (!ctx.activeInlineEdit) return;
  const { annotId, el } = ctx.activeInlineEdit;
  const text = el.textContent || "";
  const annot = ctx.getAnnotationForId(annotId);
  el.remove();
  ctx.activeInlineEdit = null;

  if (annot && text !== (annot.contents || "")) {
    if (ctx.undoManager) {
      ctx.undoManager.push({ annotId, property: "contents", previousValue: annot.contents, newValue: text });
    }
    await ctx.viewport.getRpc().send({ type: "setAnnotContents", annotId, text });
    const pageIndex = parseInt(annotId.split("-")[0]);
    await ctx.viewport.rerenderPage(pageIndex);
  }
  ctx.onCreationDone?.();
}
