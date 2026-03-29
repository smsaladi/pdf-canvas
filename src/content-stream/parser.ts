// Content stream parsing: text occurrence extraction, TJ array parsing, helpers
import { decodeLiteralString, decodeHexString } from "./encoding";

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

/** A TJ array with its position in the stream and decoded fragments */
export interface TJArrayInfo {
  /** Start offset of the '[' in the stream */
  arrayStart: number;
  /** End offset (after the ']') in the stream */
  arrayEnd: number;
  /** The full concatenated decoded text */
  fullText: string;
  /** Individual string fragments with their positions */
  fragments: Array<{
    text: string;
    start: number;
    end: number;
    isHex: boolean;
  }>;
  /** Raw content between [ and ] */
  rawContent: string;
}

// --- Internal helpers ---

export function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\n" || ch === "\r" || ch === "\t" || ch === "\f" || ch === "\0";
}

export function isTextOperator(op: string): boolean {
  return op === "Tj" || op === "TJ" || op === "'" || op === '"';
}

/** Read a balanced literal string starting at index i (must be '(') */
export function readLiteralString(stream: string, i: number): string | null {
  if (stream[i] !== "(") return null;
  let depth = 1;
  let j = i + 1;
  while (j < stream.length && depth > 0) {
    if (stream[j] === "\\") {
      j += 2;
      continue;
    }
    if (stream[j] === "(") depth++;
    if (stream[j] === ")") depth--;
    j++;
  }
  return depth === 0 ? stream.slice(i, j) : null;
}

/** Find the matching ] for a [ at position i */
export function findMatchingBracket(stream: string, i: number): number {
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
export function findNextOperator(stream: string, i: number): { op: string; start: number; end: number } | null {
  let j = i;
  while (j < stream.length && isWhitespace(stream[j])) j++;
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
export function extractStringsFromTJArray(
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

/**
 * Extract all text string occurrences from a PDF content stream.
 * Finds Tj, TJ, ', " operators and their string operands.
 */
export function extractTextOccurrences(stream: string): TextOccurrence[] {
  const results: TextOccurrence[] = [];
  let i = 0;

  while (i < stream.length) {
    if (isWhitespace(stream[i])) { i++; continue; }

    if (stream[i] === "%") {
      while (i < stream.length && stream[i] !== "\n" && stream[i] !== "\r") i++;
      continue;
    }

    if (stream[i] === "(") {
      const start = i;
      const raw = readLiteralString(stream, i);
      if (raw !== null) {
        const end = start + raw.length;
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

    if (stream[i] === "[") {
      const start = i;
      const arrayEnd = findMatchingBracket(stream, i);
      if (arrayEnd !== -1) {
        const end = arrayEnd + 1;
        const opInfo = findNextOperator(stream, end);
        if (opInfo && opInfo.op === "TJ") {
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

/** Find all TJ arrays in the stream with their concatenated text */
export function findTJArrays(stream: string): TJArrayInfo[] {
  const results: TJArrayInfo[] = [];
  let i = 0;

  while (i < stream.length) {
    if (stream[i] === "%") { while (i < stream.length && stream[i] !== "\n") i++; continue; }

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

/** Get all unique decoded text strings from the content stream */
export function getAllText(stream: string): string {
  const occurrences = extractTextOccurrences(stream);
  return occurrences.map((o) => o.text).join("");
}
