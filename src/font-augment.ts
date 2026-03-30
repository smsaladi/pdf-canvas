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

// --- Font loading: memory cache → IndexedDB → Google Fonts CDN → local bundle ---

// In-memory cache (instant, lost on reload)
const memoryCache = new Map<string, ArrayBuffer>();

// IndexedDB cache (persists across reloads)
const IDB_NAME = "pdf-canvas-fonts";
const IDB_STORE = "fonts";

function openFontDB(): IDBDatabase | null {
  // Synchronous IDB isn't available in workers, so we use a pre-warmed memory cache
  // The main thread pre-loads from IDB into memory on startup
  return null;
}

/** Save a font to IndexedDB (async, fire-and-forget from worker) */
function saveFontToIDB(key: string, buffer: ArrayBuffer): void {
  try {
    const request = indexedDB.open(IDB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(buffer, key);
      console.log(`[FontCache] Saved to IndexedDB: ${key} (${buffer.byteLength} bytes)`);
    };
  } catch {}
}

/** Load a font from IndexedDB synchronously (for worker use — blocks) */
function loadFontFromIDBSync(key: string): ArrayBuffer | null {
  // Workers can't do sync IDB. We rely on the memory cache being pre-warmed.
  // This is called as a fallback; the main thread should pre-warm via loadAllCachedFonts().
  return null;
}

/** Phase 6 TODO: Pre-warm the memory cache from IndexedDB on app startup */
export async function loadAllCachedFonts(): Promise<void> {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(IDB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(IDB_STORE);
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(IDB_STORE, "readonly");
        const store = tx.objectStore(IDB_STORE);
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) {
            memoryCache.set(cursor.key as string, cursor.value as ArrayBuffer);
            cursor.continue();
          } else {
            console.log(`[FontCache] Pre-warmed ${memoryCache.size} font(s) from IndexedDB`);
            resolve();
          }
        };
        cursorReq.onerror = () => resolve();
      };
      request.onerror = () => resolve();
    } catch { resolve(); }
  });
}

function getGoogleFontsCSSUrl(family: string, bold: boolean, italic: boolean): string {
  const weight = bold ? 700 : 400;
  const ital = italic ? 1 : 0;
  return `https://fonts.googleapis.com/css2?family=${family}:ital,wght@${ital},${weight}`;
}

export function getLocalFontPath(match: FontMatchResult): string {
  const base = match.googleFamily;
  let variant: string;
  if (match.bold && match.italic) variant = "BoldItalic";
  else if (match.bold) variant = "Bold";
  else if (match.italic) variant = "Italic";
  else variant = "Regular";

  if (base === "Arimo") return `/fonts/Arimo-${variant}.ttf`;
  if (base === "Tinos") return `/fonts/Tinos-${match.bold ? "Bold" : "Regular"}.ttf`;
  if (base === "Cousine") return `/fonts/Cousine-${match.bold ? "Bold" : "Regular"}.ttf`;
  return `/fonts/Arimo-${variant}.ttf`;
}

/**
 * Fetch a reference font. Checks: memory cache → Google Fonts CDN → local bundle.
 * Caches to both memory and IndexedDB for persistence.
 */
export function fetchFont(match: FontMatchResult): ArrayBuffer | null {
  const cacheKey = `${match.googleFamily}-${match.bold ? "B" : "R"}${match.italic ? "I" : ""}`;

  // 1. Memory cache (instant)
  if (memoryCache.has(cacheKey)) {
    console.log(`[FontFetch] Memory cache hit: ${cacheKey}`);
    return memoryCache.get(cacheKey)!;
  }

  // 2. Try Google Fonts CDN
  try {
    const cssUrl = getGoogleFontsCSSUrl(match.googleFamily, match.bold, match.italic);
    const cssXhr = new XMLHttpRequest();
    cssXhr.open("GET", cssUrl, false);
    cssXhr.send();

    if (cssXhr.status === 200) {
      const ttfUrl = cssXhr.responseText.match(/url\((https:\/\/[^)]+\.ttf)\)/)?.[1];
      if (ttfUrl) {
        const fontXhr = new XMLHttpRequest();
        fontXhr.open("GET", ttfUrl, false);
        fontXhr.responseType = "arraybuffer";
        fontXhr.send();

        if (fontXhr.status === 200 && fontXhr.response) {
          const buffer = fontXhr.response as ArrayBuffer;
          memoryCache.set(cacheKey, buffer);
          saveFontToIDB(cacheKey, buffer); // persist for next session
          console.log(`[FontFetch] Downloaded from Google Fonts: ${cacheKey} (${buffer.byteLength} bytes)`);
          return buffer;
        }
      }
    }
  } catch (e) {
    console.log(`[FontFetch] Google Fonts unavailable, trying local`);
  }

  // 3. Fallback to local bundled font
  const localPath = getLocalFontPath(match);
  const xhr = new XMLHttpRequest();
  xhr.open("GET", localPath, false);
  xhr.responseType = "arraybuffer";
  xhr.send();

  if (xhr.status === 200 && xhr.response) {
    const buffer = xhr.response as ArrayBuffer;
    memoryCache.set(cacheKey, buffer);
    console.log(`[FontFetch] Loaded local: ${localPath} (${buffer.byteLength} bytes)`);
    return buffer;
  }

  console.warn(`[FontFetch] Failed to load font: ${cacheKey}`);
  return null;
}

