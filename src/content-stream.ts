// PDF content stream tokenizer and text replacement engine
//
// PDF text in content streams uses operators like:
//   (Hello World) Tj          — show literal string
//   <48656C6C6F> Tj           — show hex string
//   [(H) 20 (ello)] TJ       — show array with kerning
//   (Hello World) '           — move to next line and show string
//
// This module parses content streams to locate text strings
// and supports in-place replacement.

/** Decode a PDF literal string (remove parens, handle escapes) */
export function decodeLiteralString(raw: string): string {
  // raw includes surrounding parens: "(Hello)"
  const inner = raw.slice(1, -1);
  let result = "";
  let i = 0;
  while (i < inner.length) {
    if (inner[i] === "\\") {
      i++;
      if (i >= inner.length) break;
      switch (inner[i]) {
        case "n": result += "\n"; break;
        case "r": result += "\r"; break;
        case "t": result += "\t"; break;
        case "b": result += "\b"; break;
        case "f": result += "\f"; break;
        case "(": result += "("; break;
        case ")": result += ")"; break;
        case "\\": result += "\\"; break;
        default:
          // Octal escape: \ddd
          if (inner[i] >= "0" && inner[i] <= "7") {
            let octal = inner[i];
            if (i + 1 < inner.length && inner[i + 1] >= "0" && inner[i + 1] <= "7") {
              octal += inner[++i];
              if (i + 1 < inner.length && inner[i + 1] >= "0" && inner[i + 1] <= "7") {
                octal += inner[++i];
              }
            }
            result += String.fromCharCode(parseInt(octal, 8));
          } else {
            result += inner[i];
          }
      }
    } else {
      result += inner[i];
    }
    i++;
  }
  return result;
}

/** Encode a string as a PDF literal string with escapes */
export function encodeLiteralString(text: string): string {
  let escaped = "";
  for (const ch of text) {
    switch (ch) {
      case "(": escaped += "\\("; break;
      case ")": escaped += "\\)"; break;
      case "\\": escaped += "\\\\"; break;
      default: escaped += ch;
    }
  }
  return `(${escaped})`;
}

/** Decode a PDF hex string: <48656C6C6F> → "Hello" */
export function decodeHexString(raw: string): string {
  const hex = raw.slice(1, -1).replace(/\s/g, "");
  let result = "";
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.slice(i, i + 2), 16);
    result += String.fromCharCode(byte);
  }
  return result;
}

/** Encode a string as a PDF hex string */
export function encodeHexString(text: string): string {
  let hex = "";
  for (let i = 0; i < text.length; i++) {
    hex += text.charCodeAt(i).toString(16).padStart(2, "0");
  }
  return `<${hex}>`;
}

/** A located text string within the content stream */
export interface TextOccurrence {
  /** Decoded text content */
  text: string;
  /** Start byte offset in the content stream */
  start: number;
  /** End byte offset (exclusive) */
  end: number;
  /** The raw string token as it appears in the stream */
  raw: string;
  /** Whether this is a hex string */
  isHex: boolean;
  /** The operator that uses this string (Tj, TJ, ', ") */
  operator: string;
}

/**
 * Extract all text string occurrences from a PDF content stream.
 * Finds Tj, TJ, ', " operators and their string operands.
 */
