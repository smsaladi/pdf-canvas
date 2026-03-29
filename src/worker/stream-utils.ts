// Utilities for reading/writing PDF page content streams.
// Abstracts the common pattern of handling Contents as either
// a single stream or an array of streams.

import type * as mupdf from "mupdf";

/**
 * Read all content streams from a page's Contents reference.
 * Handles both single stream and array of streams.
 * Returns an array of decoded stream strings.
 */
export function readContentStreams(contentsRef: mupdf.PDFObject): string[] {
  const streams: string[] = [];
  if (contentsRef.isArray()) {
    for (let i = 0; i < contentsRef.length; i++) {
      const ref = contentsRef.get(i);
      streams.push(ref.isStream() ? ref.readStream().asString() : "");
    }
  } else if (contentsRef.isStream()) {
    streams.push(contentsRef.readStream().asString());
  }
  return streams;
}

/**
 * Write content streams back to a page's Contents reference.
 * The streams array must match the structure (single or array).
 */
export function writeContentStreams(contentsRef: mupdf.PDFObject, streams: string[]): void {
  if (contentsRef.isArray()) {
    for (let i = 0; i < Math.min(contentsRef.length, streams.length); i++) {
      const ref = contentsRef.get(i);
      if (ref.isStream()) ref.writeStream(streams[i]);
    }
  } else if (contentsRef.isStream() && streams.length > 0) {
    contentsRef.writeStream(streams[0]);
  }
}

/**
 * Try to apply a transformation to each content stream.
 * The callback receives the stream text and should return the modified text,
 * or null to skip. Returns true if any stream was modified.
 */
export function tryReplaceInStreams(
  contentsRef: mupdf.PDFObject,
  fn: (streamData: string, streamRef: mupdf.PDFObject) => string | null
): boolean {
  if (contentsRef.isArray()) {
    for (let i = 0; i < contentsRef.length; i++) {
      const ref = contentsRef.get(i);
      if (!ref.isStream()) continue;
      const result = fn(ref.readStream().asString(), ref);
      if (result !== null) {
        ref.writeStream(result);
        return true;
      }
    }
  } else if (contentsRef.isStream()) {
    const result = fn(contentsRef.readStream().asString(), contentsRef);
    if (result !== null) {
      contentsRef.writeStream(result);
      return true;
    }
  }
  return false;
}
