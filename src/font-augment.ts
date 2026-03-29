// Font augmentation: extract subsetted fonts from PDFs, add missing glyphs
// from metrically compatible reference fonts, write back.
//
// Uses opentype.js for font binary parsing and glyph manipulation.

import opentype from "opentype.js";
import { Font as FEFont, woff2 } from "fonteditor-core";

// --- Font name parsing ---

export interface ParsedFontName {
  family: string; // e.g., "Arial"
  bold: boolean;
  italic: boolean;
  raw: string; // original PostScript name without subset prefix
}

export function parseFontName(baseFontName: string): ParsedFontName {
  // Strip subset prefix: "ABCDEF+Arial-BoldMT" → "Arial-BoldMT"
  let raw = baseFontName;
  const plusIdx = raw.indexOf("+");
  if (plusIdx >= 0 && plusIdx <= 6) {
    raw = raw.slice(plusIdx + 1);
  }

  // Detect bold/italic from name
  const lowerRaw = raw.toLowerCase();
  const bold = lowerRaw.includes("bold") || lowerRaw.includes("heavy") || lowerRaw.includes("black");
  const italic = lowerRaw.includes("italic") || lowerRaw.includes("oblique");

  // Extract family name: strip common PostScript suffixes first, then style suffixes
  let family = raw
    .replace(/(PSMT|PSM|MT|PS)$/g, "") // Remove PostScript suffixes
    .replace(/[-,](Bold|Italic|BoldItalic|Oblique|BoldOblique|Light|Medium|Semibold|Heavy|Black|Regular|Roman)+$/gi, "") // Remove style suffixes
    .replace(/[-,]$/, ""); // Clean trailing separator

  // Common concatenated names
  const familyMap: Record<string, string> = {
    "TimesNewRoman": "Times New Roman",
    "CourierNew": "Courier New",
    "ComicSans": "Comic Sans",
    "TrebuchetMS": "Trebuchet MS",
    "SegoeUI": "Segoe UI",
    "LucidaConsole": "Lucida Console",
    "LucidaSans": "Lucida Sans",
    "PalatinoLinotype": "Palatino Linotype",
    "BookAntiqua": "Book Antiqua",
    "CenturyGothic": "Century Gothic",
    "FranklinGothic": "Franklin Gothic",
  };

  for (const [concat, spaced] of Object.entries(familyMap)) {
    if (family.toLowerCase().startsWith(concat.toLowerCase())) {
      family = spaced;
      break;
    }
  }

  return { family, bold, italic, raw };
}

// --- Font matching: PostScript name → reference font ---

interface ReferenceFontInfo {
  /** Google Font family name */
  googleFamily: string;
  /** Category for fallback */
  category: "sans" | "serif" | "mono";
}

// Static mapping of ~50 most common PDF font families → Google Font equivalents
const FONT_MATCH_TABLE: Record<string, ReferenceFontInfo> = {
  // Microsoft Core Fonts → Google Croscore (metrically identical)
  "Arial": { googleFamily: "Arimo", category: "sans" },
  "Helvetica": { googleFamily: "Arimo", category: "sans" },
  "HelveticaNeue": { googleFamily: "Arimo", category: "sans" },
  "Helvetica Neue": { googleFamily: "Arimo", category: "sans" },
  "Times New Roman": { googleFamily: "Tinos", category: "serif" },
  "Times": { googleFamily: "Tinos", category: "serif" },
  "TimesRoman": { googleFamily: "Tinos", category: "serif" },
  "Courier New": { googleFamily: "Cousine", category: "mono" },
  "Courier": { googleFamily: "Cousine", category: "mono" },
  "Calibri": { googleFamily: "Carlito", category: "sans" },
  "Cambria": { googleFamily: "Caladea", category: "serif" },

  // Common fonts → reasonable alternatives
  "Verdana": { googleFamily: "Arimo", category: "sans" },
  "Tahoma": { googleFamily: "Arimo", category: "sans" },
  "Segoe UI": { googleFamily: "Arimo", category: "sans" },
  "Trebuchet MS": { googleFamily: "Arimo", category: "sans" },
  "Georgia": { googleFamily: "Tinos", category: "serif" },
  "Palatino Linotype": { googleFamily: "Tinos", category: "serif" },
  "Palatino": { googleFamily: "Tinos", category: "serif" },
  "Book Antiqua": { googleFamily: "Tinos", category: "serif" },
  "Garamond": { googleFamily: "Tinos", category: "serif" },
  "Century Gothic": { googleFamily: "Arimo", category: "sans" },
  "Comic Sans": { googleFamily: "Arimo", category: "sans" },
  "Lucida Console": { googleFamily: "Cousine", category: "mono" },
  "Lucida Sans": { googleFamily: "Arimo", category: "sans" },
  "Franklin Gothic": { googleFamily: "Arimo", category: "sans" },
  "Impact": { googleFamily: "Arimo", category: "sans" },
  "Consolas": { googleFamily: "Cousine", category: "mono" },
  "Monaco": { googleFamily: "Cousine", category: "mono" },
  "Menlo": { googleFamily: "Cousine", category: "mono" },
};