export function extractTextOccurrences(stream: string): TextOccurrence[] {
  const results: TextOccurrence[] = [];
  let i = 0;

  while (i < stream.length) {
    // Skip whitespace
    if (isWhitespace(stream[i])) { i++; continue; }

    // Skip comments (% to end of line)
    if (stream[i] === "%") {
      while (i < stream.length && stream[i] !== "\n" && stream[i] !== "\r") i++;
      continue;
    }

    // Literal string: (...)
    if (stream[i] === "(") {
      const start = i;
      const raw = readLiteralString(stream, i);
      if (raw !== null) {
        const end = start + raw.length;
        // Look ahead for operator
        const opInfo = findNextOperator(stream, end);
        if (opInfo && isTextOperator(opInfo.op)) {
          results.push({
            text: decodeLiteralString(raw),
            start,
            end,
            raw,
            isHex: false,
            operator: opInfo.op,
          });
        }
        i = end;
        continue;
      }
    }

    // Hex string: <...>
    if (stream[i] === "<" && i + 1 < stream.length && stream[i + 1] !== "<") {
      const start = i;
      const closeIdx = stream.indexOf(">", i + 1);
      if (closeIdx !== -1) {
        const raw = stream.slice(start, closeIdx + 1);
        const end = closeIdx + 1;
        const opInfo = findNextOperator(stream, end);
        if (opInfo && isTextOperator(opInfo.op)) {
          results.push({
            text: decodeHexString(raw),
            start,
            end,
            raw,
            isHex: false,
            operator: opInfo.op,
          });
        }
        i = end;
        continue;
      }
    }

    // TJ array: [(text) kern (text)] TJ
    if (stream[i] === "[") {
      const start = i;
      const arrayEnd = findMatchingBracket(stream, i);
      if (arrayEnd !== -1) {
        const end = arrayEnd + 1;
        const opInfo = findNextOperator(stream, end);
        if (opInfo && opInfo.op === "TJ") {
          // Extract individual strings from the array
          const arrayContent = stream.slice(start + 1, arrayEnd);
          extractStringsFromTJArray(arrayContent, start + 1, opInfo.op, results);
        }
        i = end;
        continue;
      }
    }

    i++;
  }

  return results;
}

/** A TJ array with its position in the stream and decoded fragments */
interface TJArrayInfo {
  /** Start offset of the '[' in the stream */
  arrayStart: number;
  /** End offset (after the ']') in the stream */
  arrayEnd: number;
  /** The full concatenated decoded text */
  fullText: string;
  /** Individual string fragments with their positions */
  fragments: Array<{
    text: string;
    start: number; // offset in stream
    end: number;
    isHex: boolean;
  }>;
  /** Raw content between [ and ] */
  rawContent: string;
}

/** Find all TJ arrays in the stream with their concatenated text */
function findTJArrays(stream: string): TJArrayInfo[] {
  const results: TJArrayInfo[] = [];
  let i = 0;

  while (i < stream.length) {
    if (stream[i] === "%" ) { while (i < stream.length && stream[i] !== "\n") i++; continue; }

    if (stream[i] === "[") {
      const arrayStart = i;
      const bracketEnd = findMatchingBracket(stream, i);
      if (bracketEnd !== -1) {
        const arrayEnd = bracketEnd + 1;
        const opInfo = findNextOperator(stream, arrayEnd);
        if (opInfo && opInfo.op === "TJ") {
          const rawContent = stream.slice(arrayStart + 1, bracketEnd);
          const fragments: TJArrayInfo["fragments"] = [];
          let fullText = "";

          // Parse fragments inside the array
          let j = 0;
          while (j < rawContent.length) {
            if (rawContent[j] === "(") {
              const raw = readLiteralString(rawContent, j);
              if (raw) {
                const decoded = decodeLiteralString(raw);
                fragments.push({
                  text: decoded,
                  start: arrayStart + 1 + j,
                  end: arrayStart + 1 + j + raw.length,
                  isHex: false,
                });
                fullText += decoded;
                j += raw.length;
                continue;
              }
            }
            if (rawContent[j] === "<" && j + 1 < rawContent.length && rawContent[j + 1] !== "<") {
              const closeIdx = rawContent.indexOf(">", j + 1);
              if (closeIdx !== -1) {
                const raw = rawContent.slice(j, closeIdx + 1);
                const decoded = decodeHexString(raw);
                fragments.push({
                  text: decoded,
                  start: arrayStart + 1 + j,
                  end: arrayStart + 1 + j + raw.length,
                  isHex: true,
                });
                fullText += decoded;
                j = closeIdx + 1;
                continue;
              }
            }
            j++;
          }

          if (fragments.length > 0) {
            results.push({ arrayStart, arrayEnd, fullText, fragments, rawContent });
          }
        }
        i = arrayEnd;
        continue;
      }
    }
    i++;
  }
  return results;
}

