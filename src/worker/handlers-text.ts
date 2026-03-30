// Worker handlers: text extraction, replacement, search
import * as mupdf from "mupdf";
import type { WorkerResponse, TextBlock, TextLine, TextSearchResult } from "../types";
import { getDoc } from "./doc-state";
import { tryReplaceInStreams } from "./stream-utils";
import { replaceTextInStream as replaceInStream, replaceTextWithFontSwitch, parseToUnicodeCMap, replaceHexTextInStream } from "../content-stream";
import { parseFontName, matchReferenceFont, fetchFont, augmentFont } from "../font-augment";
import { buildGlyphMap, findMappingsForSelection, editMappedGlyphs } from "../content-map";

type Respond = (rpcId: number | undefined, response: WorkerResponse, transfer?: Transferable[]) => void;

export function handleExtractText(request: any, respond: Respond, rpcId: number | undefined) {
  const page = getDoc().loadPage(request.page);
  const stext = page.toStructuredText();
  const blocks: TextBlock[] = [];
  let currentBlock: TextBlock | null = null;
  let currentLine: TextLine | null = null;
  stext.walk({
    beginTextBlock(bbox: any) { currentBlock = { bbox: bbox as any, lines: [] }; },
    beginLine(bbox: any, wmode: number) { currentLine = { bbox: bbox as any, wmode, chars: [] }; },
    onChar(c: string, origin: any, font: any, size: number, quad: any, color: any) {
      if (currentLine) currentLine.chars.push({
        c, origin: origin as any, quad: quad as any, fontSize: size, fontName: font.getName(),
        fontFlags: { isMono: font.isMono(), isSerif: font.isSerif(), isBold: font.isBold(), isItalic: font.isItalic() },
        color: color ? (Array.isArray(color) ? color : [0, 0, 0]) : [0, 0, 0],
      });
    },
    endLine() { if (currentBlock && currentLine) { currentBlock.lines.push(currentLine); currentLine = null; } },
    endTextBlock() { if (currentBlock) { blocks.push(currentBlock); currentBlock = null; } },
  });
  respond(rpcId, { type: "textExtracted", page: request.page, data: { page: request.page, blocks } });
}

export function handleReplaceTextInStream(request: any, respond: Respond, rpcId: number | undefined) {
  const contentsRef = (getDoc().loadPage(request.page) as mupdf.PDFPage).getObject().get("Contents");
  let totalCount = 0;
  tryReplaceInStreams(contentsRef, (data) => {
    const { result, count } = replaceInStream(data, request.oldText, request.newText, request.replaceAll ?? false);
    if (count > 0) { totalCount += count; return result; }
    return null;
  });
  respond(rpcId, { type: "textReplaced", page: request.page, count: totalCount });
}

