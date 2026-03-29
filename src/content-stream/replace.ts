// Text replacement in content streams: simple and font-switching
import { encodeLiteralString } from "./encoding";
import { extractTextOccurrences, findTJArrays, findNextOperator } from "./parser";
import type { TextOccurrence } from "./parser";
import { encodeHexString } from "./encoding";

/**
 * Find and replace text in a content stream.
 * Handles both simple Tj strings and TJ arrays where text is split
 * across multiple kerned fragments (common in real-world PDFs).
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

    const newFullText = tj.fullText.slice(0, idx) + newText + tj.fullText.slice(idx + oldText.length);
    const newArrayContent = encodeLiteralString(newFullText);

    const adjStart = tj.arrayStart + offset;
    const adjEnd = tj.arrayEnd + offset;
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
 * Used for per-word bold/italic changes.
 */
export function replaceTextWithFontSwitch(
  stream: string,
  oldText: string,
  newText: string,
  newFontName: string,
): { result: string; count: number } {
  const tjArrays = findTJArrays(stream);
  let result = stream;
  let offset = 0;

  for (const tj of tjArrays) {
    const idx = tj.fullText.indexOf(oldText);
    if (idx === -1) continue;

    const beforeText = stream.slice(0, tj.arrayStart);
    const tfMatch = beforeText.match(/\/(\S+)\s+([\d.]+)\s+Tf\s*$/s)
      || beforeText.match(/\/(\S+)\s+([\d.]+)\s+Tf/gs);

    let origFontName = "TT0";
    let fontSize = "12";

    if (tfMatch) {
      const allMatches = [...beforeText.matchAll(/\/(\S+)\s+([\d.]+)\s+Tf/g)];
      if (allMatches.length > 0) {
        const lastTf = allMatches[allMatches.length - 1];
        origFontName = lastTf[1];
        fontSize = lastTf[2];
      }
    }

    const newFullText = tj.fullText.slice(0, idx) + newText + tj.fullText.slice(idx + oldText.length);
    const prefixText = newFullText.slice(0, idx);
    const targetText = newText;
    const suffixText = newFullText.slice(idx + newText.length);

    let replacement = "";
    if (prefixText) {
      replacement += `[${encodeLiteralString(prefixText)}] TJ `;
    }
    replacement += `/${newFontName} ${fontSize} Tf `;
    replacement += `[${encodeLiteralString(targetText)}] TJ `;
    replacement += `/${origFontName} ${fontSize} Tf`;
    if (suffixText) {
      replacement += ` [${encodeLiteralString(suffixText)}] TJ`;
    }

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