/**
 * Find and replace text in a content stream.
 * Handles both simple Tj strings and TJ arrays where text is split
 * across multiple kerned fragments (common in real-world PDFs).
 * Returns the modified stream and the number of replacements made.
 */
export function replaceTextInStream(
  stream: string,
  oldText: string,
  newText: string,
  replaceAll = false
): { result: string; count: number } {
  let result = stream;
  let count = 0;
  let offset = 0;

  // Strategy 1: Try TJ array replacement (handles kerned/split text)
  const tjArrays = findTJArrays(stream);
  for (const tj of tjArrays) {
    const idx = tj.fullText.indexOf(oldText);
    if (idx === -1) continue;

    // Found! Rebuild the TJ array with replacement text.
    // Simple approach: replace the entire array content with a single string
    // containing the modified full text. This loses kerning but is correct.
    const newFullText = tj.fullText.slice(0, idx) + newText + tj.fullText.slice(idx + oldText.length);
    const newArrayContent = encodeLiteralString(newFullText);

    const adjStart = tj.arrayStart + offset;
    const adjEnd = tj.arrayEnd + offset;
    // Replace [old array content] with [new single string]
    const replacement = `[${newArrayContent}]`;
    result = result.slice(0, adjStart) + replacement + result.slice(adjEnd);
    offset += replacement.length - (tj.arrayEnd - tj.arrayStart);
    count++;

    if (!replaceAll) break;
  }

  if (count > 0) return { result, count };

  // Strategy 2: Fall back to simple Tj string replacement
  const occurrences = extractTextOccurrences(stream);
  for (const occ of occurrences) {
    const idx = occ.text.indexOf(oldText);
    if (idx === -1) continue;

    const newDecodedText = occ.text.slice(0, idx) + newText + occ.text.slice(idx + oldText.length);
    const encoded = occ.isHex
      ? encodeHexString(newDecodedText)
      : encodeLiteralString(newDecodedText);

    const adjStart = occ.start + offset;
    const adjEnd = occ.end + offset;
    result = result.slice(0, adjStart) + encoded + result.slice(adjEnd);
    offset += encoded.length - (occ.end - occ.start);
    count++;

    if (!replaceAll) break;
  }

  return { result, count };
}

/**
 * Replace text in a content stream with font-switching operators.
 * Used for per-word bold/italic changes: wraps the replaced text
 * with a font switch to newFontName, then restores the original font.
 *
 * Finds the most recent Tf operator before the text to determine
 * the current font name and size, then inserts:
 *   /newFont size Tf (replacement text) Tj /origFont size Tf
 */
