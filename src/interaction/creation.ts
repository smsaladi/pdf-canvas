// Annotation creation: SVG preview, point placement, finalization
import { screenToPdf } from "../coords";
import { TOOL_TO_ANNOT_TYPE } from "./constants";
import type { InteractionContext } from "./context";

export function colorToCSS(c: number[]): string {
  return `rgb(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)})`;
}

export function startCreation(ctx: InteractionContext, pageIndex: number, e: PointerEvent): void {
  const container = ctx.overlayContainers.get(pageIndex);
  if (!container) return;

  const rect = container.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  if (ctx.currentTool === "note") {
    createAnnotationAtPoint(ctx, pageIndex, x, y);
    return;
  }

  const preview = document.createElement("div");
  preview.className = "creation-preview";
  preview.style.left = "0px";
  preview.style.top = "0px";
  preview.style.width = `${container.clientWidth}px`;
  preview.style.height = `${container.clientHeight}px`;
  preview.style.border = "none";
  preview.style.background = "none";

  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.style.position = "absolute";
  svg.style.left = "0";
  svg.style.top = "0";
  svg.style.overflow = "visible";

  const strokeColor = colorToCSS(ctx.currentColor);
  const fillColor = ctx.currentFillColor ? colorToCSS(ctx.currentFillColor) : "none";
  const bw = ctx.currentBorderWidth;
  let shapeEl: SVGElement;

  switch (ctx.currentTool) {
    case "ink": {
      const path = document.createElementNS(NS, "path");
      path.setAttribute("d", `M${x},${y}`);
      path.setAttribute("stroke", strokeColor);
      path.setAttribute("stroke-width", String(bw));
      path.setAttribute("fill", "none");
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      shapeEl = path;
      break;
    }
    case "line": {
      const line = document.createElementNS(NS, "line");
      line.setAttribute("x1", String(x));
      line.setAttribute("y1", String(y));
      line.setAttribute("x2", String(x));
      line.setAttribute("y2", String(y));
      line.setAttribute("stroke", strokeColor);
      line.setAttribute("stroke-width", String(bw));
      line.setAttribute("stroke-linecap", "round");
      shapeEl = line;
      break;
    }
    case "circle": {
      const ellipse = document.createElementNS(NS, "ellipse");
      ellipse.setAttribute("cx", String(x));
      ellipse.setAttribute("cy", String(y));
      ellipse.setAttribute("rx", "0");
      ellipse.setAttribute("ry", "0");
      ellipse.setAttribute("stroke", strokeColor);
      ellipse.setAttribute("stroke-width", String(bw));
      ellipse.setAttribute("fill", fillColor);
      shapeEl = ellipse;
      break;
    }
    case "highlight": {
      const r = document.createElementNS(NS, "rect");
      r.setAttribute("x", String(x));
      r.setAttribute("y", String(y));
      r.setAttribute("width", "0");
      r.setAttribute("height", "0");
      r.setAttribute("fill", strokeColor);
      r.setAttribute("opacity", "0.35");
      shapeEl = r;
      break;
    }
    default: {
      const r = document.createElementNS(NS, "rect");
      r.setAttribute("x", String(x));
      r.setAttribute("y", String(y));
      r.setAttribute("width", "0");
      r.setAttribute("height", "0");
      r.setAttribute("stroke", strokeColor);
      r.setAttribute("stroke-width", String(bw));
      r.setAttribute("fill", fillColor);
      shapeEl = r;
      break;
    }
  }

  svg.appendChild(shapeEl);
  preview.appendChild(svg);
  container.appendChild(preview);

  ctx.creationState = {
    tool: ctx.currentTool,
    pageIndex,
    startScreenX: x,
    startScreenY: y,
    lastX: x,
    lastY: y,
    previewEl: preview,
    svgEl: svg,
    pathEl: shapeEl,
    inkPoints: ctx.currentTool === "ink" ? [[x, y]] : undefined,
  };

  e.preventDefault();
}

export function handleCreationMove(ctx: InteractionContext, e: PointerEvent): void {
  if (!ctx.creationState) return;

  const container = ctx.overlayContainers.get(ctx.creationState.pageIndex);
  if (!container) return;
  const rect = container.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const { startScreenX: sx, startScreenY: sy, pathEl, tool } = ctx.creationState;
  ctx.creationState.lastX = x;
  ctx.creationState.lastY = y;

  if (pathEl) {
    let cx = x, cy = y;

    switch (tool) {
      case "ink":
        if (ctx.creationState.inkPoints) {
          ctx.creationState.inkPoints.push([x, y]);
          const d = pathEl.getAttribute("d") || "";
          pathEl.setAttribute("d", d + `L${x},${y}`);
        }
        break;
      case "line":
        if (e.shiftKey) {
          const dx = x - sx, dy = y - sy;
          const angle = Math.atan2(dy, dx);
          const snapped = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
          const dist = Math.sqrt(dx * dx + dy * dy);
          cx = sx + Math.cos(snapped) * dist;
          cy = sy + Math.sin(snapped) * dist;
        }
        pathEl.setAttribute("x2", String(cx));
        pathEl.setAttribute("y2", String(cy));
        ctx.creationState.lastX = cx;
        ctx.creationState.lastY = cy;
        break;
      case "circle":
        if (e.shiftKey) {
          const size = Math.max(Math.abs(x - sx), Math.abs(y - sy));
          cx = sx + size * Math.sign(x - sx);
          cy = sy + size * Math.sign(y - sy);
        }
        pathEl.setAttribute("cx", String((sx + cx) / 2));
        pathEl.setAttribute("cy", String((sy + cy) / 2));
        pathEl.setAttribute("rx", String(Math.abs(cx - sx) / 2));
        pathEl.setAttribute("ry", String(Math.abs(cy - sy) / 2));
        ctx.creationState.lastX = cx;
        ctx.creationState.lastY = cy;
        break;
      default: {
        let w = Math.abs(x - sx), h = Math.abs(y - sy);
        if (e.shiftKey && tool === "rectangle") {
          const size = Math.max(w, h);
          w = size; h = size;
        }
        const rx = x < sx ? sx - w : sx;
        const ry = y < sy ? sy - h : sy;
        pathEl.setAttribute("x", String(rx));
        pathEl.setAttribute("y", String(ry));
        pathEl.setAttribute("width", String(w));
        pathEl.setAttribute("height", String(h));
        ctx.creationState.lastX = x < sx ? sx - w : sx + w;
        ctx.creationState.lastY = y < sy ? sy - h : sy + h;
        break;
      }
    }
  }
}

