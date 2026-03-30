// Worker handlers: image insertion, extraction, export, move/resize/delete
import * as mupdf from "mupdf";
import type { WorkerResponse, PageImageDTO } from "../types";
import { getDoc } from "./doc-state";
import { getAnnotations } from "./helpers";
import { readContentStreams, writeContentStreams } from "./stream-utils";

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
  const page = getDoc().loadPage(request.page) as mupdf.PDFPage;

  // Use Device.fillImage to capture the Nth image (works for all image types)
  let targetImage: any = null;
  let imgIdx = 0;
  const device = new mupdf.Device({
    fillImage(image: mupdf.Image, _ctm: mupdf.Matrix) {
      if (imgIdx === request.imageIndex) targetImage = image;
      imgIdx++;
    },
  } as any);
  page.runPageContents(device, mupdf.Matrix.identity);
  try { (device as any).close(); } catch {}

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

interface ImageTraceResult {
  index: number;
  ctm: mupdf.Matrix;
  resourceName: string;
}

/**
 * Use the Device trace to find which XObject resource name corresponds
 * to the Nth image, AND capture its actual CTM from the rendering pipeline.
 * Then locate that Do operation in the content streams.
 */
function tracePageImages(page: mupdf.PDFPage): ImageTraceResult[] {
  const results: ImageTraceResult[] = [];
  // Track which resource names are used for each fillImage call
  // by running the page through a custom device
  const pageObj = page.getObject();

  // Get XObject dict to map resource names to image refs
  const resources = pageObj.get("Resources");
  const xobjects = resources?.isNull() ? null : resources.get("XObject");
  const imageRefToName = new Map<string, string>();
  if (xobjects && !xobjects.isNull()) {
    const keys: string[] = [];
    xobjects.forEach((_: any, k: string | number) => keys.push(String(k)));
    for (const key of keys) {
      const xobj = xobjects.get(key);
      // Store a signature of this image for matching
      const w = xobj.get("Width");
      const h = xobj.get("Height");
      if (w && h) {
        imageRefToName.set(`${key}`, key);
      }
    }
  }

  const device = new mupdf.Device({
    fillImage(_image: mupdf.Image, ctm: mupdf.Matrix) {
      results.push({ index: results.length, ctm: [...ctm] as mupdf.Matrix, resourceName: "" });
    },
  } as any);
  page.runPageContents(device, mupdf.Matrix.identity);
  try { (device as any).close(); } catch {}

  return results;
}

interface ImageOpInfo {
  streamIndex: number;
  /** Start of the q...cm.../Name Do Q block */
  blockStart: number;
  /** End of the q...cm.../Name Do Q block */
  blockEnd: number;
  resourceName: string;
  /** The full CTM from Device trace (accounts for all nested transforms) */
  ctm: mupdf.Matrix;
}

/**
 * Find the Nth image Do operation in content streams by counting
 * Do ops that reference Image XObjects (not Form XObjects).
 */