export function replaceTextWithFontSwitch(
  stream: string,
  oldText: string,
  newText: string,
  newFontName: string,
): { result: string; count: number } {
  // Find TJ arrays first (most common in real PDFs)
  const tjArrays = findTJArrays(stream);
  let result = stream;
  let offset = 0;

  for (const tj of tjArrays) {
    const idx = tj.fullText.indexOf(oldText);
    if (idx === -1) continue;

    // Find the most recent Tf operator before this TJ array to get current font/size
    const beforeText = stream.slice(0, tj.arrayStart);
    const tfMatch = beforeText.match(/\/(\S+)\s+([\d.]+)\s+Tf\s*$/s)
      || beforeText.match(/\/(\S+)\s+([\d.]+)\s+Tf/gs);

    let origFontName = "TT0";
    let fontSize = "12";

    if (tfMatch) {
      // Get the LAST Tf match
      const allMatches = [...beforeText.matchAll(/\/(\S+)\s+([\d.]+)\s+Tf/g)];
      if (allMatches.length > 0) {
        const lastTf = allMatches[allMatches.length - 1];
        origFontName = lastTf[1];
        fontSize = lastTf[2];
      }
    }

    // Build the replacement: switch font, show text, switch back
    const newFullText = tj.fullText.slice(0, idx) + newText + tj.fullText.slice(idx + oldText.length);

    // Split into: prefix (original font), target (new font), suffix (original font)
    const prefixText = newFullText.slice(0, idx);
    const targetText = newText;
    const suffixText = newFullText.slice(idx + newText.length);

    let replacement = "";

    // Prefix in original font (if any)
    if (prefixText) {
      replacement += `[${encodeLiteralString(prefixText)}] TJ `;
    }

    // Target text in new font
    replacement += `/${newFontName} ${fontSize} Tf `;
    replacement += `[${encodeLiteralString(targetText)}] TJ `;

    // Restore original font
    replacement += `/${origFontName} ${fontSize} Tf`;

    // Suffix in original font (if any)
    if (suffixText) {
      replacement += ` [${encodeLiteralString(suffixText)}] TJ`;
    }

    // Find the end of the TJ operator (after the "TJ" keyword)
    const afterArray = stream.slice(tj.arrayEnd);
    const tjOpMatch = afterArray.match(/^\s*TJ/);
    const tjOpEnd = tj.arrayEnd + (tjOpMatch ? tjOpMatch[0].length : 0);

    const adjStart = tj.arrayStart + offset;
    const adjEnd = tjOpEnd + offset;
    result = result.slice(0, adjStart) + replacement + result.slice(adjEnd);
    offset += replacement.length - (tjOpEnd - tj.arrayStart);

    return { result, count: 1 };
  }

  // Fallback: try simple Tj operators
  const occurrences = extractTextOccurrences(stream);
  for (const occ of occurrences) {
    const idx = occ.text.indexOf(oldText);
    if (idx === -1) continue;

    const beforeText = stream.slice(0, occ.start);
    const allMatches = [...beforeText.matchAll(/\/(\S+)\s+([\d.]+)\s+Tf/g)];
    let origFontName = "TT0";
    let fontSize = "12";
    if (allMatches.length > 0) {
      const lastTf = allMatches[allMatches.length - 1];
      origFontName = lastTf[1];
      fontSize = lastTf[2];
    }

    // Find end of the Tj/TJ operator
    const opInfo = findNextOperator(stream, occ.end);
    const opEnd = opInfo ? opInfo.end : occ.end;

    const newFullText = occ.text.slice(0, idx) + newText + occ.text.slice(idx + oldText.length);
    const replacement = `/${newFontName} ${fontSize} Tf ${encodeLiteralString(newFullText)} Tj /${origFontName} ${fontSize} Tf`;

    const adjStart = occ.start + offset;
    const adjEnd = opEnd + offset;
    result = result.slice(0, adjStart) + replacement + result.slice(adjEnd);
    return { result, count: 1 };
  }

  return { result, count: 0 };
}

// --- Type0 / Identity-H hex glyph ID replacement ---

/**
 * Parse a PDF ToUnicode CMap stream to build GID↔Unicode mappings.
 */
