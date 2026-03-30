// Worker handlers: annotation CRUD, widget operations
import * as mupdf from "mupdf";
import type { WorkerResponse } from "../types";
import { getDoc } from "./doc-state";
import { getAnnotations, resolveAnnot, resolveWidget } from "./helpers";

type Respond = (rpcId: number | undefined, response: WorkerResponse, transfer?: Transferable[]) => void;

export function handleGetAnnotations(request: any, respond: Respond, rpcId: number | undefined) {
  respond(rpcId, { type: "annotations", page: request.page, annots: getAnnotations(request.page) });
}

export function handleGetWidgets(request: any, respond: Respond, rpcId: number | undefined) {
  const page = getDoc().loadPage(request.page) as mupdf.PDFPage;
  const widgets = page.getWidgets();
  const dtos: import("../types").WidgetDTO[] = widgets.map((w, i) => ({
    id: `w${request.page}-${i}`, page: request.page,
    fieldType: w.getFieldType(), fieldName: w.getName() || `field_${i}`,
    value: w.getValue() || "", rect: w.getRect(),
  }));
  respond(rpcId, { type: "widgets", page: request.page, widgets: dtos });
}

export function handleSetAnnotRect(request: any, respond: Respond, rpcId: number | undefined) {
  if (request.annotId.startsWith("w")) {
    const { widget } = resolveWidget(request.annotId);
    widget.setRect(request.rect); widget.update();
    respond(rpcId, { type: "annotUpdated", annotId: request.annotId }); return;
  }
  const { annot } = resolveAnnot(request.annotId);
  const type = annot.getType();
  if (type === "Line" && annot.hasLine()) {
    const oldLine = annot.getLine();
    const dx = request.rect[0] - annot.getBounds()[0];
    const dy = request.rect[1] - annot.getBounds()[1];
    annot.setLine([oldLine[0][0] + dx, oldLine[0][1] + dy] as any, [oldLine[1][0] + dx, oldLine[1][1] + dy] as any);
  } else if (type === "Ink" && annot.hasInkList()) {
    const oldInk = annot.getInkList();
    const dx = request.rect[0] - annot.getBounds()[0];
    const dy = request.rect[1] - annot.getBounds()[1];
    annot.setInkList(oldInk.map(stroke => stroke.map(pt => [pt[0] + dx, pt[1] + dy] as mupdf.Point)));
  } else { annot.setRect(request.rect); }
  touchAndUpdate(annot);
  respond(rpcId, { type: "annotUpdated", annotId: request.annotId });
}

// Helper: update modification date + call update()
function touchAndUpdate(annot: mupdf.PDFAnnotation) {
  try { annot.setModificationDate(new Date()); } catch {}
  annot.update();
}

// Simple property setters — each resolves the annotation, sets one property, updates, responds
export function handleSetAnnotColor(request: any, respond: Respond, rpcId: number | undefined) { const { annot } = resolveAnnot(request.annotId); annot.setColor(request.color as mupdf.AnnotColor); touchAndUpdate(annot); respond(rpcId, { type: "annotUpdated", annotId: request.annotId }); }
export function handleSetAnnotContents(request: any, respond: Respond, rpcId: number | undefined) { const { annot } = resolveAnnot(request.annotId); annot.setContents(request.text); touchAndUpdate(annot); respond(rpcId, { type: "annotUpdated", annotId: request.annotId }); }
export function handleSetAnnotOpacity(request: any, respond: Respond, rpcId: number | undefined) { const { annot } = resolveAnnot(request.annotId); annot.setOpacity(request.opacity); touchAndUpdate(annot); respond(rpcId, { type: "annotUpdated", annotId: request.annotId }); }
export function handleSetAnnotBorderWidth(request: any, respond: Respond, rpcId: number | undefined) { const { annot } = resolveAnnot(request.annotId); annot.setBorderWidth(request.width); touchAndUpdate(annot); respond(rpcId, { type: "annotUpdated", annotId: request.annotId }); }
export function handleSetAnnotBorderStyle(request: any, respond: Respond, rpcId: number | undefined) { const { annot } = resolveAnnot(request.annotId); annot.setBorderStyle(request.style as mupdf.PDFAnnotationBorderStyle); touchAndUpdate(annot); respond(rpcId, { type: "annotUpdated", annotId: request.annotId }); }
export function handleSetAnnotInteriorColor(request: any, respond: Respond, rpcId: number | undefined) { const { annot } = resolveAnnot(request.annotId); annot.setInteriorColor(request.color as mupdf.AnnotColor); touchAndUpdate(annot); respond(rpcId, { type: "annotUpdated", annotId: request.annotId }); }
export function handleSetAnnotDefaultAppearance(request: any, respond: Respond, rpcId: number | undefined) { const { annot } = resolveAnnot(request.annotId); annot.setDefaultAppearance(request.font, request.size, request.color as mupdf.AnnotColor); touchAndUpdate(annot); respond(rpcId, { type: "annotUpdated", annotId: request.annotId }); }
export function handleSetAnnotIcon(request: any, respond: Respond, rpcId: number | undefined) { const { annot } = resolveAnnot(request.annotId); annot.setIcon(request.icon); touchAndUpdate(annot); respond(rpcId, { type: "annotUpdated", annotId: request.annotId }); }
export function handleSetAnnotQuadPoints(request: any, respond: Respond, rpcId: number | undefined) { const { annot } = resolveAnnot(request.annotId); annot.setQuadPoints(request.quadPoints as mupdf.Quad[]); touchAndUpdate(annot); respond(rpcId, { type: "annotUpdated", annotId: request.annotId }); }