// --- Local Font Access API (system fonts) ---

export interface LocalFontInfo {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
}

/**
 * Phase 6 TODO: Query system fonts via the Local Font Access API.
 * Returns null if not supported or user denies permission.
 * Only works in Chromium browsers on the main thread.
 */
export async function queryLocalFonts(): Promise<LocalFontInfo[] | null> {
  try {
    if (!("queryLocalFonts" in self)) return null;
    const fonts = await (self as any).queryLocalFonts();
    const result: LocalFontInfo[] = [];
    for (const font of fonts) {
      result.push({
        family: font.family,
        fullName: font.fullName,
        postscriptName: font.postscriptName,
        style: font.style,
      });
    }
    console.log(`[LocalFonts] Found ${result.length} system fonts`);
    return result;
  } catch (e) {
    console.log(`[LocalFonts] Access denied or not supported`);
    return null;
  }
}

/**
 * Phase 6 TODO: Load a specific system font by postscriptName.
 * Returns the font binary as ArrayBuffer, or null.
 */
export async function loadLocalFont(postscriptName: string): Promise<ArrayBuffer | null> {
  try {
    if (!("queryLocalFonts" in self)) return null;
    const fonts = await (self as any).queryLocalFonts({ postscriptNames: [postscriptName] });
    if (fonts.length === 0) return null;
    const blob = await fonts[0].blob();
    return await blob.arrayBuffer();
  } catch {
    return null;
  }
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
  missingChars: string[],
  /** "new-slots": always create new glyph slots (CID/Type0 fonts).
   *  "overwrite": reuse existing cmap slots but overwrite outlines (WinAnsi subsetted fonts).
   *  false: reuse existing slots, skip if glyph has outlines (non-subsetted fonts). */
  forceMode: boolean | "new-slots" | "overwrite" = false
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

      // Find or create a glyph slot for this character.
      let glyphIndex: number;
      const existingIndex = cmap[codePoint];
      const useNewSlots = forceMode === true || forceMode === "new-slots";
      const overwrite = forceMode === "overwrite";

      if (useNewSlots || existingIndex === undefined || existingIndex === null) {
        // CID fonts or missing cmap entry: create new slot
        glyphIndex = subsetData.glyf.length;
        subsetData.glyf.push({ contours: [], xMin: 0, yMin: 0, xMax: 0, yMax: 0, advanceWidth: 0, leftSideBearing: 0, name: "" } as any);
        cmap[codePoint] = glyphIndex;
        console.log(`[FontAugment] New glyph slot at index ${glyphIndex} for "${char}" (U+${codePoint.toString(16).padStart(4, "0")})`);
      } else if (overwrite) {
        // WinAnsi subsetted: reuse existing cmap slot, overwrite outlines
        glyphIndex = existingIndex;
        console.log(`[FontAugment] Overwriting glyph at index ${glyphIndex} for "${char}" (U+${codePoint.toString(16).padStart(4, "0")})`);
      } else {
        // Non-subsetted: reuse if glyph already has outlines
        const existingGlyph = subsetData.glyf[existingIndex];
        if (existingGlyph?.contours?.length > 0) {
          continue;
        }
        glyphIndex = existingIndex;
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

      // Compute actual bounding box from contour points
      let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
      for (const contour of contours) {
        for (const pt of contour) {
          if (pt.x < xMin) xMin = pt.x;
          if (pt.y < yMin) yMin = pt.y;
          if (pt.x > xMax) xMax = pt.x;
          if (pt.y > yMax) yMax = pt.y;
        }
      }
      if (!isFinite(xMin)) { xMin = 0; yMin = 0; xMax = 0; yMax = 0; }

      const advW = Math.round((refGlyph.advanceWidth || 0) * scale);
      const lsb = xMin; // left side bearing = distance from origin to leftmost contour point

      // Replace the glyph data at the correct index
      subsetData.glyf[glyphIndex] = {
        ...subsetData.glyf[glyphIndex],
        contours,
        advanceWidth: advW,
        leftSideBearing: lsb,
        xMin: Math.round(xMin),
        yMin: Math.round(yMin),
        xMax: Math.round(xMax),
        yMax: Math.round(yMax),
      };

      console.log(`[FontAugment] Injected glyph at index ${glyphIndex} for "${char}" (${contours.length} contours, advW=${advW}, bbox=[${Math.round(xMin)},${Math.round(yMin)},${Math.round(xMax)},${Math.round(yMax)}])`);
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
