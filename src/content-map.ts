// Content stream mapping: deterministic 1:1 mapping between visual characters
// and their byte positions in the PDF content stream.
//
// Architecture:
// 1. Custom Device traces every glyph in content stream order (what MuPDF resolves)
// 2. Content stream parser finds byte offsets of text operators (where in the bytes)
// 3. Zip them together: each character gets both visual identity AND stream location

import * as mupdf from "mupdf";

export interface GlyphMapping {
  char: string;
  unicode: number;
  glyphId: number;
  x: number;         // position from Device trace (trm[4])
  y: number;         // position from Device trace (trm[5])
  fontName: string;
  // Content stream location:
  streamIndex: number;   // which stream in Contents array (0 if single stream)
  byteOffset: number;    // offset of the complete operator in the stream
  hexStart: number;      // start of the glyph data (hex digits or literal char)
  hexEnd: number;        // end of the glyph data
  isHex: boolean;        // true for <XXXX> hex strings, false for (literal) strings
}

/**
 * Build a complete glyph mapping for a page.
 * Returns one GlyphMapping per character visible on the page.
 */
export function buildGlyphMap(page: mupdf.PDFPage): GlyphMapping[] {
  // --- Layer 1: Device trace ---
  const deviceGlyphs: Array<{
    char: string; unicode: number; glyphId: number;
    x: number; y: number; fontName: string;
  }> = [];

  const device = new mupdf.Device({
    fillText(text: mupdf.Text, _ctm: mupdf.Matrix) {
      text.walk({
        showGlyph(font: mupdf.Font, trm: mupdf.Matrix, glyph: number, unicode: number) {
          deviceGlyphs.push({
            char: String.fromCodePoint(unicode),
            unicode, glyphId: glyph,
            x: trm[4], y: trm[5],
            fontName: font.getName(),
          });
        },
      });
    },
  } as any);

  page.runPageContents(device, mupdf.Matrix.identity);
  try { (device as any).close(); } catch {}

  if (deviceGlyphs.length === 0) return [];

  // --- Layer 2: Content stream parser ---
  const pageObj = page.getObject();
  const contentsRef = pageObj.get("Contents");

  // Read all content streams
  interface StreamInfo { data: string; streamIndex: number; baseOffset: number; }
  const streams: StreamInfo[] = [];
  let totalOffset = 0;

  if (contentsRef.isArray()) {
    for (let i = 0; i < contentsRef.length; i++) {
      const ref = contentsRef.get(i);
      if (ref.isStream()) {
        const data = ref.readStream().asString();
        streams.push({ data, streamIndex: i, baseOffset: totalOffset });
        totalOffset += data.length;
      }
    }
  } else if (contentsRef.isStream()) {
    streams.push({ data: contentsRef.readStream().asString(), streamIndex: 0, baseOffset: 0 });
  }

  if (streams.length === 0) return [];

  // Parse all streams to find glyph positions
  interface StreamGlyph {
    glyphId: number;
    streamIndex: number;
    hexStart: number;  // absolute position of hex/literal data in that stream
    hexEnd: number;
    isHex: boolean;
  }
  const streamGlyphs: StreamGlyph[] = [];

  for (const si of streams) {
    const { data, streamIndex } = si;

    // Find hex string Tj operators: <XXXX> Tj (Type0 fonts)
    const hexPattern = /<([0-9A-Fa-f]{4})>\s*Tj/g;
    let hm;
    while ((hm = hexPattern.exec(data)) !== null) {
      streamGlyphs.push({
        glyphId: parseInt(hm[1], 16),
        streamIndex,
        hexStart: hm.index + 1,  // start of hex digits (after <)
        hexEnd: hm.index + 5,    // end of hex digits (before >)
        isHex: true,
      });
    }

    // Find literal string Tj operators: (text) Tj (WinAnsi fonts)
    // Each character in a literal string is a separate glyph
    const litPattern = /\(([^)]*)\)\s*Tj/g;
    let lm;
    while ((lm = litPattern.exec(data)) !== null) {
      const text = lm[1];
      const stringStart = lm.index + 1; // after (
      for (let ci = 0; ci < text.length; ci++) {
        streamGlyphs.push({
          glyphId: text.charCodeAt(ci),
          streamIndex,
          hexStart: stringStart + ci,
          hexEnd: stringStart + ci + 1,
          isHex: false,
        });
      }
    }

    // Find TJ array operators: [(text) kern (text)] TJ (WinAnsi with kerning)
    const tjArrayPattern = /\[((?:[^[\]]*?))\]\s*TJ/g;
    let tam;
    while ((tam = tjArrayPattern.exec(data)) !== null) {
      const arrayContent = tam[1];
      const arrayStart = tam.index + 1;

      // Extract strings from within the array
      const innerLitPattern = /\(([^)]*)\)/g;
      let ilm;
      while ((ilm = innerLitPattern.exec(arrayContent)) !== null) {
        const innerText = ilm[1];
        const innerStart = arrayStart + ilm.index + 1;
        for (let ci = 0; ci < innerText.length; ci++) {
          streamGlyphs.push({
            glyphId: innerText.charCodeAt(ci),
            streamIndex,
            hexStart: innerStart + ci,
            hexEnd: innerStart + ci + 1,
            isHex: false,
          });
        }
      }
    }
  }

  // Sort stream glyphs by their position in the stream (content stream order)
  streamGlyphs.sort((a, b) => {
    if (a.streamIndex !== b.streamIndex) return a.streamIndex - b.streamIndex;
    return a.hexStart - b.hexStart;
  });

  // --- Layer 3: Zip ---
  const mappings: GlyphMapping[] = [];
  const minLen = Math.min(deviceGlyphs.length, streamGlyphs.length);

  for (let i = 0; i < minLen; i++) {
    const dg = deviceGlyphs[i];
    const sg = streamGlyphs[i];

    mappings.push({
      char: dg.char,
      unicode: dg.unicode,
      glyphId: dg.glyphId,
      x: dg.x,
      y: dg.y,
      fontName: dg.fontName,
      streamIndex: sg.streamIndex,
      byteOffset: sg.hexStart,
      hexStart: sg.hexStart,
      hexEnd: sg.hexEnd,
      isHex: sg.isHex,
    });
  }

  if (deviceGlyphs.length !== streamGlyphs.length) {
    console.warn(`[ContentMap] Glyph count mismatch: device=${deviceGlyphs.length} stream=${streamGlyphs.length} (mapped ${minLen})`);
  }

  return mappings;
}

