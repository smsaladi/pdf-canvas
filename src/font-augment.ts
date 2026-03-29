// Font augmentation: extract subsetted fonts from PDFs, add missing glyphs
// from metrically compatible reference fonts, write back.
//
// Uses opentype.js for font binary parsing and glyph manipulation.

import opentype from "opentype.js";

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
 * Augment a subsetted font by adding missing glyph outlines from a reference font.
 * Only adds glyphs that don't already exist in the subset — preserving original glyphs.
 *
 * @param subsetBuffer - Raw TTF binary of the subsetted font from the PDF
 * @param referenceBuffer - Raw TTF binary of the full reference font
 * @param missingChars - Array of characters whose glyphs need to be added
 * @returns Augmented TTF binary, or null if augmentation failed
 */
export function augmentFont(
  subsetBuffer: ArrayBuffer,
  referenceBuffer: ArrayBuffer,
  missingChars: string[]
): ArrayBuffer | null {
  try {
    const subset = opentype.parse(subsetBuffer);
    const reference = opentype.parse(referenceBuffer);

    if (!subset || !reference) return null;

    // Collect all existing glyphs from the subset
    const glyphs: opentype.Glyph[] = [];
    const existingUnicodes = new Set<number>();

    for (let i = 0; i < subset.glyphs.length; i++) {
      const g = subset.glyphs.get(i);
      glyphs.push(g);
      if (g.unicode !== undefined && g.unicode !== null) {
        existingUnicodes.add(g.unicode);
      }
    }

    // Scale factor if unitsPerEm differs
    const scaleFactor = subset.unitsPerEm / reference.unitsPerEm;
    let addedCount = 0;

    for (const char of missingChars) {
      const codePoint = char.codePointAt(0);
      if (codePoint === undefined || existingUnicodes.has(codePoint)) continue;

      const refGlyph = reference.charToGlyph(char);
      if (!refGlyph || !refGlyph.path) continue;

      // Scale the glyph path if needed
      let path = refGlyph.path;
      if (Math.abs(scaleFactor - 1) > 0.001) {
        path = new opentype.Path();
        for (const cmd of refGlyph.path.commands) {
          const scaled: any = { type: cmd.type };
          if ("x" in cmd) scaled.x = (cmd as any).x * scaleFactor;
          if ("y" in cmd) scaled.y = (cmd as any).y * scaleFactor;
          if ("x1" in cmd) scaled.x1 = (cmd as any).x1 * scaleFactor;
          if ("y1" in cmd) scaled.y1 = (cmd as any).y1 * scaleFactor;
          if ("x2" in cmd) scaled.x2 = (cmd as any).x2 * scaleFactor;
          if ("y2" in cmd) scaled.y2 = (cmd as any).y2 * scaleFactor;
          path.commands.push(scaled);
        }
      }

      const newGlyph = new opentype.Glyph({
        name: refGlyph.name || `uni${codePoint.toString(16).padStart(4, "0")}`,
        unicode: codePoint,
        advanceWidth: Math.round((refGlyph.advanceWidth || 0) * scaleFactor),
        path,
      });

      glyphs.push(newGlyph);
      existingUnicodes.add(codePoint);
      addedCount++;
    }

    if (addedCount === 0) return null; // Nothing was missing

    // Rebuild font with all glyphs (original + new)
    const augmented = new opentype.Font({
      familyName: subset.names.fontFamily?.en || "AugmentedFont",
      styleName: subset.names.fontSubfamily?.en || "Regular",
      unitsPerEm: subset.unitsPerEm,
      ascender: subset.ascender,
      descender: subset.descender,
      glyphs,
    });

    console.log(`[FontAugment] Added ${addedCount} glyph(s) to font: ${missingChars.join(", ")}`);
    return augmented.toArrayBuffer();
  } catch (err) {
    console.warn("[FontAugment] opentype.js augmentation failed:", err);
    return null;
  }
}