export function parseToUnicodeCMap(cmapData: string): { gidToUnicode: Map<number, string>; unicodeToGid: Map<string, number> } {
  const gidToUnicode = new Map<number, string>();
  const unicodeToGid = new Map<string, number>();

  // Parse beginbfchar: <GID> <Unicode>
  const bfcharSections = cmapData.match(/beginbfchar\s*([\s\S]*?)endbfchar/g) || [];
  for (const section of bfcharSections) {
    for (const [, gidHex, uniHex] of section.matchAll(/<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>/g)) {
      const gid = parseInt(gidHex, 16);
      const ch = String.fromCharCode(parseInt(uniHex, 16));
      gidToUnicode.set(gid, ch);
      unicodeToGid.set(ch, gid);
    }
  }

  // Parse beginbfrange: <startGID> <endGID> <startUnicode>
  const bfrangeSections = cmapData.match(/beginbfrange\s*([\s\S]*?)endbfrange/g) || [];
  for (const section of bfrangeSections) {
    for (const [, startHex, endHex, uniStartHex] of section.matchAll(/<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>/g)) {
      const startGid = parseInt(startHex, 16);
      const endGid = parseInt(endHex, 16);
      let uniCode = parseInt(uniStartHex, 16);
      for (let gid = startGid; gid <= endGid; gid++) {
        const ch = String.fromCharCode(uniCode);
        gidToUnicode.set(gid, ch);
        unicodeToGid.set(ch, gid);
        uniCode++;
      }
    }
  }

  return { gidToUnicode, unicodeToGid };
}

/**
 * Replace text in a Type0/Identity-H content stream where text is encoded
 * as hex glyph IDs: <002B> Tj (one per character with Td positioning).
 *
 * Decodes hex strings to Unicode via the GID→Unicode map, finds the target
 * text, and re-encodes replacement characters back to hex GIDs.
 *
 * Returns null for characters that can't be encoded (missing from font).
 */