/**
 * Find GlyphMappings corresponding to a text selection.
 * Uses the selection's y-coordinate and text content to find the exact glyphs.
 */
export function findMappingsForSelection(
  map: GlyphMapping[],
  selectedText: string,
  selectionX: number,
  selectionY: number,
  tolerance: number = 2,
): GlyphMapping[] | null {
  if (map.length === 0 || selectedText.length === 0) return null;

  // Find all runs of characters matching selectedText
  const candidates: Array<{ startIdx: number; yDist: number }> = [];

  for (let i = 0; i <= map.length - selectedText.length; i++) {
    let matches = true;
    for (let j = 0; j < selectedText.length; j++) {
      if (map[i + j].char !== selectedText[j]) { matches = false; break; }
    }
    if (matches) {
      const avgY = map.slice(i, i + selectedText.length).reduce((s, m) => s + m.y, 0) / selectedText.length;
      candidates.push({ startIdx: i, yDist: Math.abs(avgY - selectionY) });
    }
  }

  if (candidates.length === 0) return null;

  // Pick the candidate closest to the selection's y-coordinate
  candidates.sort((a, b) => a.yDist - b.yDist);
  const best = candidates[0];

  return map.slice(best.startIdx, best.startIdx + selectedText.length);
}

/**
 * Edit the content stream by replacing glyph data at specific mapped positions.
 * Handles both hex and literal encodings.
 */
export function editMappedGlyphs(
  streams: string[],
  mappings: GlyphMapping[],
  newChars: string[],
  unicodeToGid?: Map<string, number>,
): string[] {
  if (mappings.length !== newChars.length) {
    console.warn(`[ContentMap] Mapping/char count mismatch: ${mappings.length} vs ${newChars.length}`);
  }

  // Group edits by stream index, apply from end to start to preserve offsets
  const editsByStream = new Map<number, Array<{ hexStart: number; hexEnd: number; newValue: string }>>();

  for (let i = 0; i < Math.min(mappings.length, newChars.length); i++) {
    const m = mappings[i];
    const newChar = newChars[i];
    let newValue: string;

    if (m.isHex) {
      // Hex encoding: need to encode char → glyph ID
      if (unicodeToGid) {
        const gid = unicodeToGid.get(newChar);
        if (gid !== undefined) {
          newValue = gid.toString(16).padStart(4, "0");
        } else {
          continue; // Can't encode — skip
        }
      } else {
        continue;
      }
    } else {
      // Literal encoding: direct character replacement
      newValue = newChar;
    }

    if (!editsByStream.has(m.streamIndex)) editsByStream.set(m.streamIndex, []);
    editsByStream.get(m.streamIndex)!.push({ hexStart: m.hexStart, hexEnd: m.hexEnd, newValue });
  }

  // Apply edits to each stream (end-to-start to preserve offsets)
  const result = [...streams];
  for (const [streamIdx, edits] of editsByStream) {
    edits.sort((a, b) => b.hexStart - a.hexStart); // reverse order
    let s = result[streamIdx];
    for (const edit of edits) {
      s = s.slice(0, edit.hexStart) + edit.newValue + s.slice(edit.hexEnd);
    }
    result[streamIdx] = s;
  }

  return result;
}
