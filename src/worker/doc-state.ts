// Shared document state for worker handlers
import * as mupdf from "mupdf";

export let doc: mupdf.PDFDocument | null = null;

export function setDoc(d: mupdf.PDFDocument | null): void {
  doc = d;
}

export function getDoc(): mupdf.PDFDocument {
  if (!doc) throw new Error("No document loaded");
  return doc;
}
