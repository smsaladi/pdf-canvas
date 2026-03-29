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

export function handleSave(request: any, respond: Respond, rpcId: number | undefined) {
  try { getDoc().subsetFonts(); } catch {}
  const buf = getDoc().saveToBuffer(request.options || "incremental");
  const bytes = buf.asUint8Array();
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  respond(rpcId, { type: "saved", buffer } as WorkerResponse, [buffer]);
}
