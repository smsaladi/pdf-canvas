// Property change dispatching and undo application
import { app, rpc, viewport, interaction, properties } from "./state";

export async function applyPropertyChange(annotId: string, property: string, value: any): Promise<void> {
  switch (property) {
    case "rect":
      await rpc().send({ type: "setAnnotRect", annotId, rect: value });
      break;
    case "color":
      await rpc().send({ type: "setAnnotColor", annotId, color: value });
      break;
    case "opacity":
      await rpc().send({ type: "setAnnotOpacity", annotId, opacity: value });
      break;
    case "contents":
      await rpc().send({ type: "setAnnotContents", annotId, text: value });
      break;
    case "icon":
      await rpc().send({ type: "setAnnotIcon", annotId, icon: value });
      break;
    case "borderWidth":
      await rpc().send({ type: "setAnnotBorderWidth", annotId, width: value });
      break;
    case "borderStyle":
      await rpc().send({ type: "setAnnotBorderStyle", annotId, style: value });
      break;
    case "interiorColor":
      await rpc().send({ type: "setAnnotInteriorColor", annotId, color: value });
      break;
    case "defaultAppearance":
      await rpc().send({ type: "setAnnotDefaultAppearance", annotId, font: value.font, size: value.size, color: value.color });
      break;
  }
}

export async function applyUndo(entry: { annotId: string; property: string; previousValue: any; newValue: any }, value: any): Promise<void> {
  const pageIndex = parseInt(entry.annotId.split("-")[0]);

  switch (entry.property) {
    case "rect":
      await rpc().send({ type: "setAnnotRect", annotId: entry.annotId, rect: value });
      break;
    case "quadPoints":
      await rpc().send({ type: "setAnnotQuadPoints", annotId: entry.annotId, quadPoints: value });
      break;
    case "color":
      await rpc().send({ type: "setAnnotColor", annotId: entry.annotId, color: value });
      break;
    case "opacity":
      await rpc().send({ type: "setAnnotOpacity", annotId: entry.annotId, opacity: value });
      break;
    case "contents":
      await rpc().send({ type: "setAnnotContents", annotId: entry.annotId, text: value });
      break;
    case "icon":
      await rpc().send({ type: "setAnnotIcon", annotId: entry.annotId, icon: value });
      break;
    case "borderWidth":
      await rpc().send({ type: "setAnnotBorderWidth", annotId: entry.annotId, width: value });
      break;
    case "borderStyle":
      await rpc().send({ type: "setAnnotBorderStyle", annotId: entry.annotId, style: value });
      break;
    case "interiorColor":
      await rpc().send({ type: "setAnnotInteriorColor", annotId: entry.annotId, color: value });
      break;
    case "defaultAppearance":
      await rpc().send({ type: "setAnnotDefaultAppearance", annotId: entry.annotId, font: value.font, size: value.size, color: value.color });
      break;
    case "delete": {
      const dto = entry.previousValue as import("../types").AnnotationDTO;
      await rpc().send({
        type: "createAnnot",
        page: dto.page,
        annotType: dto.type,
        rect: dto.rect,
        properties: dto,
      });
      break;
    }
    case "create": {
      if (value === null) {
        await rpc().send({ type: "deleteAnnot", annotId: entry.annotId });
      } else {
        const dto = value as import("../types").AnnotationDTO;
        await rpc().send({
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

  await viewport().rerenderPage(pageIndex);
  const updated = interaction().getSelectedAnnotation();
  if (updated) properties().update(updated);
}