export async function handleReplaceTextSmart(request: any, respond: Respond, rpcId: number | undefined) {
  const page = getDoc().loadPage(request.page) as mupdf.PDFPage;
  const pageObj = page.getObject();
  const contentsRef = pageObj.get("Contents");

  // === NEW: Deterministic mapping-based approach ===
  const selY = (request as any).selectionY;
  const selX = 0; // X not critical for disambiguation

  if (selY !== undefined) {
    try {
      console.log(`[ContentMap] Building glyph map for page ${request.page}...`);
      const glyphMap = buildGlyphMap(page);
      console.log(`[ContentMap] Mapped ${glyphMap.length} glyphs`);

      if (glyphMap.length > 0) {
        const selection = findMappingsForSelection(glyphMap, request.oldText, selX, selY);
        if (selection && selection.length > 0) {
          console.log(`[ContentMap] Found "${request.oldText}" at y=${selection[0].y.toFixed(1)} (isHex=${selection[0].isHex})`);

          // Read all streams
          const streams: string[] = [];
          if (contentsRef.isArray()) {
            for (let i = 0; i < contentsRef.length; i++) {
              const ref = contentsRef.get(i);
              streams.push(ref.isStream() ? ref.readStream().asString() : "");
            }
          } else if (contentsRef.isStream()) {
            streams.push(contentsRef.readStream().asString());
          }

          // Build Unicode→GID map for hex fonts
          let unicodeToGid: Map<string, number> | undefined;
          if (selection[0].isHex) {
            const fontDict = pageObj.get("Resources")?.get("Font");
            if (fontDict && !fontDict.isNull()) {
              const fontKeys: string[] = [];
              fontDict.forEach((_: any, k: string | number) => fontKeys.push(String(k)));
              for (const fk of fontKeys) {
                const fo = fontDict.get(fk);
                const toUnicode = fo.get("ToUnicode");
                if (toUnicode.isStream()) {
                  const { unicodeToGid: u2g } = parseToUnicodeCMap(toUnicode.readStream().asString());
                  unicodeToGid = u2g;
                  break;
                }
              }
            }
          }

          // For same-length replacement: edit in place
          if (request.newText.length <= request.oldText.length) {
            const newChars = [...request.newText];
            // Pad with spaces if shorter
            while (newChars.length < selection.length) newChars.push(" ");
            const edited = editMappedGlyphs(streams, selection, newChars, unicodeToGid);

            // Write back
            if (contentsRef.isArray()) {
              for (let i = 0; i < Math.min(contentsRef.length, edited.length); i++) {
                const ref = contentsRef.get(i);
                if (ref.isStream()) ref.writeStream(edited[i]);
              }
            } else if (contentsRef.isStream()) {
              contentsRef.writeStream(edited[0]);
            }

            console.log(`[ContentMap] ✓ Edited ${selection.length} glyphs via mapping`);
            respond(rpcId, { type: "textReplacedSmart", page: request.page, count: 1, method: "content-stream" });
            return;
          }

          // For longer text: edit existing chars + append extras (hex only)
          if (request.newText.length > request.oldText.length && selection[0].isHex && unicodeToGid) {
            const existingChars = [...request.newText.slice(0, request.oldText.length)];
            const edited = editMappedGlyphs(streams, selection, existingChars, unicodeToGid);

            const lastMapping = selection[selection.length - 1];
            const extraChars: string = request.newText.slice(request.oldText.length);
            let extra = "";

            // === CALIBRATED ADVANCE WIDTHS ===
            let advanceScale = 5; // fallback
            try {
              const selStart = glyphMap.findIndex(g =>
                Math.abs(g.y - selection[0].y) < 1 && g.char === selection[0].char
              );
              if (selStart >= 0 && selStart + 1 < glyphMap.length) {
                const advances: Array<{ actual: number; fontAdvance: number }> = [];
                for (let gi = selStart; gi < Math.min(selStart + selection.length - 1, glyphMap.length - 1); gi++) {
                  const curr = glyphMap[gi];
                  const next = glyphMap[gi + 1];
                  if (Math.abs(curr.y - next.y) < 1) {
                    const actualAdv = next.x - curr.x;
                    if (actualAdv > 0 && actualAdv < 50) {
                      advances.push({ actual: actualAdv, fontAdvance: 1 });
                    }
                  }
                }

                if (advances.length > 0) {
                  let fontForMetrics: mupdf.Font | null = null;
                  const fDict = pageObj.get("Resources")?.get("Font");
                  if (fDict && !fDict.isNull()) {
                    const fKeys: string[] = [];
                    fDict.forEach((_: any, k: string | number) => fKeys.push(String(k)));
                    for (const fk of fKeys) {
                      const fo = fDict.get(fk);
                      if (fo.get("Subtype").asName() === "Type0") {
                        // Match against the font used by the selected text
                        const bfn = fo.get("BaseFont").asName();
                        if (request.fontName && bfn !== request.fontName) continue;
                        const desc = fo.get("DescendantFonts");
                        if (desc.isArray() && desc.length > 0) {
                          const ff2 = desc.get(0).get("FontDescriptor")?.get("FontFile2");
                          if (ff2?.isStream()) {
                            const fd = ff2.readStream().asUint8Array();
                            const buf = new ArrayBuffer(fd.byteLength);
                            new Uint8Array(buf).set(fd);
                            fontForMetrics = new mupdf.Font("metrics", buf);
                          }
                        }
                        break;
                      }
                    }
                  }

                  if (fontForMetrics) {
                    const ratios: number[] = [];
                    for (let gi = selStart; gi < Math.min(selStart + selection.length - 1, glyphMap.length - 1); gi++) {
                      const curr = glyphMap[gi];
                      const next = glyphMap[gi + 1];
                      if (Math.abs(curr.y - next.y) < 1) {
                        const actualAdv = next.x - curr.x;
                        const fontAdv = fontForMetrics.advanceGlyph(curr.glyphId);
                        if (fontAdv > 0.01 && actualAdv > 0) {
                          ratios.push(actualAdv / fontAdv);
                        }
                      }
                    }
                    if (ratios.length > 0) {
                      advanceScale = ratios.reduce((a, b) => a + b, 0) / ratios.length;
                      console.log(`[ContentMap] Calibrated advanceScale=${advanceScale.toFixed(2)} from ${ratios.length} samples`);
                    }

                    const lastOrigGid = selection[selection.length - 1].glyphId;
                    let prevCharAdvance = Math.round(fontForMetrics.advanceGlyph(lastOrigGid) * advanceScale * 10) / 10;
                    let skippedAdvance = 0;

                    // Check for chars missing from CMap and augment if needed
                    const missingFromCmap = [...new Set(extraChars)].filter((ch: string) => !unicodeToGid!.get(ch));
                    if (missingFromCmap.length > 0 && unicodeToGid) {
                      console.log(`[ContentMap] Characters missing from CMap: ${missingFromCmap.join("")} — augmenting font + CMap`);
                      try {
                        const fDict2 = pageObj.get("Resources")?.get("Font");
                        if (fDict2) {
                          const fKeys2: string[] = [];
                          fDict2.forEach((_: any, k: string | number) => fKeys2.push(String(k)));
                          for (const fk of fKeys2) {
                            const fo = fDict2.get(fk);
                            if (fo.get("Subtype").asName() !== "Type0") continue;
                            // Match against the font used by the selected text
                            const augBaseName = fo.get("BaseFont").asName();
                            if (request.fontName && augBaseName !== request.fontName) continue;

                            const descFonts = fo.get("DescendantFonts");
                            if (!descFonts.isArray() || descFonts.length === 0) continue;
                            const cidFont = descFonts.get(0);
                            const fontDesc = cidFont.get("FontDescriptor");
                            if (fontDesc.isNull()) continue;
                            const ff2 = fontDesc.get("FontFile2");
                            if (!ff2.isStream()) continue;

                            const fontBytes = ff2.readStream().asUint8Array();
                            const fontBuf = new ArrayBuffer(fontBytes.byteLength);
                            new Uint8Array(fontBuf).set(fontBytes);

                            const parsed = parseFontName(augBaseName);
                            const match = matchReferenceFont(parsed);
                            const refBuf = fetchFont(match);
                            if (!refBuf) continue;

                            // Count glyphs in original font to predict GIDs assigned by augmentFont
                            const FEFont2 = (await import("fonteditor-core")).Font;
                            const origParsed = FEFont2.create(fontBuf.slice(0) as any, { type: "ttf" });
                            const origData = origParsed.get();
                            const origGlyphCount = origData?.glyf?.length || 0;
                            const origCmap = origData?.cmap || {};

                            // forceNewSlots=true: CID font cmap is unreliable for subsetted fonts
                            const augmented = augmentFont(fontBuf, refBuf, missingFromCmap, true);
                            if (augmented) {
                              // Write augmented font bytes directly to the FontFile2 stream
                              // This preserves the Type0 font structure (ToUnicode, CIDFont, etc.)
                              ff2.writeStream(new Uint8Array(augmented));
                              mupdf.emptyStore();
                              console.log(`[ContentMap] ✓ Augmented font "${augBaseName}" with ${missingFromCmap.length} glyph(s)`);

                              // Map chars to GIDs: with forceNewSlots=true (CID fonts),
                              // augmentFont always creates sequential GIDs starting from origGlyphCount.
                              // The font's internal cmap is unreliable for CID fonts, so we NEVER
                              // use origCmap here — all missing chars get new GIDs.
                              let nextGid = origGlyphCount;
                              for (const ch of missingFromCmap) {
                                const cp = ch.charCodeAt(0);
                                unicodeToGid!.set(ch, nextGid);
                                console.log(`[ContentMap] Mapped "${ch}" (U+${cp.toString(16)}) → GID ${nextGid} (0x${nextGid.toString(16)})`);
                                nextGid++;
                              }
                              // Reload fontForMetrics from augmented data so advanceGlyph works for new GIDs
                              fontForMetrics = new mupdf.Font("metrics", augmented);

                              // Update the CIDFont W (widths) array for new GIDs
                              // Without this, MuPDF uses DW (default width) for spacing
                              try {
                                const wArray = cidFont.get("W");
                                const unitsPerEm = origData?.head?.unitsPerEm || 2048;
                                // Build width entries: [gid [width]] for each new glyph
                                // Reference font advance widths are in font design units
                                const newWidthEntries: Array<{ gid: number; width: number }> = [];
                                let widthGidCounter = origGlyphCount;
                                for (const ch2 of missingFromCmap) {
                                  const advW = fontForMetrics.advanceGlyph(widthGidCounter);
                                  const cidWidth = Math.round(advW * 1000);
                                  newWidthEntries.push({ gid: widthGidCounter, width: cidWidth });
                                  widthGidCounter++;
                                }
                                if (newWidthEntries.length > 0 && wArray && !wArray.isNull()) {
                                  // Append new entries to existing W array
                                  // W array format: [gid [w1 w2 ...] gid [w1 w2 ...] ...]
                                  for (const { gid: wGid, width: wWidth } of newWidthEntries) {
                                    const wLen = wArray.length;
                                    wArray.push(wGid);
                                    const widthArr = getDoc().newArray();
                                    widthArr.push(wWidth);
                                    wArray.push(widthArr);
                                  }
                                  console.log(`[ContentMap] Updated W array with ${newWidthEntries.length} new width entries`);
                                }
                              } catch (wErr) {
                                console.warn("[ContentMap] Failed to update W array:", wErr);
                              }

                              // Update the ToUnicode CMap to include entries for newly added GIDs
                              // Without this, text extraction shows � for new glyphs
                              const toUnicode = fo.get("ToUnicode");
                              if (toUnicode && toUnicode.isStream()) {
                                let cmapData = toUnicode.readStream().asString();
                                // Build new bfchar entries for the injected glyphs
                                // All missing chars get sequential new GIDs (matching augmentFont with forceNewSlots)
                                const newEntries: string[] = [];
                                let gidCounter = origGlyphCount;
                                for (const ch of missingFromCmap) {
                                  const cp = ch.charCodeAt(0);
                                  newEntries.push(`<${gidCounter.toString(16).padStart(4, "0")}> <${cp.toString(16).padStart(4, "0")}>`);
                                  gidCounter++;
                                }
                                if (newEntries.length > 0) {
                                  // Insert before "endcmap" at the end
                                  const insertPoint = cmapData.lastIndexOf("endcmap");
                                  if (insertPoint !== -1) {
                                    const bfcharBlock = `${newEntries.length} beginbfchar\n${newEntries.join("\n")}\nendbfchar\n`;
                                    cmapData = cmapData.slice(0, insertPoint) + bfcharBlock + cmapData.slice(insertPoint);
                                    toUnicode.writeStream(cmapData);
                                    console.log(`[ContentMap] Updated ToUnicode CMap with ${newEntries.length} new entries`);
                                  }
                                }
                              }
                            }
                            break;
                          }
                        }
                      } catch (augErr) {
                        console.warn("[ContentMap] Type0 font augmentation failed:", augErr);
                      }
                    }

                    for (const ch of extraChars) {
                      const gid = unicodeToGid.get(ch);
                      if (gid !== undefined) {
                        const td = Math.round((prevCharAdvance + skippedAdvance) * 10) / 10;
                        extra += `\n${td} 0 Td <${gid.toString(16).padStart(4, "0")}> Tj`;
                        prevCharAdvance = Math.round(fontForMetrics.advanceGlyph(gid) * advanceScale * 10) / 10;
                        skippedAdvance = 0;
                      } else {
                        skippedAdvance += Math.round(advanceScale * 0.5 * 10) / 10;
                        console.log(`[ContentMap] Still can't encode "${ch}" (U+${ch.charCodeAt(0).toString(16)})`);
                      }
                    }
                  }
                }
              }
            } catch (advErr) {
              console.warn("[ContentMap] Advance calibration failed:", advErr);
            }

            // Fallback: if calibration didn't produce results, use fixed advance
            if (!extra && extraChars.length > 0) {
              for (const ch of extraChars) {
                const gid = unicodeToGid.get(ch);
                if (gid !== undefined) {
                  extra += `\n5 0 Td <${gid.toString(16).padStart(4, "0")}> Tj`;
                }
              }
            }

            if (extra) {
              const stream = edited[lastMapping.streamIndex];
              const afterLastEdit = stream.slice(lastMapping.hexEnd);

              // Check if we're inside a TJ array by looking for ] before the next operator
              const closeBracket = afterLastEdit.match(/^[^)(\]]*?\]\s*TJ/);

              if (closeBracket) {
                // Inside a TJ array — build hex strings to insert inside the array
                // TJ arrays use the font's natural advance width, so we just append hex strings
                let tjExtra = "";
                for (const ch of extraChars) {
                  const gid = unicodeToGid.get(ch);
                  if (gid !== undefined) {
                    tjExtra += `<${gid.toString(16).padStart(4, "0")}>`;
                  }
                }
                if (tjExtra) {
                  // Find the ] closing the array and insert before it
                  const bracketPos = afterLastEdit.indexOf("]");
                  const insertAt = lastMapping.hexEnd + bracketPos;
                  edited[lastMapping.streamIndex] = stream.slice(0, insertAt) + tjExtra + stream.slice(insertAt);
                }
              } else {
                // Standalone Tj operators — use Td positioning
                const tjEndMatch = afterLastEdit.match(/>\s*Tj/);
                let insertAt: number;
                if (tjEndMatch) {
                  insertAt = lastMapping.hexEnd + tjEndMatch.index! + tjEndMatch[0].length;
                } else {
                  const etMatch = afterLastEdit.match(/ET/);
                  insertAt = lastMapping.hexEnd + (etMatch ? etMatch.index! : 5);
                  extra = `\nBT${extra}\nET`;
                }
                edited[lastMapping.streamIndex] = stream.slice(0, insertAt) + extra + stream.slice(insertAt);
              }
            }

            if (contentsRef.isArray()) {
              for (let i = 0; i < Math.min(contentsRef.length, edited.length); i++) {
                const ref = contentsRef.get(i);
                if (ref.isStream()) ref.writeStream(edited[i]);
              }
            } else if (contentsRef.isStream()) {
              contentsRef.writeStream(edited[0]);
            }

            console.log(`[ContentMap] ✓ Edited ${selection.length} + appended ${extraChars.length} glyphs via mapping`);
            respond(rpcId, { type: "textReplacedSmart", page: request.page, count: 1, method: "content-stream" });
            return;
          }
        } else {
          console.log(`[ContentMap] Selection not found in mapping, falling back`);
        }
      }
    } catch (mapErr) {
      console.warn(`[ContentMap] Mapping failed, falling back:`, mapErr);
    }
  }

  // === FALLBACK: Old approach (for cases without selectionY or when mapping fails) ===

  const tryStreamReplace = (streamRef: any): boolean => {
    if (!streamRef.isStream()) return false;
    const { result, count } = replaceInStream(streamRef.readStream().asString(), request.oldText, request.newText);
    if (count > 0) { streamRef.writeStream(result); return true; }
    return false;
  };
  const doStreamReplace = (): boolean => {
    if (contentsRef.isArray()) { for (let i = 0; i < contentsRef.length; i++) if (tryStreamReplace(contentsRef.get(i))) return true; }
    else if (contentsRef.isStream() && tryStreamReplace(contentsRef)) return true;
    return false;
  };

  const allNewTextChars: string[] = [...new Set(request.newText as string)].filter(c => c.trim());
  let augmentedAnyFont = false;
  const hasStyleOverride = request.boldOverride !== undefined || request.italicOverride !== undefined;
  console.log(`[FontAugment] Checking ${allNewTextChars.length} unique chars: "${allNewTextChars.join("")}"${hasStyleOverride ? " [style override]" : ""}`);

  try {
    const resources = pageObj.get("Resources");
    const fontDict = (!resources.isNull()) ? resources.get("Font") : null;
    if (fontDict && !fontDict.isNull()) {
      const fontKeys: string[] = [];
      fontDict.forEach((_: any, key: string | number) => { fontKeys.push(String(key)); });
      console.log(`[FontAugment] Page has ${fontKeys.length} font(s): ${fontKeys.join(", ")}`);

      for (const fontKey of fontKeys) {
        try {
          const fontObj = fontDict.get(fontKey);
          const subtype = fontObj.get("Subtype").asName();
          const baseFontName = fontObj.get("BaseFont").asName();
          if (subtype !== "TrueType") { console.log(`[FontAugment] Skip /${fontKey} (${subtype})`); continue; }
          if (request.fontName && baseFontName !== request.fontName) { console.log(`[FontAugment] Skip /${fontKey} (not ${request.fontName})`); continue; }
          const encoding = fontObj.get("Encoding");
          const encodingName = encoding.isName() ? encoding.asName() : "";
          if (encodingName !== "WinAnsiEncoding" && encodingName !== "MacRomanEncoding") { console.log(`[FontAugment] Skip /${fontKey} (${encodingName})`); continue; }
          const descriptor = fontObj.get("FontDescriptor");
          if (descriptor.isNull()) continue;
          const fontFile2 = descriptor.get("FontFile2");
          if (!fontFile2.isStream()) continue;

          const subsetArray = fontFile2.readStream().asUint8Array();
          const subsetBuffer = new ArrayBuffer(subsetArray.byteLength);
          new Uint8Array(subsetBuffer).set(subsetArray);
          console.log(`[FontAugment] Extracted /${fontKey} "${baseFontName}" (${subsetArray.byteLength} bytes)`);

          const missingInThisFont: string[] = [];
          try {
            const opentype = await import("opentype.js");
            const parsedFont = opentype.parse(subsetBuffer);
            if (parsedFont) {
              for (const ch of allNewTextChars) {
                const glyph = parsedFont.charToGlyph(ch);
                if (!glyph || glyph.index === 0 || !glyph.path?.commands?.length) {
                  missingInThisFont.push(ch);
                  console.log(`[FontAugment]   "${ch}" → MISSING`);
                }
              }
            }
          } catch { missingInThisFont.push(...allNewTextChars); }

          console.log(`[FontAugment] /${fontKey}: missing=[${missingInThisFont.join("")}]`);
          if (missingInThisFont.length === 0 && !hasStyleOverride) continue;

          const parsed = parseFontName(baseFontName);
          const flags = descriptor.get("Flags")?.asNumber?.() || 0;
          const match = matchReferenceFont(parsed, flags);
          if (request.boldOverride !== undefined) match.bold = request.boldOverride;
          if (request.italicOverride !== undefined) match.italic = request.italicOverride;

          // Style-only: add new font + font-switch operators
          if (hasStyleOverride && missingInThisFont.length === 0) {
            const refBuffer = fetchFont(match);
            if (!refBuffer) continue;
            const newFont = new mupdf.Font(baseFontName + "_edit", refBuffer);
            const editFontKey = "F_edit_" + Date.now();
            fontDict.put(editFontKey, getDoc().addSimpleFont(newFont, "Latin"));
            console.log(`[FontAugment] Added /${editFontKey} for style switch`);
            const doSwitch = (): boolean => {
              const cr = pageObj.get("Contents");
              if (cr.isArray()) { for (let i = 0; i < cr.length; i++) { const s = cr.get(i); if (!s.isStream()) continue; const { result, count } = replaceTextWithFontSwitch(s.readStream().asString(), request.oldText, request.newText, editFontKey); if (count > 0) { s.writeStream(result); return true; } } }
              else if (cr.isStream()) { const { result, count } = replaceTextWithFontSwitch(cr.readStream().asString(), request.oldText, request.newText, editFontKey); if (count > 0) { cr.writeStream(result); return true; } }
              return false;
            };
            if (doSwitch()) { respond(rpcId, { type: "textReplacedSmart", page: request.page, count: 1, method: "font-augment" }); return; }
            continue;
          }

          // Glyph augmentation: inject missing glyphs + replace font
          const refBuffer = fetchFont(match);
          if (!refBuffer) continue;
          let fontBufferToUse: ArrayBuffer;
          if (missingInThisFont.length > 0) {
            // Subsetted fonts (ABCDEF+ prefix) have unreliable cmaps — force new slots
            const isSubsetted = /^[A-Z]{6}\+/.test(baseFontName);
            const augmented = augmentFont(subsetBuffer, refBuffer, missingInThisFont, isSubsetted);
            if (!augmented) continue;
            fontBufferToUse = augmented;
            console.log(`[FontAugment] Augmented ${missingInThisFont.length} glyph(s)`);
          } else {
            fontBufferToUse = refBuffer;
          }
          const newFont = new mupdf.Font(baseFontName, fontBufferToUse);
          fontDict.put(fontKey, getDoc().addSimpleFont(newFont, "Latin"));
          console.log(`[FontAugment] ✓ Replaced /${fontKey} (${fontBufferToUse.byteLength} bytes)`);
          augmentedAnyFont = true;
        } catch (fontErr) { console.warn(`[FontAugment] Error on /${fontKey}:`, fontErr); }
      }
    }
  } catch (err) { console.warn("[FontAugment] Failed:", err); }

  if (augmentedAnyFont) { mupdf.emptyStore(); console.log(`[FontAugment] Cleared cache`); }
  if (doStreamReplace()) {
    respond(rpcId, { type: "textReplacedSmart", page: request.page, count: 1, method: augmentedAnyFont ? "font-augment" : "content-stream" });
    return;
  }
  // --- Tier 2: Type0/Identity-H hex glyph replacement ---
  console.log(`[Type0] Trying hex glyph replacement...`);
  try {
    const resources2 = pageObj.get("Resources");
    const fontDict2 = (!resources2.isNull()) ? resources2.get("Font") : null;
    if (fontDict2 && !fontDict2.isNull()) {
      const fontKeys2: string[] = [];
      fontDict2.forEach((_: any, key: string | number) => { fontKeys2.push(String(key)); });

      for (const fk of fontKeys2) {
        const fo = fontDict2.get(fk);
        if (fo.get("Subtype").asName() !== "Type0") continue;
        const bfn = fo.get("BaseFont").asName();
        if (request.fontName && bfn !== request.fontName) continue;

        const toUnicode = fo.get("ToUnicode");
        if (!toUnicode.isStream()) { console.log(`[Type0] No ToUnicode for ${bfn}`); continue; }

        const { gidToUnicode, unicodeToGid: u2g } = parseToUnicodeCMap(toUnicode.readStream().asString());
        console.log(`[Type0] Parsed CMap for "${bfn}": ${gidToUnicode.size} mappings`);

        const lineCtx = (request as any).lineContext || "";
        const selYFallback = (request as any).selectionY;
        const tryHex = (ref: any): boolean => {
          if (!ref.isStream()) return false;
          const { result, count, missingChars } = replaceHexTextInStream(ref.readStream().asString(), request.oldText, request.newText, gidToUnicode, u2g, lineCtx, selYFallback);
          if (missingChars.length > 0) console.log(`[Type0] Missing chars: ${missingChars.join(", ")}`);
          if (count > 0) { ref.writeStream(result); return true; }
          return false;
        };

        let ok = false;
        if (contentsRef.isArray()) { for (let i = 0; i < contentsRef.length; i++) if (tryHex(contentsRef.get(i))) { ok = true; break; } }
        else if (contentsRef.isStream()) ok = tryHex(contentsRef);

        if (ok) {
          console.log(`[Type0] ✓ Hex replacement succeeded`);
          respond(rpcId, { type: "textReplacedSmart", page: request.page, count: 1, method: "content-stream" });
          return;
        }
      }
    }
  } catch (err) { console.warn("[Type0] Failed:", err); }

  console.warn(`[TextEdit] All methods failed for "${request.oldText}"`);
  respond(rpcId, { type: "textReplacedSmart", page: request.page, count: 0, method: "failed" });
}

export function handleSearchText(request: any, respond: Respond, rpcId: number | undefined) {
  const results: TextSearchResult[] = [];
  const pageCount = getDoc().countPages();
  const startPage = request.page !== undefined ? request.page : 0;
  const endPage = request.page !== undefined ? request.page + 1 : pageCount;
  for (let i = startPage; i < endPage; i++) {
    const hits = getDoc().loadPage(i).toStructuredText().search(request.needle);
    for (const quadGroup of hits) results.push({ page: i, quads: quadGroup as unknown as number[][], text: request.needle });
  }
  respond(rpcId, { type: "searchResults", results });
}
