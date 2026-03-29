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

/**
 * Replace a specific text occurrence in the content stream.
 * Returns the modified stream string.
 */
export function replaceTextAt(
  stream: string,
  occurrence: TextOccurrence,
  newText: string
): string {
  const encoded = occurrence.isHex
    ? encodeHexString(newText)
    : encodeLiteralString(newText);

  return stream.slice(0, occurrence.start) + encoded + stream.slice(occurrence.end);
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