export interface FontMatchResult {
  googleFamily: string;
  category: "sans" | "serif" | "mono";
  bold: boolean;
  italic: boolean;
  confidence: "exact-metric" | "category-fallback" | "user-override";
}

export function matchReferenceFont(
  parsed: ParsedFontName,
  descriptorFlags?: number
): FontMatchResult {
  // Try static table first
  const entry = FONT_MATCH_TABLE[parsed.family];
  if (entry) {
    return {
      googleFamily: entry.googleFamily,
      category: entry.category,
      bold: parsed.bold,
      italic: parsed.italic,
      confidence: "exact-metric",
    };
  }

  // Fall back to FontDescriptor flags
  let category: "sans" | "serif" | "mono" = "sans";
  if (descriptorFlags !== undefined) {
    if (descriptorFlags & 0x01) category = "mono"; // FixedPitch
    else if (descriptorFlags & 0x02) category = "serif"; // Serif
  }

  const fallbacks: Record<string, string> = {
    sans: "Arimo",
    serif: "Tinos",
    mono: "Cousine",
  };

  return {
    googleFamily: fallbacks[category],
    category,
    bold: parsed.bold,
    italic: parsed.italic,
    confidence: "category-fallback",
  };
}

// --- Local font file mapping ---

// Maps Google Font family + style to bundled TTF file path
export function getLocalFontPath(match: FontMatchResult): string {
  const base = match.googleFamily;
  if (base === "Arimo") {
    return `/fonts/Arimo-Regular.ttf`; // Variable font — covers all weights
  }
  if (base === "Tinos") {
    return match.bold ? `/fonts/Tinos-Bold.ttf` : `/fonts/Tinos-Regular.ttf`;
  }
  if (base === "Cousine") {
    return `/fonts/Cousine-Regular.ttf`;
  }
  // Default fallback
  return `/fonts/Arimo-Regular.ttf`;
}

// --- Font augmentation with opentype.js ---

/**
 * Augment a subsetted font by injecting missing glyph outlines from a reference font.
 * Uses fonteditor-core to modify the font IN-PLACE, preserving the original TrueType
 * format (glyf table structure) so MuPDF can read it correctly.
 *
 * opentype.js is used only to extract glyph outlines from the reference font.
 * fonteditor-core handles the actual font binary modification.
 */