export function replaceHexTextInStream(
  stream: string,
  oldText: string,
  newText: string,
  gidToUnicode: Map<number, string>,
  unicodeToGid: Map<string, number>,
  lineContext?: string,
  selectionY?: number,
): { result: string; count: number; missingChars: string[] } {
  const missingChars: string[] = [];
  for (const ch of new Set(newText)) {
    if (!unicodeToGid.has(ch)) missingChars.push(ch);
  }

  // === BLOCK-LEVEL MATCHING ===
  // Split the stream into BT...ET blocks. Each block has a Tm position
  // and a sequence of hex-encoded characters. Match by:
  // 1. Decode each block's text
  // 2. Find blocks containing the old text
  // 3. Disambiguate by line context and/or y-coordinate

  interface HexOp { gid: number; char: string; hexStart: number; hexEnd: number; }
  interface TextBlock { blockStart: number; blockEnd: number; yPos: number; hexOps: HexOp[]; decoded: string; }

  const blocks: TextBlock[] = [];
  const btPattern = /BT\b([\s\S]*?)ET\b/g;
  let btMatch;

  while ((btMatch = btPattern.exec(stream)) !== null) {
    const blockContent = btMatch[1];
    const blockStart = btMatch.index;
    const blockEnd = btMatch.index + btMatch[0].length;

    // Extract Tm y-coordinate
    let yPos = 0;
    const tmMatch = blockContent.match(/[\d.e+-]+\s+[\d.e+-]+\s+[\d.e+-]+\s+[\d.e+-]+\s+([\d.e+-]+)\s+([\d.e+-]+)\s+Tm/);
    if (tmMatch) yPos = parseFloat(tmMatch[2]);

    // Extract hex operators within this block
    const hexOps: HexOp[] = [];
    const hexPattern = /<([0-9A-Fa-f]{4})>\s*Tj/g;
    let hm;
    while ((hm = hexPattern.exec(blockContent)) !== null) {
      const gid = parseInt(hm[1], 16);
      const absStart = blockStart + (btMatch[0].indexOf(blockContent)) + hm.index + 1;
      hexOps.push({
        gid,
        char: gidToUnicode.get(gid) || "",
        hexStart: absStart,
        hexEnd: absStart + 4,
      });
    }

    if (hexOps.length > 0) {
      blocks.push({ blockStart, blockEnd, yPos, hexOps, decoded: hexOps.map(o => o.char).join("") });
    }
  }

  if (blocks.length === 0) return { result: stream, count: 0, missingChars };

  // Find the target block: must contain oldText, prefer matching lineContext and yPos
  let targetBlock: TextBlock | null = null;
  let targetOffset = -1;

  // Strategy 1: Match full line context within a block
  if (lineContext && lineContext.length > oldText.length) {
    for (const block of blocks) {
      const lineIdx = block.decoded.indexOf(lineContext);
      if (lineIdx !== -1) {
        const oldIdx = lineContext.indexOf(oldText);
        if (oldIdx !== -1) {
          targetBlock = block;
          targetOffset = lineIdx + oldIdx;
          break;
        }
      }
    }
  }

  // Strategy 2: If line context didn't work, use y-coordinate to disambiguate
  if (!targetBlock && selectionY !== undefined) {
    const candidates = blocks.filter(b => b.decoded.includes(oldText));
    if (candidates.length > 0) {
      // Pick the block whose y-position is closest to the selection
      candidates.sort((a, b) => Math.abs(a.yPos - selectionY) - Math.abs(b.yPos - selectionY));
      targetBlock = candidates[0];
      targetOffset = targetBlock.decoded.indexOf(oldText);
    }
  }

  // Strategy 3: Fallback — first block containing oldText
  if (!targetBlock) {
    for (const block of blocks) {
      const idx = block.decoded.indexOf(oldText);
      if (idx !== -1) {
        targetBlock = block;
        targetOffset = idx;
        break;
      }
    }
  }

  if (!targetBlock || targetOffset === -1) return { result: stream, count: 0, missingChars };

  console.log(`[Type0] Matched in block at y=${targetBlock.yPos}, decoded="${targetBlock.decoded.substring(0, 40)}", offset=${targetOffset}`);

  // Now we have the exact hex operators to modify
  const hexOps = targetBlock.hexOps;
  const matchStartIdx = targetOffset;

  // Replace character by character
  let result = stream;
  let offset = 0;
  const spaceGid = unicodeToGid.get(" ");

  // Phase 1: Replace existing hex operators (up to oldText.length)
  for (let i = 0; i < oldText.length; i++) {
    const op = hexOps[matchStartIdx + i];
    let newHex: string;

    if (i < newText.length) {
      const gid = unicodeToGid.get(newText[i]);
      if (gid !== undefined) {
        newHex = gid.toString(16).padStart(4, "0");
      } else continue;
    } else {
      // Text is shorter: blank remaining with space
      if (spaceGid !== undefined) {
        newHex = spaceGid.toString(16).padStart(4, "0");
      } else continue;
    }

    result = result.slice(0, op.hexStart + offset) + newHex + result.slice(op.hexEnd + offset);
    // No offset change since hex is always 4 chars
  }

  // Phase 2: If new text is LONGER, insert new operators after the last matched one
  if (newText.length > oldText.length) {
    const lastOp = hexOps[matchStartIdx + oldText.length - 1];
    // Find the end of the last Tj operator (after "Tj")
    const afterLastOp = stream.slice(lastOp.hexEnd);
    const tjEnd = afterLastOp.match(/>\s*Tj/);
    const insertPoint = lastOp.hexEnd + (tjEnd ? tjEnd.index! + tjEnd[0].length : 5);

    // Calculate character advance from the LAST character in the matched text
    // (this gives us the advance width used in this specific text run)
    let charAdvance = 5; // default
    const lastMatchedOp = hexOps[matchStartIdx + oldText.length - 1];
    const beforeLast = stream.slice(Math.max(0, lastMatchedOp.hexStart - 40), lastMatchedOp.hexStart);
    const lastTdMatch = beforeLast.match(/([\d.]+)\s+0\s+Td\s*$/);
    if (lastTdMatch) {
      charAdvance = parseFloat(lastTdMatch[1]);
    } else {
      // Try any Td in the matched range
      for (let i = matchStartIdx + oldText.length - 1; i >= matchStartIdx; i--) {
        const before = stream.slice(Math.max(0, hexOps[i].hexStart - 40), hexOps[i].hexStart);
        const tdM = before.match(/([\d.]+)\s+0\s+Td\s*$/);
        if (tdM) { charAdvance = parseFloat(tdM[1]); break; }
      }
    }

    // Build the extra operators
    let extra = "";
    for (let i = oldText.length; i < newText.length; i++) {
      const gid = unicodeToGid.get(newText[i]);
      if (gid !== undefined) {
        const hex = gid.toString(16).padStart(4, "0");
        extra += `\n${charAdvance} 0 Td <${hex}> Tj`;
      }
    }

    if (extra) {
      result = result.slice(0, insertPoint + offset) + extra + result.slice(insertPoint + offset);
      offset += extra.length;
    }
  }

  return { result, count: 1, missingChars };
}