function findNthImageOp(
  streams: string[],
  imageIndex: number,
  pageObj: mupdf.PDFObject,
  ctm?: mupdf.Matrix,
): ImageOpInfo | null {
  // Build set of image XObject names
  const imageNames = new Set<string>();
  const resources = pageObj.get("Resources");
  if (!resources.isNull()) {
    const xobjects = resources.get("XObject");
    if (xobjects && !xobjects.isNull()) {
      const keys: string[] = [];
      xobjects.forEach((_: any, k: string | number) => keys.push(String(k)));
      for (const key of keys) {
        const xobj = xobjects.get(key);
        const subtype = xobj.get("Subtype");
        if (subtype && subtype.asName() === "Image") {
          imageNames.add(key);
        }
      }
    }
  }

  console.log(`[ImageOp] Looking for image #${imageIndex}, imageXObjects: [${[...imageNames].join(", ")}]`);

  let imgCount = 0;

  for (let si = 0; si < streams.length; si++) {
    const stream = streams[si];
    // Match /Name Do — the resource name can contain letters, digits, period, underscore, plus
    const doPattern = /\/([\w.+]+)\s+Do\b/g;
    let doMatch;

    while ((doMatch = doPattern.exec(stream)) !== null) {
      const resourceName = doMatch[1];
      // Only count image XObjects
      if (imageNames.size > 0 && !imageNames.has(resourceName)) continue;

      console.log(`[ImageOp] Image Do #${imgCount}: /${resourceName} at stream[${si}]:${doMatch.index}`);

      if (imgCount === imageIndex) {
        const doEnd = doMatch.index + doMatch[0].length;

        // Find enclosing q...Q block by scanning outward
        // Scan backwards for the matching 'q'
        let blockStart = doMatch.index;
        let depth = 0;
        for (let i = doMatch.index - 1; i >= 0; i--) {
          // Look for Q or q operators (standalone, not part of other operators)
          if (stream[i] === 'Q' && (i === 0 || /\s/.test(stream[i - 1])) && (i + 1 >= stream.length || /\s/.test(stream[i + 1]))) {
            depth++;
          }
          if (stream[i] === 'q' && (i === 0 || /\s/.test(stream[i - 1])) && (i + 1 < stream.length && /\s/.test(stream[i + 1]))) {
            if (depth === 0) {
              blockStart = i;
              break;
            }
            depth--;
          }
        }

        // Scan forward for the matching 'Q'
        let blockEnd = doEnd;
        const afterDo = stream.slice(doEnd);
        const qMatch = afterDo.match(/^\s*Q(?:\s|$)/);
        if (qMatch) {
          blockEnd = doEnd + qMatch[0].length;
        }

        console.log(`[ImageOp] Found: block=${blockStart}-${blockEnd}, snippet="${stream.slice(blockStart, Math.min(blockEnd, blockStart + 100))}"`);

        return {
          streamIndex: si,
          blockStart,
          blockEnd,
          resourceName,
          ctm: ctm || [1, 0, 0, 1, 0, 0],
        };
      }
      imgCount++;
    }
  }
  return null;
}

