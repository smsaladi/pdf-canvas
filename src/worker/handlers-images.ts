// Worker handlers: image insertion, extraction, export
import * as mupdf from "mupdf";
import type { WorkerResponse, PageImageDTO } from "../types";
import { getDoc } from "./doc-state";
import { getAnnotations } from "./helpers";

type Respond = (rpcId: number | undefined, response: WorkerResponse, transfer?: Transferable[]) => void;

export function handleAddImage(request: any, respond: Respond, rpcId: number | undefined) {
  const page = getDoc().loadPage(request.page) as mupdf.PDFPage;
  const image = new mupdf.Image(request.imageData);
  const stamp = page.createAnnotation("Stamp");
  stamp.setRect(request.rect);
  const imgRef = getDoc().addImage(image);
  const resources = getDoc().newDictionary();
  const xobjects = getDoc().newDictionary();
  xobjects.put("Img", imgRef); resources.put("XObject", xobjects);
  const w = request.rect[2] - request.rect[0], h = request.rect[3] - request.rect[1];
  stamp.setAppearance(null, null, mupdf.Matrix.identity, [0, 0, w, h], resources, `q ${w} 0 0 ${h} 0 0 cm /Img Do Q`);
  try { stamp.setBorderWidth(0); } catch {}
  try { stamp.setColor([] as mupdf.AnnotColor); } catch {}
  stamp.update();
  respond(rpcId, { type: "annotCreated", annot: getAnnotations(request.page).at(-1)! });
}

export function handleGetPageImages(request: any, respond: Respond, rpcId: number | undefined) {
  const page = getDoc().loadPage(request.page) as mupdf.PDFPage;
  const images: PageImageDTO[] = [];
  let imgIdx = 0;

  const imgDevice = new mupdf.Device({
    fillImage(image: mupdf.Image, ctm: mupdf.Matrix) {
      const rect: [number, number, number, number] = [ctm[4], ctm[5], ctm[4] + ctm[0], ctm[5] + ctm[3]];
      const x0 = Math.min(rect[0], rect[2]), y0 = Math.min(rect[1], rect[3]);
      const x1 = Math.max(rect[0], rect[2]), y1 = Math.max(rect[1], rect[3]);
      images.push({ id: `img${request.page}-${imgIdx++}`, page: request.page, rect: [x0, y0, x1, y1], width: image.getWidth(), height: image.getHeight() });
    },
  } as any);

  page.runPageContents(imgDevice, mupdf.Matrix.identity);
  try { (imgDevice as any).close(); } catch {}
  respond(rpcId, { type: "pageImages", page: request.page, images } as any);
}

export async function handleExportImage(request: any, respond: Respond, rpcId: number | undefined) {
  const page = getDoc().loadPage(request.page);
  const stext = page.toStructuredText();
  let targetImage: any = null;
  let imgIdx = 0;

  stext.walk({ onImageBlock(_bbox: any, _transform: any, image: any) { if (imgIdx === request.imageIndex) targetImage = image; imgIdx++; } } as any);

  if (targetImage) {
    const pixmap = targetImage.toPixmap();
    const w = pixmap.getWidth(), h = pixmap.getHeight();
    const pixels = pixmap.getPixels();
    const numComponents = targetImage.getNumberOfComponents();
    let rgba: Uint8ClampedArray;
    if (numComponents === 4) { rgba = new Uint8ClampedArray(pixels); }
    else if (numComponents === 3) {
      rgba = new Uint8ClampedArray(w * h * 4);
      for (let i = 0, j = 0; i < pixels.length; i += 3, j += 4) { rgba[j] = pixels[i]; rgba[j+1] = pixels[i+1]; rgba[j+2] = pixels[i+2]; rgba[j+3] = 255; }
    } else {
      rgba = new Uint8ClampedArray(w * h * 4);
      for (let i = 0, j = 0; i < pixels.length; i++, j += 4) { rgba[j] = rgba[j+1] = rgba[j+2] = pixels[i]; rgba[j+3] = 255; }
    }
    const imageData = new ImageData(new Uint8ClampedArray(rgba.buffer as ArrayBuffer), w, h);
    const bitmap = await createImageBitmap(imageData);
    respond(rpcId, { type: "imageExported", bitmap, width: w, height: h } as any, [bitmap]);
  } else {
    respond(rpcId, { type: "error", message: "Image not found" });
  }
}