/**
 * Get all unique decoded text strings from the content stream.
 * Useful for building a "find" index.
 */
export function getAllText(stream: string): string {
  const occurrences = extractTextOccurrences(stream);
  return occurrences.map((o) => o.text).join("");
}

// --- Internal helpers ---

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\n" || ch === "\r" || ch === "\t" || ch === "\f" || ch === "\0";
}

function isTextOperator(op: string): boolean {
  return op === "Tj" || op === "TJ" || op === "'" || op === '"';
}

/** Read a balanced literal string starting at index i (must be '(') */
function readLiteralString(stream: string, i: number): string | null {
  if (stream[i] !== "(") return null;
  let depth = 1;
  let j = i + 1;
  while (j < stream.length && depth > 0) {
    if (stream[j] === "\\") {
      j += 2; // skip escape
      continue;
    }
    if (stream[j] === "(") depth++;
    if (stream[j] === ")") depth--;
    j++;
  }
  return depth === 0 ? stream.slice(i, j) : null;
}

/** Find the matching ] for a [ at position i */
function findMatchingBracket(stream: string, i: number): number {
  let depth = 1;
  let j = i + 1;
  while (j < stream.length && depth > 0) {
    if (stream[j] === "(") {
      const str = readLiteralString(stream, j);
      if (str) { j += str.length; continue; }
    }
    if (stream[j] === "[") depth++;
    if (stream[j] === "]") depth--;
    j++;
  }
  return depth === 0 ? j - 1 : -1;
}

/** Find the next PDF operator after position i (skip whitespace) */
function findNextOperator(stream: string, i: number): { op: string; start: number; end: number } | null {
  let j = i;
  while (j < stream.length && isWhitespace(stream[j])) j++;
  // Operators are alphabetic sequences (or ' or ")
  if (j >= stream.length) return null;
  const start = j;
  if (stream[j] === "'" || stream[j] === '"') {
    return { op: stream[j], start, end: j + 1 };
  }
  while (j < stream.length && /[a-zA-Z*]/.test(stream[j])) j++;
  if (j === start) return null;
  return { op: stream.slice(start, j), start, end: j };
}

/** Extract literal/hex strings from inside a TJ array */
function extractStringsFromTJArray(
  content: string,
  baseOffset: number,
  operator: string,
  results: TextOccurrence[]
): void {
  let i = 0;
  while (i < content.length) {
    if (content[i] === "(") {
      const raw = readLiteralString(content, i);
      if (raw) {
        results.push({
          text: decodeLiteralString(raw),
          start: baseOffset + i,
          end: baseOffset + i + raw.length,
          raw,
          isHex: false,
          operator,
        });
        i += raw.length;
        continue;
      }
    }
    if (content[i] === "<" && i + 1 < content.length && content[i + 1] !== "<") {
      const closeIdx = content.indexOf(">", i + 1);
      if (closeIdx !== -1) {
        const raw = content.slice(i, closeIdx + 1);
        results.push({
          text: decodeHexString(raw),
          start: baseOffset + i,
          end: baseOffset + i + raw.length,
          raw,
          isHex: true,
          operator,
        });
        i = closeIdx + 1;
        continue;
      }
    }
    i++;
  }
}
