// PDF ↔ screen coordinate conversions

export interface ViewportTransform {
  scale: number;
  pageOffsetX: number;
  pageOffsetY: number;
}

export function pdfToScreen(
  pdfX: number,
  pdfY: number,
  transform: ViewportTransform
): { x: number; y: number } {
  return {
    x: pdfX * transform.scale + transform.pageOffsetX,
    y: pdfY * transform.scale + transform.pageOffsetY,
  };
}

export function screenToPdf(
  screenX: number,
  screenY: number,
  transform: ViewportTransform
): { x: number; y: number } {
  return {
    x: (screenX - transform.pageOffsetX) / transform.scale,
    y: (screenY - transform.pageOffsetY) / transform.scale,
  };
}

export function pdfRectToScreenRect(
  rect: [number, number, number, number],
  transform: ViewportTransform
): { x: number; y: number; width: number; height: number } {
  const topLeft = pdfToScreen(rect[0], rect[1], transform);
  const bottomRight = pdfToScreen(rect[2], rect[3], transform);
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: bottomRight.x - topLeft.x,
    height: bottomRight.y - topLeft.y,
  };
}

export function screenRectToPdfRect(
  x: number,
  y: number,
  width: number,
  height: number,
  transform: ViewportTransform
): [number, number, number, number] {
  const topLeft = screenToPdf(x, y, transform);
  const bottomRight = screenToPdf(x + width, y + height, transform);
  return [topLeft.x, topLeft.y, bottomRight.x, bottomRight.y];
}

export function clampZoom(zoom: number): number {
  return Math.max(0.5, Math.min(4.0, zoom));
}