export function handleMoveResizeImage(request: any, respond: Respond, rpcId: number | undefined) {
  const page = getDoc().loadPage(request.page) as mupdf.PDFPage;
  const pageObj = page.getObject();
  const contentsRef = pageObj.get("Contents");
  const streams = readContentStreams(contentsRef);

  // Use Device trace to get the actual CTM for this image
  const traced = tracePageImages(page);
  if (request.imageIndex >= traced.length) {
    respond(rpcId, { type: "error", message: "Image index out of range" });
    return;
  }
  const tracedCtm = traced[request.imageIndex].ctm;

  const info = findNthImageOp(streams, request.imageIndex, pageObj, tracedCtm);
  if (!info) {
    respond(rpcId, { type: "error", message: "Image not found in content stream" });
    return;
  }

  const [x0, y0, x1, y1] = request.newRect;
  const newW = x1 - x0;
  const newH = y1 - y0;

  // The content stream cm operates in a coordinate space that may differ from
  // the Device trace space by a page-level transform. We need the ratio between them.
  // Find the cm operator(s) within the block to compute the ratio.
  const stream = streams[info.streamIndex];
  const blockContent = stream.slice(info.blockStart, info.blockEnd);
  const cmRegex = /([-\d.e+]+)\s+([-\d.e+]+)\s+([-\d.e+]+)\s+([-\d.e+]+)\s+([-\d.e+]+)\s+([-\d.e+]+)\s+cm/g;

  // Compose all cm operators in the block to get the effective content-stream CTM
  let cmA = 1, cmB = 0, cmC = 0, cmD = 1, cmE = 0, cmF = 0;
  let lastCmStart = -1, lastCmEnd = -1;
  let cmMatch;
  while ((cmMatch = cmRegex.exec(blockContent)) !== null) {
    const ma = parseFloat(cmMatch[1]), mb = parseFloat(cmMatch[2]);
    const mc = parseFloat(cmMatch[3]), md = parseFloat(cmMatch[4]);
    const me = parseFloat(cmMatch[5]), mf = parseFloat(cmMatch[6]);
    // Pre-multiply: new = M * old
    const na = ma * cmA + mb * cmC;
    const nb = ma * cmB + mb * cmD;
    const nc = mc * cmA + md * cmC;
    const nd = mc * cmB + md * cmD;
    const ne = me * cmA + mf * cmC + cmE;
    const nf = me * cmB + mf * cmD + cmF;
    cmA = na; cmB = nb; cmC = nc; cmD = nd; cmE = ne; cmF = nf;
    lastCmStart = cmMatch.index!;
    lastCmEnd = cmMatch.index! + cmMatch[0].length;
  }

  if (lastCmStart === -1) {
    respond(rpcId, { type: "error", message: "No cm operator found in image block" });
    return;
  }

  // Old overlay rect (Device trace space)
  const oldOverlayX0 = Math.min(tracedCtm[4], tracedCtm[4] + tracedCtm[0]);
  const oldOverlayY0 = Math.min(tracedCtm[5], tracedCtm[5] + tracedCtm[3]);
  const oldOverlayW = Math.abs(tracedCtm[0]);
  const oldOverlayH = Math.abs(tracedCtm[3]);

  // Scale factors for resize
  const scaleFactorX = oldOverlayW > 0 ? newW / oldOverlayW : 1;
  const scaleFactorY = oldOverlayH > 0 ? newH / oldOverlayH : 1;

  // Get the page transform to convert between device space (Y down) and PDF user space (Y up)
  // Typically [1, 0, 0, -1, 0, pageHeight] for a standard page
  const pageCTM = (getDoc().loadPage(request.page) as any).getTransform() as number[];
  const pa = pageCTM[0], pd = pageCTM[3];

  // Delta in overlay/device space
  const dx = x0 - oldOverlayX0;
  const dy = y0 - oldOverlayY0;

  // Convert device delta to cm E/F delta
  // The cm E,F are in PDF user space. Device → PDF user via inverse page transform.
  // Then PDF user → cm space needs the ratio between cm and PDF spaces.
  // Ratio: cmA / (tracedA / pa) = cmA * pa / tracedA
  const cmRatioX = Math.abs(tracedCtm[0]) > 0.01 ? (cmA * pa) / tracedCtm[0] : 1;
  const cmRatioY = Math.abs(tracedCtm[3]) > 0.01 ? (cmD * pd) / tracedCtm[3] : 1;

  const cmDx = dx * cmRatioX;
  const cmDy = dy * cmRatioY;

  // New composed cm values
  const newCmA = cmA * scaleFactorX;
  const newCmB = cmB * scaleFactorX;
  const newCmC = cmC * scaleFactorY;
  const newCmD = cmD * scaleFactorY;
  const newCmE = cmE + cmDx;
  const newCmF = cmF + cmDy;

  const newCmStr = `${newCmA} ${newCmB} ${newCmC} ${newCmD} ${newCmE} ${newCmF} cm`;

  // Replace all cm operators in the block with a single new one.
  // Preserve all other operators (gs, RG, rg, etc.) to maintain graphics state.
  // Strategy: remove all cm operators, then insert the new one at the first cm's position.
  let newBlockContent = blockContent;
  let offset = 0;
  const allCmPositions: Array<{ start: number; end: number }> = [];
  const cmRegex2 = /[-\d.e+]+\s+[-\d.e+]+\s+[-\d.e+]+\s+[-\d.e+]+\s+[-\d.e+]+\s+[-\d.e+]+\s+cm/g;
  let m2;
  while ((m2 = cmRegex2.exec(blockContent)) !== null) {
    allCmPositions.push({ start: m2.index, end: m2.index + m2[0].length });
  }

  // Remove all cm ops from last to first (to preserve offsets), then insert new one at first position
  for (let i = allCmPositions.length - 1; i >= 0; i--) {
    const pos = allCmPositions[i];
    newBlockContent = newBlockContent.slice(0, pos.start + offset) + newBlockContent.slice(pos.end + offset);
    if (i > 0) offset -= (pos.end - pos.start); // only track offset for non-first removals
  }
  // Insert new cm at the first cm's original position
  if (allCmPositions.length > 0) {
    const insertAt = allCmPositions[0].start;
    newBlockContent = newBlockContent.slice(0, insertAt) + newCmStr + "\n" + newBlockContent.slice(insertAt);
  }

  streams[info.streamIndex] = stream.slice(0, info.blockStart) + newBlockContent + stream.slice(info.blockEnd);
  writeContentStreams(contentsRef, streams);

  console.log(`[ImageOp] pageCTM=[${pa},${pd}], cmRatio=[${cmRatioX.toFixed(2)},${cmRatioY.toFixed(2)}], delta=[${dx.toFixed(1)},${dy.toFixed(1)}] → cm_delta=[${cmDx.toFixed(1)},${cmDy.toFixed(1)}], scale=[${scaleFactorX.toFixed(3)},${scaleFactorY.toFixed(3)}]`);
  respond(rpcId, { type: "imageUpdated", page: request.page } as any);
}