export async function createAnnotationAtPoint(ctx: InteractionContext, pageIndex: number, screenX: number, screenY: number): Promise<void> {
  const scale = ctx.viewport.getScale();
  const pdf = screenToPdf(screenX, screenY, { scale, pageOffsetX: 0, pageOffsetY: 0 });

  const rect: [number, number, number, number] = [pdf.x, pdf.y, pdf.x + 24, pdf.y + 24];

  const response = await ctx.viewport.getRpc().send({
    type: "createAnnot",
    page: pageIndex,
    annotType: "Text",
    rect,
    properties: {
      color: ctx.currentColor,
      icon: "Note",
      contents: "",
    } as any,
  });

  if (response.type === "annotCreated" && ctx.undoManager) {
    ctx.undoManager.push({
      annotId: response.annot.id,
      property: "create",
      previousValue: null,
      newValue: response.annot,
    });
  }

  await ctx.viewport.rerenderPage(pageIndex);

  if (response.type === "annotCreated") {
    ctx.select(response.annot.id);
  }
  ctx.onCreationDone?.();
}

export async function finishCreation(ctx: InteractionContext): Promise<void> {
  if (!ctx.creationState) return;
  const { tool, pageIndex, startScreenX, startScreenY, lastX, lastY, previewEl, inkPoints } = ctx.creationState;
  const endX = lastX;
  const endY = lastY;
  previewEl.remove();
  ctx.creationState = null;

  const scale = ctx.viewport.getScale();
  const transform = { scale, pageOffsetX: 0, pageOffsetY: 0 };

  const p1 = screenToPdf(Math.min(startScreenX, endX), Math.min(startScreenY, endY), transform);
  const p2 = screenToPdf(Math.max(startScreenX, endX), Math.max(startScreenY, endY), transform);

  if (Math.abs(p2.x - p1.x) < 3 && Math.abs(p2.y - p1.y) < 3) {
    if (tool === "freetext") {
      p2.x = p1.x + 200;
      p2.y = p1.y + 24;
    } else if (tool !== "ink") {
      return;
    }
  }

  const rect: [number, number, number, number] = [p1.x, p1.y, p2.x, p2.y];
  const annotType = TOOL_TO_ANNOT_TYPE[tool];
  if (!annotType) return;

  const properties: any = {};

  switch (tool) {
    case "freetext":
      properties.color = [];
      properties.borderWidth = 0;
      properties.defaultAppearance = { font: "Helv", size: 14, color: [0, 0, 0] };
      properties.contents = "";
      break;
    case "highlight":
      properties.color = ctx.currentColor;
      properties.opacity = 0.5;
      properties.quadPoints = [[p1.x, p1.y, p2.x, p1.y, p1.x, p2.y, p2.x, p2.y]];
      break;
    case "rectangle":
      properties.color = ctx.currentColor;
      properties.borderWidth = ctx.currentBorderWidth;
      if (ctx.currentFillColor) properties.interiorColor = ctx.currentFillColor;
      break;
    case "circle":
      properties.color = ctx.currentColor;
      properties.borderWidth = ctx.currentBorderWidth;
      if (ctx.currentFillColor) properties.interiorColor = ctx.currentFillColor;
      break;
    case "line": {
      properties.color = ctx.currentColor;
      properties.borderWidth = ctx.currentBorderWidth;
      const lineStart = screenToPdf(startScreenX, startScreenY, transform);
      const lineEnd = screenToPdf(endX, endY, transform);
      properties.line = [[lineStart.x, lineStart.y], [lineEnd.x, lineEnd.y]];
      break;
    }
    case "ink":
      properties.color = ctx.currentColor;
      properties.borderWidth = ctx.currentBorderWidth;
      if (inkPoints && inkPoints.length > 1) {
        const pdfPoints = inkPoints.map(([sx, sy]) => {
          const p = screenToPdf(sx, sy, transform);
          return [p.x, p.y] as [number, number];
        });
        properties.inkList = [pdfPoints];
      }
      break;
  }

  const response = await ctx.viewport.getRpc().send({
    type: "createAnnot",
    page: pageIndex,
    annotType,
    rect,
    properties,
  });

  if (response.type === "annotCreated" && ctx.undoManager) {
    ctx.undoManager.push({
      annotId: response.annot.id,
      property: "create",
      previousValue: null,
      newValue: response.annot,
    });
  }

  await ctx.viewport.rerenderPage(pageIndex);

  if (response.type === "annotCreated") {
    ctx.select(response.annot.id);

    if (tool === "freetext") {
      requestAnimationFrame(() => {
        ctx.startInlineEdit(response.annot.id);
      });
      return;
    }
  }
  ctx.onCreationDone?.();
}