export function handleDeleteAnnot(request: any, respond: Respond, rpcId: number | undefined) {
  const { page, annot } = resolveAnnot(request.annotId);
  page.deleteAnnotation(annot);
  respond(rpcId, { type: "annotDeleted", annotId: request.annotId });
}

export function handleSetWidgetValue(request: any, respond: Respond, rpcId: number | undefined) {
  const { widget } = resolveWidget(request.widgetId);
  if (widget.isText()) widget.setTextValue(request.value);
  else if (widget.isChoice()) widget.setChoiceValue(request.value);
  widget.update();
  respond(rpcId, { type: "annotUpdated", annotId: request.widgetId });
}

export function handleCreateAnnot(request: any, respond: Respond, rpcId: number | undefined) {
  const page = getDoc().loadPage(request.page) as mupdf.PDFPage;
  const annot = page.createAnnotation(request.annotType as mupdf.PDFAnnotationType);
  const noRectTypes = new Set(["Highlight", "Underline", "StrikeOut", "Squiggly", "Line", "Ink", "Polygon", "PolyLine"]);
  if (!noRectTypes.has(request.annotType)) annot.setRect(request.rect);

  const props = request.properties;
  if (props) {
    if (props.color !== undefined) annot.setColor(props.color as mupdf.AnnotColor);
    if (props.opacity !== undefined) annot.setOpacity(props.opacity);
    if (props.contents) annot.setContents(props.contents);
    if (props.icon && annot.hasIcon()) annot.setIcon(props.icon);
    if (props.borderWidth !== undefined && annot.hasBorder()) annot.setBorderWidth(props.borderWidth);
    if (props.borderStyle && annot.hasBorder()) annot.setBorderStyle(props.borderStyle as mupdf.PDFAnnotationBorderStyle);
    if (props.interiorColor && annot.hasInteriorColor()) annot.setInteriorColor(props.interiorColor as mupdf.AnnotColor);
    if (props.quadPoints) { try { annot.setQuadPoints(props.quadPoints as mupdf.Quad[]); } catch {} }
    if (props.defaultAppearance && request.annotType === "FreeText") {
      annot.setDefaultAppearance(props.defaultAppearance.font, props.defaultAppearance.size, props.defaultAppearance.color as mupdf.AnnotColor);
    }
    if (props.inkList) { try { annot.setInkList(props.inkList as mupdf.Point[][]); } catch {} }
    if (props.line) { try { annot.setLine(props.line[0] as mupdf.Point, props.line[1] as mupdf.Point); } catch {} }
    if (props.author) annot.setAuthor(props.author);
  }
  // Set creation/modification dates
  const now = new Date();
  try { annot.setCreationDate(now); } catch {}
  try { annot.setModificationDate(now); } catch {}

  annot.update();
  const created = getAnnotations(request.page).at(-1)!;
  respond(rpcId, { type: "annotCreated", annot: created });
}
