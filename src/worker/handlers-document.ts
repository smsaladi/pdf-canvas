// Worker handlers: document lifecycle, page info, rendering, save
import * as mupdf from "mupdf";
import type { WorkerResponse, PageInfo } from "../types";
import { setDoc, getDoc } from "./doc-state";
import { getPageInfo, renderPage } from "./helpers";

type Respond = (rpcId: number | undefined, response: WorkerResponse, transfer?: Transferable[]) => void;

export function handleOpen(request: any, respond: Respond, rpcId: number | undefined) {
  const newDoc = new mupdf.PDFDocument(request.data);
  setDoc(newDoc);
  const pageCount = newDoc.countPages();
  const pages: PageInfo[] = [];
  for (let i = 0; i < pageCount; i++) pages.push(getPageInfo(i));
  respond(rpcId, { type: "opened", pageCount, pages });
}

export function handleGetPageCount(respond: Respond, rpcId: number | undefined) {
  respond(rpcId, { type: "pageCount", count: getDoc().countPages() });
}

export function handleGetPageInfo(request: any, respond: Respond, rpcId: number | undefined) {
  respond(rpcId, { type: "pageInfo", page: request.page, info: getPageInfo(request.page) });
}

export async function handleRenderPage(request: any, respond: Respond, rpcId: number | undefined) {
  const result = await renderPage(request.page, request.scale);
  respond(rpcId, { type: "pageRendered", page: request.page, bitmap: result.bitmap, width: result.width, height: result.height }, [result.bitmap]);
}

export function handleRotatePage(request: any, respond: Respond, rpcId: number | undefined) {
  const pageObj = (getDoc().loadPage(request.page) as mupdf.PDFPage).getObject();
  let rot = 0; try { rot = pageObj.get("Rotate")?.asNumber?.() || 0; } catch {}
  pageObj.put("Rotate", ((rot + request.angle) % 360 + 360) % 360);
  respond(rpcId, { type: "pageRotated", page: request.page, info: getPageInfo(request.page) } as any);
}

function getAllPageInfos(): PageInfo[] {
  const doc = getDoc();
  const pages: PageInfo[] = [];
  for (let i = 0; i < doc.countPages(); i++) pages.push(getPageInfo(i));
  return pages;
}

export function handleDeletePages(request: any, respond: Respond, rpcId: number | undefined) {
  const doc = getDoc();
  // Delete in reverse order so indices stay valid
  const sorted = [...request.pages].sort((a: number, b: number) => b - a);
  for (const idx of sorted) {
    if (idx >= 0 && idx < doc.countPages()) doc.deletePage(idx);
  }
  respond(rpcId, { type: "pagesUpdated", pages: getAllPageInfos() });
}

export function handleRearrangePages(request: any, respond: Respond, rpcId: number | undefined) {
  getDoc().rearrangePages(request.order);
  respond(rpcId, { type: "pagesUpdated", pages: getAllPageInfos() });
}

export function handleInsertBlankPage(request: any, respond: Respond, rpcId: number | undefined) {
  const doc = getDoc();
  const pageObj = doc.addPage([0, 0, 612, 792], 0, null as any, "");
  doc.insertPage(request.at, pageObj);
  respond(rpcId, { type: "pagesUpdated", pages: getAllPageInfos() });
}

export function handleCreateBlankDocument(request: any, respond: Respond, rpcId: number | undefined) {
  const w = request.width || 612;
  const h = request.height || 792;
  const doc = new mupdf.PDFDocument();
  const pageObj = doc.addPage([0, 0, w, h], 0, null as any, "");
  doc.insertPage(0, pageObj);
  setDoc(doc);
  respond(rpcId, { type: "opened", pageCount: 1, pages: [getPageInfo(0)] });
}

export function handleSave(request: any, respond: Respond, rpcId: number | undefined) {
  try { getDoc().subsetFonts(); } catch {}
  const buf = getDoc().saveToBuffer(request.options || "incremental");
  const bytes = buf.asUint8Array();
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  respond(rpcId, { type: "saved", buffer } as WorkerResponse, [buffer]);
}