export function handleDeleteImage(request: any, respond: Respond, rpcId: number | undefined) {
  const page = getDoc().loadPage(request.page) as mupdf.PDFPage;
  const pageObj = page.getObject();
  const contentsRef = pageObj.get("Contents");
  const streams = readContentStreams(contentsRef);

  const info = findNthImageOp(streams, request.imageIndex, pageObj);
  if (!info) {
    respond(rpcId, { type: "error", message: "Image not found in content stream" });
    return;
  }

  const stream = streams[info.streamIndex];
  // Store the deleted block for undo
  const deletedBlock = stream.slice(info.blockStart, info.blockEnd);
  const insertPosition = info.blockStart;
  streams[info.streamIndex] = stream.slice(0, info.blockStart) + stream.slice(info.blockEnd);
  writeContentStreams(contentsRef, streams);

  console.log(`[ImageOp] Deleted image #${request.imageIndex}`);
  respond(rpcId, {
    type: "imageDeleted",
    page: request.page,
    deletedBlock,
    streamIndex: info.streamIndex,
    insertPosition,
  } as any);
}

export function handleRestoreImageBlock(request: any, respond: Respond, rpcId: number | undefined) {
  const page = getDoc().loadPage(request.page) as mupdf.PDFPage;
  const contentsRef = page.getObject().get("Contents");
  const streams = readContentStreams(contentsRef);

  const si = request.streamIndex ?? 0;
  if (si >= streams.length) {
    respond(rpcId, { type: "error", message: "Stream index out of range" });
    return;
  }

  // Insert the block back at the original position (or append if position is past end)
  const stream = streams[si];
  const pos = Math.min(request.insertPosition ?? stream.length, stream.length);
  streams[si] = stream.slice(0, pos) + request.block + stream.slice(pos);
  writeContentStreams(contentsRef, streams);

  console.log(`[ImageOp] Restored image block at stream[${si}]:${pos}`);
  respond(rpcId, { type: "imageUpdated", page: request.page } as any);
}

