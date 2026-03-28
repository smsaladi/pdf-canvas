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

/**
 * Find and replace text in a content stream.
 * Returns the modified stream and the number of replacements made.
 */
export function replaceTextInStream(
  stream: string,
  oldText: string,
  newText: string,
  replaceAll = false
): { result: string; count: number } {
  const occurrences = extractTextOccurrences(stream);
  let result = stream;
  let count = 0;
  let offset = 0;

  for (const occ of occurrences) {
    const idx = occ.text.indexOf(oldText);
    if (idx === -1) continue;

    // Replace within the decoded text
    const newDecodedText = occ.text.slice(0, idx) + newText + occ.text.slice(idx + oldText.length);

    // Re-encode
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