export function augmentFont(
  subsetBuffer: ArrayBuffer,
  referenceBuffer: ArrayBuffer,
  missingChars: string[]
): ArrayBuffer | null {
  try {
    // Parse the subset font with fonteditor-core (preserves TrueType format)
    // fonteditor-core needs a real ArrayBuffer, not a view or SharedArrayBuffer
    const cleanBuffer = subsetBuffer instanceof ArrayBuffer ? subsetBuffer : new Uint8Array(subsetBuffer).buffer;
    const subsetFont = FEFont.create(cleanBuffer as any, { type: "ttf" });
    const subsetData = subsetFont.get();

    if (!subsetData || !subsetData.glyf) {
      console.warn("[FontAugment] Could not parse subset font with fonteditor-core");
      return null;
    }

    console.log(`[FontAugment] fonteditor-core parsed subset: ${subsetData.glyf.length} glyphs, unitsPerEm=${subsetData.head?.unitsPerEm}`);

    // Parse the reference font with opentype.js (good at extracting glyph paths)
    const reference = opentype.parse(referenceBuffer);
    if (!reference) {
      console.warn("[FontAugment] Could not parse reference font with opentype.js");
      return null;
    }

    const subsetUPM = subsetData.head?.unitsPerEm || 2048;
    const refUPM = reference.unitsPerEm;
    const scale = subsetUPM / refUPM;

    // Build a map: unicode → glyph index in the subset font
    const cmap = subsetData.cmap || {};
    let addedCount = 0;

    for (const char of missingChars) {
      const codePoint = char.codePointAt(0);
      if (codePoint === undefined) continue;

      // Find the glyph index for this codepoint in the subset
      const glyphIndex = cmap[codePoint];
      if (glyphIndex === undefined || glyphIndex === null) {
        console.log(`[FontAugment] No cmap entry for "${char}" (U+${codePoint.toString(16).padStart(4, "0")}) — cannot inject`);
        continue;
      }

      // Check if the glyph at this index is empty
      const existingGlyph = subsetData.glyf[glyphIndex];
      if (existingGlyph && existingGlyph.contours && existingGlyph.contours.length > 0) {
        // Already has outlines — skip
        continue;
      }

      // Get the glyph from the reference font
      const refGlyph = reference.charToGlyph(char);
      if (!refGlyph || !refGlyph.path || refGlyph.path.commands.length === 0) {
        console.warn(`[FontAugment] Reference font has no outline for "${char}"`);
        continue;
      }

      // Convert opentype.js path commands to fonteditor-core contour format
      // fonteditor-core uses contours: Array<Array<{x, y, onCurve}>>
      const contours: Array<Array<{ x: number; y: number; onCurve: boolean }>> = [];
      let currentContour: Array<{ x: number; y: number; onCurve: boolean }> = [];

      for (const cmd of refGlyph.path.commands) {
        switch (cmd.type) {
          case "M":
            if (currentContour.length > 0) contours.push(currentContour);
            currentContour = [{ x: Math.round((cmd as any).x * scale), y: Math.round((cmd as any).y * scale), onCurve: true }];
            break;
          case "L":
            currentContour.push({ x: Math.round((cmd as any).x * scale), y: Math.round((cmd as any).y * scale), onCurve: true });
            break;
          case "Q":
            // Quadratic bezier: control point (off-curve) then end point (on-curve)
            currentContour.push({ x: Math.round((cmd as any).x1 * scale), y: Math.round((cmd as any).y1 * scale), onCurve: false });
            currentContour.push({ x: Math.round((cmd as any).x * scale), y: Math.round((cmd as any).y * scale), onCurve: true });
            break;
          case "C":
            // Cubic bezier: two control points then end point
            // TrueType only supports quadratic — approximate by using control points as off-curve
            currentContour.push({ x: Math.round((cmd as any).x1 * scale), y: Math.round((cmd as any).y1 * scale), onCurve: false });
            currentContour.push({ x: Math.round((cmd as any).x2 * scale), y: Math.round((cmd as any).y2 * scale), onCurve: false });
            currentContour.push({ x: Math.round((cmd as any).x * scale), y: Math.round((cmd as any).y * scale), onCurve: true });
            break;
          case "Z":
            if (currentContour.length > 0) contours.push(currentContour);
            currentContour = [];
            break;
        }
      }
      if (currentContour.length > 0) contours.push(currentContour);

      // Replace the glyph data at the correct index
      subsetData.glyf[glyphIndex] = {
        ...existingGlyph,
        contours,
        advanceWidth: Math.round((refGlyph.advanceWidth || 0) * scale),
        leftSideBearing: 0,
        xMin: 0,
        yMin: 0,
        xMax: Math.round((refGlyph.advanceWidth || 0) * scale),
        yMax: subsetUPM,
      };

      console.log(`[FontAugment] Injected glyph at index ${glyphIndex} for "${char}" (${contours.length} contours, ${contours.reduce((s, c) => s + c.length, 0)} points)`);
      addedCount++;
    }

    if (addedCount === 0) {
      console.log(`[FontAugment] No glyphs needed injection`);
      return null;
    }

    // Write the modified font back as TTF (preserves original format!)
    subsetFont.set(subsetData);
    const outputBuffer = subsetFont.write({ type: "ttf" });

    console.log(`[FontAugment] Wrote augmented TTF: ${outputBuffer.byteLength} bytes, injected ${addedCount} glyph(s)`);
    return outputBuffer;
  } catch (err) {
    console.warn("[FontAugment] Font augmentation failed:", err);
    return null;
  }
}