export function handleReorderImage(request: any, respond: Respond, rpcId: number | undefined) {
  const page = getDoc().loadPage(request.page) as mupdf.PDFPage;
  const pageObj = page.getObject();
  const contentsRef = pageObj.get("Contents");
  const streams = readContentStreams(contentsRef);

  const info = findNthImageOp(streams, request.imageIndex, pageObj);
  if (!info) {
    respond(rpcId, { type: "error", message: "Image not found in content stream" });
    return;
  }

  const stream = streams[info.streamIndex];
  const block = stream.slice(info.blockStart, info.blockEnd);

  // Find ALL image Do operations to determine relative ordering
  const allImageOps: Array<{ blockStart: number; blockEnd: number }> = [];
  const imageNames = new Set<string>();
  const resources = pageObj.get("Resources");
  if (!resources.isNull()) {
    const xobjects = resources.get("XObject");
    if (xobjects && !xobjects.isNull()) {
      const keys: string[] = [];
      xobjects.forEach((_: any, k: string | number) => keys.push(String(k)));
      for (const key of keys) {
        const xobj = xobjects.get(key);
        if (xobj.get("Subtype")?.asName() === "Image") imageNames.add(key);
      }
    }
  }

  // Find all image q...Q blocks in order
  const doPattern = /\/([\w.+]+)\s+Do\b/g;
  let doMatch;
  while ((doMatch = doPattern.exec(stream)) !== null) {
    if (imageNames.size > 0 && !imageNames.has(doMatch[1])) continue;
    // Scan backward for enclosing q
    let bs = doMatch.index;
    for (let i = doMatch.index - 1; i >= 0; i--) {
      if (stream[i] === 'q' && (i === 0 || /\s/.test(stream[i - 1]))) { bs = i; break; }
      if (!/\s/.test(stream[i]) && !/[-\d.ecm]/.test(stream[i])) break;
    }
    // Scan forward for Q
    let be = doMatch.index + doMatch[0].length;
    const after = stream.slice(be);
    const qm = after.match(/^\s*Q(?:\s|$)/);
    if (qm) be += qm[0].length;
    allImageOps.push({ blockStart: bs, blockEnd: be });
  }

  // Find our image's index in the sorted list
  const myIdx = allImageOps.findIndex(op => op.blockStart === info.blockStart);
  const withoutBlock = stream.slice(0, info.blockStart) + stream.slice(info.blockEnd);

  switch (request.direction) {
    case "front":
      // Move to end of stream (drawn last = on top)
      streams[info.streamIndex] = withoutBlock + "\n" + block;
      break;
    case "back":
      // Move to just before the first image block (preserves pre-image setup)
      if (allImageOps.length > 0 && allImageOps[0].blockStart !== info.blockStart) {
        const firstStart = allImageOps[0].blockStart;
        const s = stream.slice(0, firstStart) + block + "\n" + stream.slice(firstStart, info.blockStart) + stream.slice(info.blockEnd);
        streams[info.streamIndex] = s;
      } else if (allImageOps.length > 1) {
        // We're already first — move before the second image's original position
        streams[info.streamIndex] = withoutBlock; // already at front, nothing to do
      } else {
        streams[info.streamIndex] = withoutBlock; // only one image
      }
      break;
    case "forward": {
      // Insert after the next image block
      if (myIdx >= 0 && myIdx + 1 < allImageOps.length) {
        const next = allImageOps[myIdx + 1];
        // Remove our block first, then insert after next block's adjusted position
        const s = stream.slice(0, info.blockStart) + stream.slice(info.blockEnd);
        const adjustedNextEnd = next.blockEnd - (info.blockEnd - info.blockStart);
        streams[info.streamIndex] = s.slice(0, adjustedNextEnd) + "\n" + block + s.slice(adjustedNextEnd);
      } else {
        streams[info.streamIndex] = withoutBlock + "\n" + block;
      }
      break;
    }
    case "backward": {
      // Insert before the previous image block
      if (myIdx > 0) {
        const prev = allImageOps[myIdx - 1];
        // Remove our block first, then insert before prev block (offset unchanged since prev is before us)
        const s = stream.slice(0, info.blockStart) + stream.slice(info.blockEnd);
        streams[info.streamIndex] = s.slice(0, prev.blockStart) + block + "\n" + s.slice(prev.blockStart);
      } else {
        streams[info.streamIndex] = stream; // already first
      }
      break;
    }
  }

  writeContentStreams(contentsRef, streams);

  // Determine the new image index by re-scanning for the resource name
  const newStreams = readContentStreams(contentsRef);
  let newIndex = 0;
  let found = -1;
  for (const ns of newStreams) {
    const dp = /\/([\w.+]+)\s+Do\b/g;
    let dm;
    while ((dm = dp.exec(ns)) !== null) {
      if (imageNames.size > 0 && !imageNames.has(dm[1])) continue;
      if (dm[1] === info.resourceName) { found = newIndex; }
      newIndex++;
    }
  }

  console.log(`[ImageOp] Reordered image #${request.imageIndex} → ${request.direction} (new index: ${found})`);
  respond(rpcId, { type: "imageReordered", page: request.page, newImageIndex: found, resourceName: info.resourceName } as any);
}
